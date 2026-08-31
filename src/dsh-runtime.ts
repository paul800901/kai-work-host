import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { DshProfileManager, type DshProfileStatus } from "./dsh-profile.js";
import { terminateOwnedProcessTree } from "./compat/process-tree.js";
import { HostError } from "./errors.js";
import type {
  HostConfig,
  PermissionProfile,
  RuntimeEffort,
  RunUsageSummary,
  TokenUsageBreakdown,
  UsageDiagnostics,
} from "./types.js";

export interface RuntimeEventSummary {
  type: string;
  sequence: number | null;
  at: string;
  data: Record<string, unknown>;
}

export interface WorkerRunRequest {
  taskId: string;
  sessionId: string;
  model: string;
  effort: RuntimeEffort;
  fast: boolean;
  cwd: string;
  permissionProfile: PermissionProfile;
  networkAccess: boolean;
  timeoutMs: number;
  prompt: string;
  onEvent: (event: RuntimeEventSummary) => Promise<void>;
}

export interface WorkerRunResult {
  messageId: string;
  status: "completed" | "failed" | "interrupted";
  reason: Record<string, unknown> | null;
  finalMessage: string | null;
  error: string | null;
  usage: RunUsageSummary;
  eventSummaries: RuntimeEventSummary[];
  validation: string[];
  diffText: string | null;
}

export interface WorkerRuntimeStatus {
  engine: "dsh-sdk-jsonrpc";
  profile: DshProfileStatus;
  provider: string;
  model: string;
  effort: string;
  activeTaskProcesses: number;
  codexProductRuntimeUsed: false;
  networkIsolation: "model-policy-only";
}

export interface WorkerRuntimeControl {
  prepare(): Promise<void>;
  status(): Promise<WorkerRuntimeStatus>;
  runTurn(request: WorkerRunRequest): Promise<WorkerRunResult>;
  interrupt(taskId: string): Promise<boolean>;
  probe(cwd?: string): Promise<Record<string, unknown>>;
  shutdown(): Promise<void>;
}

export interface RuntimeWorkerActivity {
  isAlive(): boolean;
  hasActiveRun(): boolean;
}

/** Count turns in flight, not idle named-session worker processes. */
export function countActiveTaskProcesses(workers: Iterable<RuntimeWorkerActivity>): number {
  let count = 0;
  for (const worker of workers) if (worker.isAlive() && worker.hasActiveRun()) count += 1;
  return count;
}

export interface RuntimeUsageObservation {
  incremental: TokenUsageBreakdown;
  providerCumulative: TokenUsageBreakdown | null;
  accounting: UsageDiagnostics["accounting"];
  counted: boolean;
}

/** Account one runtime usage event without adding a cumulative snapshot twice. */
export function accountRuntimeUsage(
  priorProviderCumulative: TokenUsageBreakdown | null,
  raw: Record<string, unknown>,
): RuntimeUsageObservation {
  const snapshot = explicitCumulativeUsage(raw);
  if (snapshot !== null) {
    const reset = priorProviderCumulative !== null && cumulativeReset(snapshot, priorProviderCumulative);
    return {
      incremental: reset ? snapshot : subtractUsage(snapshot, priorProviderCumulative ?? EMPTY_USAGE),
      providerCumulative: snapshot,
      accounting: "provider-cumulative-delta",
      counted: true,
    };
  }
  return {
    incremental: hasUsageFields(raw) ? usageBreakdown(raw) : { ...EMPTY_USAGE },
    providerCumulative: null,
    accounting: "per-event-incremental",
    counted: hasUsageFields(raw),
  };
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ActiveRun {
  sessionId: string;
  messageId: string | null;
  seenRunning: boolean;
  seenIdleAfterWork: boolean;
  turnEnd: Record<string, unknown> | null;
  finalMessage: string | null;
  usage: TokenUsageBreakdown;
  providerCumulative: TokenUsageBreakdown | null;
  usageAccounting: UsageDiagnostics["accounting"];
  usageEventCount: number;
  promptCharacterCount: number;
  toolCallCount: number;
  toolResultCount: number;
  contextWindow: number | null;
  eventSummaries: RuntimeEventSummary[];
  validation: string[];
  diffs: string[];
  toolNames: Map<string, string>;
  callbackQueue: Promise<void>;
  onEvent: (event: RuntimeEventSummary) => Promise<void>;
  resolve: (value: WorkerRunResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

const EMPTY_USAGE: TokenUsageBreakdown = {
  inputTokens: 0,
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

export class DshRuntimeManager implements WorkerRuntimeControl {
  private readonly profile: DshProfileManager;
  private readonly workers = new Map<string, DshSdkProcess>();
  private prepared = false;

  constructor(private readonly config: HostConfig) {
    this.profile = new DshProfileManager(config);
  }

  async prepare(): Promise<void> {
    if (this.prepared) return;
    await mkdir(this.config.dshHome, { recursive: true });
    await this.profile.prepare();
    this.prepared = true;
  }

  async status(): Promise<WorkerRuntimeStatus> {
    await this.prepare();
    for (const [taskId, worker] of this.workers) {
      if (!worker.isAlive()) this.workers.delete(taskId);
    }
    return {
      engine: "dsh-sdk-jsonrpc",
      profile: await this.profile.status(),
      provider: this.config.dshProvider,
      model: this.config.workerModel,
      effort: this.config.workerEffort,
      activeTaskProcesses: countActiveTaskProcesses(this.workers.values()),
      codexProductRuntimeUsed: false,
      networkIsolation: "model-policy-only",
    };
  }

  async runTurn(request: WorkerRunRequest): Promise<WorkerRunResult> {
    await this.prepare();
    const profileStatus = await this.profile.status();
    if (!profileStatus.credentialConfigured || profileStatus.credentialKind !== "grant") {
      throw new HostError(
        "luna_oauth_not_configured",
        `The isolated DSH home has no openai-codex OAuth grant: ${this.config.dshHome}. Run the one-time KAI Work Host sign-in before a paid Luna turn.`,
      );
    }
    let worker = this.workers.get(request.taskId);
    if (worker !== undefined && !worker.isAlive()) {
      this.workers.delete(request.taskId);
      worker = undefined;
    }
    if (worker !== undefined && !worker.matchesRuntime(request)) {
      if (worker.hasActiveRun()) {
        throw new HostError(
          "runtime_binding_busy",
          `Task ${request.taskId} already has an active Luna worker with different runtime settings`,
        );
      }
      await worker.shutdown();
      if (this.workers.get(request.taskId) === worker) this.workers.delete(request.taskId);
      worker = undefined;
    }
    if (worker === undefined) {
      worker = this.createWorker(
        request.taskId,
        request.cwd,
        request.permissionProfile,
        request.model,
        request.effort,
      );
      this.workers.set(request.taskId, worker);
    }
    try {
      return await worker.run(request);
    } finally {
      if (!worker.isAlive() && this.workers.get(request.taskId) === worker) {
        this.workers.delete(request.taskId);
      }
    }
  }

  async interrupt(taskId: string): Promise<boolean> {
    const worker = this.workers.get(taskId);
    if (worker === undefined) return false;
    const interrupted = await worker.interrupt();
    if (!worker.isAlive()) this.workers.delete(taskId);
    return interrupted;
  }

  async probe(cwd = this.config.stateRoot): Promise<Record<string, unknown>> {
    await this.prepare();
    await mkdir(cwd, { recursive: true });
    const sessionId = `kai-keyless-permission-probe-${randomUUID()}`;
    const worker = this.createWorker(
      "probe",
      cwd,
      "read-only",
      this.config.workerModel,
      this.config.workerEffort,
    );
    let serverInfo: Record<string, unknown>;
    let liveUpgrade: Record<string, unknown>;
    let liveDowngrade: Record<string, unknown>;
    let persistedUpgrade: Record<string, unknown>;
    try {
      serverInfo = await worker.start();
      liveUpgrade = await worker.prepareSessionPermission(sessionId, "workspace-write");
      liveDowngrade = await worker.prepareSessionPermission(sessionId, "read-only");
      persistedUpgrade = await worker.prepareSessionPermission(sessionId, "workspace-write");
    } finally {
      await worker.shutdown();
    }

    const resumedWorker = this.createWorker(
      "probe-resume",
      cwd,
      "read-only",
      this.config.workerModel,
      this.config.workerEffort,
    );
    let restartDowngrade: Record<string, unknown>;
    try {
      await resumedWorker.start();
      restartDowngrade = await resumedWorker.prepareSessionPermission(sessionId, "read-only");
    } finally {
      await resumedWorker.shutdown();
    }
    for (const [stage, result, expected] of [
      ["live-upgrade", liveUpgrade, "workspace-write"],
      ["live-downgrade", liveDowngrade, "read-only"],
      ["persisted-upgrade", persistedUpgrade, "workspace-write"],
      ["restart-downgrade", restartDowngrade, "read-only"],
    ] as const) {
      if (result.permissionProfile !== expected || result.durable !== true || result.changed !== true) {
        throw new HostError(
          "runtime_permission_probe_failed",
          `Keyless permission probe ${stage} did not durably switch to ${expected}`,
        );
      }
    }
    return {
      ok: true,
      serverInfo,
      provider: this.config.dshProvider,
      model: this.config.workerModel,
      permissionControl: {
        sessionId,
        liveUpgrade,
        liveDowngrade,
        persistedUpgrade,
        restartDowngrade,
      },
      paidModelInvoked: false,
    };
  }

  async shutdown(): Promise<void> {
    const workers = [...this.workers.values()];
    this.workers.clear();
    const results = await Promise.allSettled(workers.map((worker) => worker.shutdown()));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed !== undefined) throw failed.reason;
  }

  private createWorker(
    taskId: string,
    cwd: string,
    permissionProfile: PermissionProfile,
    model: string,
    effort: RuntimeEffort,
  ): DshSdkProcess {
    return new DshSdkProcess(this.config, taskId, cwd, permissionProfile, model, effort);
  }
}

class DshSdkProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 1;
  private stderrTail = "";
  private active: ActiveRun | null = null;
  private providerCumulative: TokenUsageBreakdown | null = null;
  private serverInfo: Record<string, unknown> | null = null;
  private interrupted = false;

  constructor(
    private readonly config: HostConfig,
    private readonly taskId: string,
    private readonly cwd: string,
    private permissionProfile: PermissionProfile,
    private readonly model: string,
    private readonly effort: RuntimeEffort,
  ) {}

  isAlive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  hasActiveRun(): boolean {
    return this.active !== null && !this.active.settled;
  }

  matchesRuntime(request: Pick<WorkerRunRequest, "cwd" | "model" | "effort">): boolean {
    return samePath(this.cwd, request.cwd) &&
      this.model === request.model &&
      this.effort === request.effort;
  }

  async start(): Promise<Record<string, unknown>> {
    if (this.serverInfo !== null && this.isAlive()) return this.serverInfo;
    if (this.child !== null) throw new HostError("runtime_not_restartable", "A closed DSH worker cannot be restarted");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: this.config.dshHome,
      DSH_PERMISSION_MODE: this.permissionProfile,
      DSH_TELEMETRY_DISABLED: "1",
      KAI_DSH_WORKER_MODEL: this.model,
      KAI_DSH_WORKER_EFFORT: this.effort,
    };
    // The worker must use its own DSH OAuth grant, never Codex App state or an
    // API key inherited from whichever terminal launched the Host.
    delete env.CODEX_HOME;
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_ORG_ID;
    delete env.OPENAI_PROJECT_ID;

    const child = spawn(
      process.execPath,
      [this.config.dshCliPath, "--profile", this.config.dshProfile],
      {
        cwd: this.cwd,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-32_000);
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    child.once("error", (error) => this.handleExit(null, null, error));
    child.once("exit", (code, signal) => this.handleExit(code, signal, null));

    const initialized = asRecord(await this.request(
      "initialize",
      {
        cwd: this.cwd,
        provider: this.config.dshProvider,
        model: this.model,
        ...(this.config.workerMaxOutputTokens === null
          ? {}
          : { maxTokens: this.config.workerMaxOutputTokens }),
      },
      this.config.runtimeStartupTimeoutMs,
    ));
    const serverInfo = asRecord(initialized.serverInfo);
    if (serverInfo.name !== "deepseek-harness-sdk-runtime") {
      await this.shutdown();
      throw new HostError(
        "runtime_identity_invalid",
        `Unexpected DSH SDK runtime identity: ${String(serverInfo.name ?? "missing")}`,
      );
    }
    this.serverInfo = serverInfo;
    return serverInfo;
  }

  async run(request: WorkerRunRequest): Promise<WorkerRunResult> {
    await this.start();
    if (request.taskId !== this.taskId) {
      throw new HostError("runtime_task_mismatch", `Worker ${this.taskId} cannot run ${request.taskId}`);
    }
    if (this.active !== null) {
      throw new HostError("runtime_busy", `Task ${request.taskId} already has an active Luna turn`);
    }
    await this.applySessionPermission(request.sessionId, request.permissionProfile);

    let resolveRun!: (value: WorkerRunResult) => void;
    let rejectRun!: (error: Error) => void;
    const result = new Promise<WorkerRunResult>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    // A process can exit while session/prompt is still awaiting its admission
    // response. Attach a handler now so that rejection never becomes an
    // unhandled promise before the code below reaches `await result`.
    void result.catch(() => undefined);
    const active: ActiveRun = {
      sessionId: request.sessionId,
      messageId: null,
      seenRunning: false,
      seenIdleAfterWork: false,
      turnEnd: null,
      finalMessage: null,
      usage: { ...EMPTY_USAGE },
      providerCumulative: null,
      usageAccounting: "per-event-incremental",
      usageEventCount: 0,
      promptCharacterCount: request.prompt.length,
      toolCallCount: 0,
      toolResultCount: 0,
      contextWindow: null,
      eventSummaries: [],
      validation: [],
      diffs: [],
      toolNames: new Map(),
      callbackQueue: Promise.resolve(),
      onEvent: request.onEvent,
      resolve: resolveRun,
      reject: rejectRun,
      timer: undefined as unknown as NodeJS.Timeout,
      settled: false,
    };
    active.timer = setTimeout(() => {
      if (active.settled) return;
      active.settled = true;
      if (this.active === active) this.active = null;
      active.reject(new HostError(
        "runtime_turn_timeout",
        `Luna turn exceeded ${request.timeoutMs} ms; the task process was stopped`,
      ));
      void this.interrupt();
    }, request.timeoutMs);
    this.active = active;

    try {
      const admitted = asRecord(await this.request(
        "session/prompt",
        {
          sessionId: request.sessionId,
          contentBlocks: [{ type: "text", text: request.prompt }],
        },
        this.config.runtimeStartupTimeoutMs,
      ));
      const messageId = requireString(admitted.messageId, "DSH session/prompt returned no messageId");
      if (!active.settled && this.active === active) {
        active.messageId = messageId;
        this.maybeFinishActive();
      }
      return await result;
    } catch (error) {
      if (!active.settled) {
        clearTimeout(active.timer);
        active.settled = true;
        if (this.active === active) this.active = null;
        active.reject(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
  }

  async prepareSessionPermission(
    sessionId: string,
    permissionProfile: PermissionProfile,
  ): Promise<Record<string, unknown>> {
    await this.start();
    return this.applySessionPermission(sessionId, permissionProfile);
  }

  private async applySessionPermission(
    sessionId: string,
    permissionProfile: PermissionProfile,
  ): Promise<Record<string, unknown>> {
    const applied = asRecord(await this.request(
      "session/set-permission",
      { sessionId, permissionProfile },
      this.config.runtimeStartupTimeoutMs,
    ));
    const effective = requireString(
      applied.permissionProfile,
      "DSH session/set-permission returned no permissionProfile",
    );
    if (effective !== permissionProfile || applied.durable !== true) {
      throw new HostError(
        "runtime_permission_readback_mismatch",
        `DSH session permission read-back mismatch: requested ${permissionProfile}, got ${effective}`,
      );
    }
    this.permissionProfile = permissionProfile;
    return applied;
  }

  async interrupt(): Promise<boolean> {
    const child = this.child;
    if (child === null || child.exitCode !== null) return false;
    this.interrupted = true;
    child.kill("SIGTERM");
    await waitForExit(child, 5_000);
    if (child.exitCode === null) {
      if (process.platform === "win32") terminateOwnedProcessTree(child);
      else child.kill("SIGKILL");
      await waitForExit(child, 5_000);
    }
    if (child.exitCode === null) {
      throw new HostError("runtime_interrupt_failed", `DSH worker ${this.taskId} did not exit`);
    }
    return true;
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (child === null || child.exitCode !== null) return;
    if (this.active !== null) {
      await this.interrupt();
      return;
    }
    await this.request("shutdown", undefined, 5_000).catch(() => undefined);
    await waitForExit(child, 5_000);
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 5_000);
    }
    if (child.exitCode === null) {
      if (process.platform === "win32") terminateOwnedProcessTree(child);
      else child.kill("SIGKILL");
      await waitForExit(child, 5_000);
    }
    if (child.exitCode === null) {
      throw new HostError("runtime_shutdown_failed", `DSH worker ${this.taskId} did not exit`);
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (child === null || child.stdin.destroyed) {
      return Promise.reject(new HostError("runtime_not_running", "DSH SDK runtime is not running"));
    }
    const id = String(this.nextRequestId++);
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostError(
          "runtime_request_timeout",
          `DSH SDK ${method} timed out. ${this.stderrDiagnostic()}`,
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (error === null || error === undefined) return;
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.failProtocol(`Non-JSON stdout from DSH SDK runtime: ${line.slice(0, 500)}`);
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      this.failProtocol(
        `Unsupported DSH reverse request ${message.method}; KAI Work Host will not silently swallow an approval or user-input request`,
      );
      return;
    }
    if (message.id !== undefined) {
      const id = String(message.id);
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error !== undefined) {
        pending.reject(new HostError(
          "runtime_request_failed",
          `DSH SDK request failed: ${message.error.message ?? "unknown error"}. ${this.stderrDiagnostic()}`,
          { code: message.error.code ?? null },
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "session.event") this.handleSessionEvent(asRecord(message.params));
    else if (message.method === "session.status") this.handleSessionStatus(asRecord(message.params));
  }

  private handleSessionStatus(params: Record<string, unknown>): void {
    const active = this.active;
    if (active === null || params.sessionId !== active.sessionId) return;
    if (params.status === "running") active.seenRunning = true;
    if (params.status === "idle" && (active.seenRunning || active.turnEnd !== null)) {
      active.seenIdleAfterWork = true;
    }
    this.maybeFinishActive();
  }

  private handleSessionEvent(params: Record<string, unknown>): void {
    const active = this.active;
    if (active === null || params.sessionId !== active.sessionId) return;
    const event = asRecord(params.event);
    const type = typeof event.type === "string" ? event.type : "unknown";
    const data = asRecord(event.data);
    const summary = summarizeEvent(type, event, data, active.toolNames);
    if (summary !== null) {
      active.eventSummaries.push(summary);
      if (active.eventSummaries.length > 240) active.eventSummaries.shift();
      active.callbackQueue = active.callbackQueue.then(() => active.onEvent(summary));
    }

    if (type === "assistant/message") {
      const message = asRecord(data.message);
      const text = textContent(message.content);
      if (text.length > 0) active.finalMessage = text.slice(0, 16_000);
      addUsageObservation(active, asRecord(data.usage), this.providerCumulative);
      if (active.usageAccounting === "provider-cumulative-delta") {
        this.providerCumulative = active.providerCumulative;
      }
    } else if (type === "request/context") {
      if (typeof data.contextWindow === "number" && Number.isFinite(data.contextWindow)) {
        active.contextWindow = data.contextWindow;
      }
    } else if (type === "tool/call") {
      active.toolCallCount += 1;
      const callId = typeof data.callId === "string" ? data.callId : "unknown";
      const name = typeof data.name === "string" ? data.name : "unknown";
      active.toolNames.set(callId, name);
    } else if (type === "tool/result") {
      active.toolResultCount += 1;
      const callId = typeof data.message === "object" && data.message !== null
        ? String(asRecord(data.message).toolCallId ?? "unknown")
        : "unknown";
      const name = active.toolNames.get(callId) ?? "tool";
      active.validation.push(`${name}: ${data.error === undefined ? "completed" : "error"}`);
      const diffs = findDiffStrings(data.meta);
      for (const diff of diffs) if (!active.diffs.includes(diff)) active.diffs.push(diff);
    } else if (type === "turn/end") {
      active.turnEnd = asRecord(data.reason);
    }
    this.maybeFinishActive();
  }

  private maybeFinishActive(): void {
    const active = this.active;
    if (
      active === null || active.settled || active.messageId === null ||
      active.turnEnd === null || !active.seenIdleAfterWork
    ) return;
    active.settled = true;
    clearTimeout(active.timer);
    this.active = null;
    void active.callbackQueue.then(() => {
      const reasonKind = typeof active.turnEnd?.kind === "string" ? active.turnEnd.kind : "error";
      const status = reasonKind === "completed"
        ? "completed"
        : ["aborted", "interrupted"].includes(reasonKind)
          ? "interrupted"
          : "failed";
      const error = reasonKind === "error"
        ? String(asRecord(active.turnEnd?.error).message ?? "Luna turn failed")
        : status === "failed"
          ? `Luna turn ended with ${reasonKind}`
          : null;
      const total = totalUsage(active.usage);
      const providerCumulative = active.providerCumulative === null
        ? null
        : totalUsage(active.providerCumulative);
      active.resolve({
        messageId: requireString(active.messageId, "Missing admitted message id"),
        status,
        reason: active.turnEnd,
        finalMessage: active.finalMessage,
        error,
        usage: {
          source: "runtime",
          cumulative: null,
          incremental: total,
          providerCumulative,
          diagnostics: {
            accounting: active.usageAccounting,
            usageEventCount: active.usageEventCount,
            promptCharacterCount: active.promptCharacterCount,
            toolCallCount: active.toolCallCount,
            toolResultCount: active.toolResultCount,
            providerCumulative,
            contextWindow: active.contextWindow,
            contextTokens: null,
            sessionHistoryTokens: null,
            toolSchemaTokens: null,
            overheadNote: "DSH exposes no token attribution for session history, context sections, or tool schemas; those portions are not estimated.",
          },
          modelContextWindow: active.contextWindow,
        },
        eventSummaries: active.eventSummaries,
        validation: active.validation.slice(-20),
        diffText: active.diffs.length === 0 ? null : active.diffs.join("\n\n"),
      });
    }, active.reject);
  }

  private failProtocol(message: string): void {
    const error = new HostError("runtime_protocol_invalid", `${message}. ${this.stderrDiagnostic()}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    const active = this.active;
    if (active !== null && !active.settled) {
      clearTimeout(active.timer);
      active.settled = true;
      this.active = null;
      active.reject(error);
    }
    this.child?.kill("SIGTERM");
  }

  private handleExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    spawnError: Error | null,
  ): void {
    const message = spawnError?.message ??
      `DSH SDK runtime exited (code=${String(code)}, signal=${String(signal)})`;
    const error = new HostError(
      this.interrupted ? "runtime_interrupted" : "runtime_exited",
      `${message}. ${this.stderrDiagnostic()}`,
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    const active = this.active;
    if (active !== null && !active.settled) {
      clearTimeout(active.timer);
      active.settled = true;
      this.active = null;
      active.reject(error);
    }
  }

  private stderrDiagnostic(): string {
    const text = this.stderrTail.trim();
    return text.length === 0 ? "No runtime diagnostic was emitted" : `Runtime diagnostic: ${text.slice(-4_000)}`;
  }
}

function summarizeEvent(
  type: string,
  event: Record<string, unknown>,
  data: Record<string, unknown>,
  toolNames: Map<string, string>,
): RuntimeEventSummary | null {
  const base = {
    type,
    sequence: typeof event.seq === "number" ? event.seq : null,
    at: typeof event.time === "number" ? new Date(event.time).toISOString() : new Date().toISOString(),
  };
  if (type === "turn/start" || type === "turn/end" || type === "request/context") {
    return { ...base, data: sanitizeValue(data) as Record<string, unknown> };
  }
  if (type === "assistant/message") {
    const message = asRecord(data.message);
    return {
      ...base,
      data: {
        turn: data.turn ?? null,
        step: data.step ?? null,
        text: textContent(message.content).slice(0, 4_000),
        usage: sanitizeValue(data.usage),
      },
    };
  }
  if (type === "tool/call") {
    return {
      ...base,
      data: {
        turn: data.turn ?? null,
        step: data.step ?? null,
        callId: data.callId ?? null,
        name: data.name ?? null,
        argumentsDigest: digest(String(data.arguments ?? "")),
      },
    };
  }
  if (type === "tool/result") {
    const message = asRecord(data.message);
    const callId = String(message.toolCallId ?? "unknown");
    return {
      ...base,
      data: {
        turn: data.turn ?? null,
        step: data.step ?? null,
        callId,
        tool: toolNames.get(callId) ?? "tool",
        error: data.error === undefined ? null : sanitizeValue(data.error),
      },
    };
  }
  if (type === "todo/write") {
    return { ...base, data: { todos: sanitizeValue(data.todos) } };
  }
  return null;
}

function addUsageObservation(
  active: ActiveRun,
  raw: Record<string, unknown>,
  priorProviderCumulative: TokenUsageBreakdown | null,
): void {
  const observation = accountRuntimeUsage(priorProviderCumulative, raw);
  if (!observation.counted) return;
  if (observation.accounting === "provider-cumulative-delta") {
    active.usageAccounting = observation.accounting;
  }
  addUsage(active.usage, observation.incremental);
  if (observation.accounting === "provider-cumulative-delta") {
    active.providerCumulative = observation.providerCumulative;
  } else if (active.usageAccounting !== "provider-cumulative-delta") {
    active.providerCumulative = null;
  }
  active.usageEventCount += 1;
}

function explicitCumulativeUsage(raw: Record<string, unknown>): TokenUsageBreakdown | null {
  for (const key of ["cumulative", "cumulativeUsage", "providerCumulative"]) {
    const nested = raw[key];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      return usageBreakdown(nested as Record<string, unknown>);
    }
  }
  return raw.accounting === "cumulative" || raw.isCumulative === true ? usageBreakdown(raw) : null;
}

function usageBreakdown(raw: Record<string, unknown>): TokenUsageBreakdown {
  const inputTokens = nonNegativeNumber(raw.uncachedInputTokens || raw.inputTokens);
  const value: TokenUsageBreakdown = {
    inputTokens,
    uncachedInputTokens: inputTokens,
    cachedInputTokens: nonNegativeNumber(raw.cachedInputTokens || raw.cacheReadTokens),
    cacheWriteInputTokens: nonNegativeNumber(raw.cacheWriteInputTokens || raw.cacheWriteTokens),
    outputTokens: nonNegativeNumber(raw.outputTokens),
    reasoningOutputTokens: nonNegativeNumber(raw.reasoningOutputTokens || raw.reasoningTokens),
    totalTokens: 0,
  };
  return totalUsage(value);
}

function hasUsageFields(raw: Record<string, unknown>): boolean {
  return [
    "inputTokens", "uncachedInputTokens", "cacheReadTokens", "cachedInputTokens",
    "cacheWriteTokens", "cacheWriteInputTokens", "outputTokens", "reasoningTokens",
    "reasoningOutputTokens", "totalTokens",
  ].some((key) => raw[key] !== undefined);
}

function cumulativeReset(current: TokenUsageBreakdown, prior: TokenUsageBreakdown): boolean {
  return current.inputTokens < prior.inputTokens ||
    current.cachedInputTokens < prior.cachedInputTokens ||
    current.cacheWriteInputTokens < prior.cacheWriteInputTokens ||
    current.outputTokens < prior.outputTokens ||
    current.reasoningOutputTokens < prior.reasoningOutputTokens;
}

function subtractUsage(current: TokenUsageBreakdown, prior: TokenUsageBreakdown): TokenUsageBreakdown {
  const inputTokens = Math.max(0, current.inputTokens - prior.inputTokens);
  const cachedInputTokens = Math.max(0, current.cachedInputTokens - prior.cachedInputTokens);
  const cacheWriteInputTokens = Math.max(0, current.cacheWriteInputTokens - prior.cacheWriteInputTokens);
  const outputTokens = Math.max(0, current.outputTokens - prior.outputTokens);
  const reasoningOutputTokens = Math.max(0, current.reasoningOutputTokens - prior.reasoningOutputTokens);
  return totalUsage({
    inputTokens,
    uncachedInputTokens: inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: 0,
  });
}

function addUsage(target: TokenUsageBreakdown, value: TokenUsageBreakdown): void {
  target.inputTokens += value.inputTokens;
  target.uncachedInputTokens = target.inputTokens;
  target.cachedInputTokens += value.cachedInputTokens;
  target.cacheWriteInputTokens += value.cacheWriteInputTokens;
  target.outputTokens += value.outputTokens;
  target.reasoningOutputTokens += value.reasoningOutputTokens;
  target.totalTokens = target.inputTokens + target.cachedInputTokens +
    target.cacheWriteInputTokens + target.outputTokens;
}

function totalUsage(value: TokenUsageBreakdown): TokenUsageBreakdown {
  const inputTokens = value.uncachedInputTokens ?? value.inputTokens;
  return {
    ...value,
    inputTokens,
    uncachedInputTokens: inputTokens,
    totalTokens: inputTokens + value.cachedInputTokens + value.cacheWriteInputTokens + value.outputTokens,
  };
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function textContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => asRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n")
    .trim();
}

function findDiffStrings(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => findDiffStrings(item, depth + 1));
  if (typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === "string" && /(?:diff|patch)/iu.test(key) && child.length <= 100_000) found.push(child);
    else found.push(...findDiffStrings(child, depth + 1));
  }
  return found;
}

function sanitizeValue(value: unknown, key = ""): unknown {
  if (/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|authorization|password|secret)/iu.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      sanitizeValue(child, childKey),
    ]));
  }
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new HostError("runtime_protocol_invalid", message);
  return value;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left).replace(/[\\/]+$/u, "");
  const normalizedRight = path.resolve(right).replace(/[\\/]+$/u, "");
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
