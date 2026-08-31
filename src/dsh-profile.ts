import { lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { HostError } from "./errors.js";
import { DSH_COMMIT, DSH_VERSION } from "./dsh-pin.js";
import { sha256 } from "./ids.js";
import type { HostConfig } from "./types.js";

const PROFILE_MANIFEST = `${JSON.stringify({
  name: "dsh-profile-kai-work-host",
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
}, null, 2)}\n`;

const KAI_SDK_CONTROL_PACKAGE = `${JSON.stringify({
  name: "@kai/dsh-sdk-jsonrpc-server",
  version: "0.1.0",
  private: true,
  type: "module",
  exports: "./index.js",
}, null, 2)}\n`;

// This is a profile overlay, not a second Harness. DSH keeps ownership of the
// AgentLoop, session log, tools, sandbox and model adapter; KAI only selects a
// deliberately narrow remote-worker composition.
export const KAI_DSH_PROFILE_PATCH = `# Managed by KAI Work Host. Local edits are replaced at startup.
- insert:
    - id: sdk-jsonrpc-server
      name: '@kai/dsh-sdk-jsonrpc-server'
      config:
        maxTokensAsSuccess: false

- id: hmr
  disabled: true

- id: session-title-llm
  disabled: true

- id: agent-default-model
  config:
    provider: openai-codex
    model: !!js process.env.KAI_DSH_WORKER_MODEL ?? 'gpt-5.6-luna'

- id: llm-pi-ai
  config:
    providers:
      openai-codex:
        reasoning: !!js process.env.KAI_DSH_WORKER_EFFORT ?? 'high'
        retryPolicy:
          mode: normal
          maxRetries: 2

- id: llm-deepseek
  disabled: true

- id: session-query-sqlite
  disabled: true

- id: session-telemetry-otel
  disabled: true

- id: jobs
  disabled: true

- id: user-questions
  disabled: true

- id: sandbox-policy
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'read-only'
    workspaceRoot: !!js process.cwd()

# The project registry and task request are the approval boundary. The DSH
# sandbox still enforces the selected file policy; this runtime has no second
# interactive approval channel that could safely pause a JSON-RPC turn.
- id: approval
  config:
    policy: never

- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: never
      workspace-write:
        sandbox: workspace-write
        approval: never
      danger-full-access:
        sandbox: danger-full-access
        approval: never
    defaultPreset: !!js process.env.DSH_PERMISSION_MODE ?? 'read-only'

- id: tool-jobs
  disabled: true

- id: agent-instructions
  config:
    maxBytes: 32768

- id: skill
  disabled: true

- id: skill-filesystem
  disabled: true

- id: tool-skill
  disabled: true

- id: commands
  disabled: true

- id: command-feedback
  disabled: true

- id: goal
  disabled: true

- id: goal-round-driver
  disabled: true

- id: command-goal
  disabled: true

- id: plan-mode
  disabled: true

- id: command-compact
  disabled: true

- id: subagent
  disabled: true

- id: subagent-spawn-in-process
  disabled: true

- id: subagent-fork-in-process
  disabled: true

- id: tool-subagent-control
  disabled: true

- id: tool-subagent-list-agents
  disabled: true

- id: tool-subagent
  disabled: true

- id: tool-subagent-fork
  disabled: true

- id: tool-subagent-report
  disabled: true

- id: workflow-worker-thread
  disabled: true

- id: tool-workflow
  disabled: true

- id: tool-goal
  disabled: true

- id: tool-ralph
  disabled: true

- id: web
  disabled: true

- id: web-search-deepseek
  disabled: true

- id: tool-web
  disabled: true

- id: tool-todo
  config:
    allowParallelInProgress: false

- id: repeat-tool-reminder
  config:
    thresholds: [3, 5, 8]
    argumentsPreviewChars: 320

- id: tool-result-pruner
  config:
    thresholdChars: 8192
    headChars: 4096
    tailChars: 1024

- id: compaction-basic
  config:
    thresholdRatio: 0.72
    retainRatio: 0.08
    maxTokens: 6144
    compactionRetries: 1

- id: system-prompt
  config:
    persona: |
      You are Luna, the local execution worker inside KAI Work Host.
      WebGPT Sol is the sole high-level planner and decision authority. Execute the supplied goal, acceptance criteria, and constraints without replacing them with a new strategy.
      Work only inside the registered project and obey the active file policy. Inspect before editing, keep changes minimal, run proportionate validation, and report exact evidence.
      Do not spawn agents, browse the web, control a browser, deploy, publish, push, send messages, install system services, change external systems, or reveal secrets. If one is required, stop and report the exact boundary.
      Do not make network requests when the task context says network=false. The file sandbox does not claim to be an operating-system network sandbox.
      Keep progress and the final response concise. Finish with changed files, behavioral impact, validation, and unresolved risks.

- id: agent-loop
  config:
    agents: []
`;

export interface DshProfileStatus {
  ready: boolean;
  dshVersion: string;
  dshCommit: string;
  profileDir: string;
  profileHash: string;
  credentialConfigured: boolean;
  credentialKind: "grant" | "api-key" | null;
}

export class DshProfileManager {
  readonly profileDir: string;

  constructor(private readonly config: HostConfig) {
    this.profileDir = path.join(config.dshHome, "profiles", config.dshProfile);
  }

  async prepare(): Promise<DshProfileStatus> {
    await this.assertInstallation();
    await mkdir(this.profileDir, { recursive: true });
    const sdkControlSource = this.sdkControlPluginSource();
    await Promise.all([
      writeIfChanged(path.join(this.profileDir, "package.json"), PROFILE_MANIFEST),
      writeIfChanged(path.join(this.profileDir, "cordis.patch.yml"), KAI_DSH_PROFILE_PATCH),
      writeIfChanged(
        path.join(this.profileDir, "pnpm-workspace.yaml"),
        "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
      ),
    ]);
    await this.ensureSdkPluginLink();
    await this.ensureKaiSdkControlPlugin(sdkControlSource);
    return this.status();
  }

  async status(): Promise<DshProfileStatus> {
    const credentials = await this.credentialStatus();
    const identity = await this.installationIdentity();
    const ready = await Promise.all([
      isFile(this.config.dshCliPath),
      isFile(path.join(this.config.dshSdkPluginRoot, "package.json")),
      isFile(path.join(this.profileDir, "package.json")),
      isFile(path.join(this.profileDir, "cordis.patch.yml")),
      isFile(path.join(this.profileDir, "node_modules", "@kai", "dsh-sdk-jsonrpc-server", "package.json")),
      isFile(path.join(this.profileDir, "node_modules", "@kai", "dsh-sdk-jsonrpc-server", "index.js")),
    ]).then((values) => values.every(Boolean));
    return {
      ready,
      dshVersion: identity.version,
      dshCommit: identity.commit,
      profileDir: this.profileDir,
      profileHash: sha256(`${KAI_DSH_PROFILE_PATCH}\n${this.sdkControlPluginSource()}`),
      credentialConfigured: credentials.configured,
      credentialKind: credentials.kind,
    };
  }

  private async assertInstallation(): Promise<void> {
    const required = [
      this.config.dshCliPath,
      path.join(this.config.dshSdkPluginRoot, "package.json"),
      path.join(this.config.dshSdkPluginRoot, "lib", "index.js"),
      path.join(path.dirname(this.config.dshSdkPluginRoot), "protocol", "lib", "index.js"),
    ];
    for (const candidate of required) {
      if (!await isFile(candidate)) {
        throw new HostError(
          "dsh_installation_incomplete",
          `KAI Work Host requires the pinned, built DSH file: ${candidate}`,
        );
      }
    }
    const identity = await this.installationIdentity();
    if (identity.version !== DSH_VERSION || identity.commit !== DSH_COMMIT) {
      throw new HostError(
        "dsh_identity_mismatch",
        `KAI Work Host is pinned to DSH ${DSH_VERSION} at ${DSH_COMMIT}; found ${identity.version} at ${identity.commit}`,
      );
    }
  }

  private async installationIdentity(): Promise<{ version: string; commit: string }> {
    const manifest = JSON.parse(
      await readFile(path.join(this.config.dshRoot, "package.json"), "utf8"),
    ) as { version?: unknown };
    const version = typeof manifest.version === "string" ? manifest.version : "unknown";
    const head = (await readFile(path.join(this.config.dshRoot, ".git", "HEAD"), "utf8")).trim();
    const commit = head.startsWith("ref: ")
      ? (await readFile(path.join(this.config.dshRoot, ".git", head.slice(5)), "utf8")).trim()
      : head;
    return { version, commit };
  }

  private async ensureSdkPluginLink(): Promise<void> {
    const link = path.join(
      this.profileDir,
      "node_modules",
      "@deepseek-ai",
      "dsh-sdk-jsonrpc-server",
    );
    await mkdir(path.dirname(link), { recursive: true });
    const metadata = await lstat(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (metadata !== null) {
      if (!metadata.isSymbolicLink()) {
        throw new HostError(
          "dsh_profile_link_conflict",
          `Managed SDK plugin path exists and is not a link: ${link}`,
        );
      }
      const current = path.resolve(path.dirname(link), await readlink(link));
      if (samePath(current, this.config.dshSdkPluginRoot)) return;
      await unlink(link);
    }
    await symlink(
      this.config.dshSdkPluginRoot,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
  }

  private async ensureKaiSdkControlPlugin(source: string): Promise<void> {
    const pluginRoot = path.join(
      this.profileDir,
      "node_modules",
      "@kai",
      "dsh-sdk-jsonrpc-server",
    );
    const metadata = await lstat(pluginRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (metadata !== null && !metadata.isDirectory()) {
      throw new HostError(
        "dsh_profile_control_plugin_conflict",
        `Managed KAI SDK control plugin path exists and is not a directory: ${pluginRoot}`,
      );
    }
    await mkdir(pluginRoot, { recursive: true });
    await Promise.all([
      writeIfChanged(path.join(pluginRoot, "package.json"), KAI_SDK_CONTROL_PACKAGE),
      writeIfChanged(path.join(pluginRoot, "index.js"), source),
    ]);
  }

  private sdkControlPluginSource(): string {
    const serverModule = JSON.stringify(pathToFileURL(
      path.join(this.config.dshSdkPluginRoot, "lib", "index.js"),
    ).href);
    const protocolModule = JSON.stringify(pathToFileURL(
      path.join(path.dirname(this.config.dshSdkPluginRoot), "protocol", "lib", "index.js"),
    ).href);
    return [
      `import { Config, HarnessSdkJsonRpcServer } from ${serverModule};`,
      `import { JsonRpcLineTransport } from ${protocolModule};`,
      "import { resolve as resolvePath } from 'node:path';",
      "",
      "export { Config };",
      "export const name = 'sdk-jsonrpc-server';",
      "export const inject = ['agents', 'permissionPresets', 'sessions', 'sessionPersistence'];",
      "",
      "const PERMISSION_METHOD = 'session/set-permission';",
      "const PERMISSION_PROFILES = new Set(['read-only', 'workspace-write', 'danger-full-access']);",
      "",
      "function parsePermissionRequest(params) {",
      "  if (params === null || typeof params !== 'object' || Array.isArray(params)) {",
      "    throw new TypeError('session/set-permission params must be an object');",
      "  }",
      "  const sessionId = params.sessionId;",
      "  const permissionProfile = params.permissionProfile;",
      "  if (typeof sessionId !== 'string' || sessionId.length === 0) {",
      "    throw new TypeError('session/set-permission requires a non-empty sessionId');",
      "  }",
      "  if (typeof permissionProfile !== 'string' || !PERMISSION_PROFILES.has(permissionProfile)) {",
      "    throw new TypeError('session/set-permission received an unsupported permissionProfile');",
      "  }",
      "  return { sessionId, permissionProfile };",
      "}",
      "",
      "class KaiHarnessSdkJsonRpcServer extends HarnessSdkJsonRpcServer {",
      "  constructor(ctx, transport, options) {",
      "    super(ctx, transport, options);",
      "    this.kaiCtx = ctx;",
      "    this.kaiAgentOptions = null;",
      "    this.kaiCwd = null;",
      "  }",
      "",
      "  async initialize(params) {",
      "    const result = await super.initialize(params);",
      "    this.kaiAgentOptions = {",
      "      provider: params.provider,",
      "      model: params.model,",
      "      ...(params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens }),",
      "    };",
      "    this.kaiCwd = resolvePath(params.cwd);",
      "    return result;",
      "  }",
      "",
      "  async createSession(sessionId) {",
      "    const persisted = await this.kaiCtx.sessionPersistence.list();",
      "    const header = persisted.find((candidate) => String(candidate.id) === sessionId);",
      "    if (header === undefined) {",
      "      return super.createSession(sessionId);",
      "    }",
      "    if (this.kaiAgentOptions === null || this.kaiCwd === null) {",
      "      throw new Error('cannot resume a durable session before initialize');",
      "    }",
      "    const persistedCwd = typeof header.cwd === 'string' ? resolvePath(header.cwd) : null;",
      "    const sameCwd = persistedCwd !== null && (process.platform === 'win32'",
      "      ? persistedCwd.toLowerCase() === this.kaiCwd.toLowerCase()",
      "      : persistedCwd === this.kaiCwd);",
      "    if (!sameCwd) {",
      "      throw new Error('durable session workspace mismatch for ' + sessionId + ': expected ' + this.kaiCwd + ', found ' + String(persistedCwd));",
      "    }",
      "    const handle = await this.kaiCtx.agents.resume({",
      "      resumeSessionId: sessionId,",
      "      agentOptions: this.kaiAgentOptions,",
      "    });",
      "    const record = { handle };",
      "    this.sessions.set(sessionId, record);",
      "    return record;",
      "  }",
      "",
      "  async setSessionPermission(params) {",
      "    const { sessionId, permissionProfile } = parsePermissionRequest(params);",
      "    const record = await this.getOrCreateSession(sessionId);",
      "    const session = record.handle.agent.session;",
      "    const before = this.kaiCtx.permissionPresets.current(session.events);",
      "    this.kaiCtx.permissionPresets.set(session, permissionProfile);",
      "    await this.kaiCtx.sessions.flush(session);",
      "    const effective = this.kaiCtx.permissionPresets.current(session.events);",
      "    if (effective !== permissionProfile) {",
      "      throw new Error('DSH session permission read-back mismatch: requested ' + permissionProfile + ', got ' + effective);",
      "    }",
      "    return { sessionId, permissionProfile: effective, changed: before !== effective, durable: true };",
      "  }",
      "}",
      "",
      "export function apply(ctx, config) {",
      "  const resolvedConfig = config;",
      "  const rootFiber = ctx.root.fiber;",
      "  const input = config.input ?? process.stdin;",
      "  const output = config.output ?? process.stdout;",
      "  const exit = config.exit ?? ((code) => { process.exit(code); });",
      "  const transport = new JsonRpcLineTransport(input, output);",
      "  const server = new KaiHarnessSdkJsonRpcServer(ctx, transport, {",
      "    maxTokensAsSuccess: resolvedConfig.maxTokensAsSuccess,",
      "  });",
      "  let exitTask;",
      "  const disposeAndExit = () => {",
      "    exitTask ??= (async () => {",
      "      await Promise.allSettled([Promise.resolve().then(() => transport.flush())]);",
      "      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())]);",
      "      exit(0);",
      "    })();",
      "    return exitTask;",
      "  };",
      "  transport.onRequest(async (method, params) => {",
      "    if (method === 'initialize') await ctx.get('loader')?.await();",
      "    const result = method === PERMISSION_METHOD",
      "      ? await server.setSessionPermission(params)",
      "      : await server.handleRequest(method, params);",
      "    if (method === 'shutdown') setImmediate(() => { void disposeAndExit(); });",
      "    return result;",
      "  });",
      "  ctx.effect(() => {",
      "    transport.start();",
      "    return async () => {",
      "      await server.shutdown();",
      "      transport.close();",
      "    };",
      "  }, 'jsonrpc.serve');",
      "}",
      "",
    ].join("\n");
  }

  private async credentialStatus(): Promise<{
    configured: boolean;
    kind: "grant" | "api-key" | null;
  }> {
    const file = path.join(this.config.dshHome, ".credentials.yaml");
    const raw = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const lines = raw.split(/\r?\n/u);
    const index = lines.findIndex((line) => /^\s{2}["']?llm-pi-ai\/openai-codex["']?:\s*$/u.test(line));
    if (index < 0) return { configured: false, kind: null };
    const nearby = lines.slice(index + 1, index + 8).join("\n");
    if (/^\s{4}kind:\s*grant\s*$/mu.test(nearby)) return { configured: true, kind: "grant" };
    if (/^\s{4}kind:\s*api-key\s*$/mu.test(nearby)) return { configured: true, kind: "api-key" };
    return { configured: false, kind: null };
  }
}

async function isFile(candidate: string): Promise<boolean> {
  const metadata = await lstat(candidate).catch(() => null);
  return metadata?.isFile() === true;
}

async function writeIfChanged(file: string, content: string): Promise<void> {
  const current = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current === content) return;
  await writeFile(file, content, "utf8");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.localeCompare(path.resolve(right), undefined, { sensitivity: "accent" }) === 0
    : left === path.resolve(right);
}
