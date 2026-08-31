import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { applyDeploymentConfig } from "./load-deployment-config.mjs";

applyDeploymentConfig();
const { loadConfig } = await import("../dist/config.js").catch(() => {
  throw new Error("KAI Work Host is not built. Run npm run build before OAuth setup.");
});
const config = loadConfig();
const dshRoot = config.dshRoot;
const stateRoot = config.stateRoot;
const dshHome = config.dshHome;
const statusOnly = process.argv.includes("--status");
const force = process.argv.includes("--force");
const deviceCodeLogin = process.argv.includes("--device-code");

const modules = {
  cordis: path.join(dshRoot, "vendor", "cordis", "lib", "index.js"),
  llm: path.join(dshRoot, "packages", "llm", "llm", "lib", "index.js"),
  credentials: path.join(
    dshRoot,
    "packages",
    "credentials",
    "credentials-local",
    "lib",
    "index.js",
  ),
  authorization: path.join(
    dshRoot,
    "packages",
    "credentials",
    "authorization",
    "lib",
    "index.js",
  ),
  piAi: path.join(dshRoot, "packages", "llm", "llm-pi-ai", "lib", "index.js"),
};

for (const [name, filename] of Object.entries(modules)) {
  await access(filename).catch(() => {
    throw new Error(`Pinned DSH ${name} module is missing: ${filename}`);
  });
}
await mkdir(dshHome, { recursive: true });

const [{ Context }, llmModule, credentialModule, authorizationModule, piAiModule] =
  await Promise.all([
    import(pathToFileURL(modules.cordis).href),
    import(pathToFileURL(modules.llm).href),
    import(pathToFileURL(modules.credentials).href),
    import(pathToFileURL(modules.authorization).href),
    import(pathToFileURL(modules.piAi).href),
  ]);

const LlmRuntime = llmModule.default;
const LocalCredentials = credentialModule.default;
const AuthorizationService = authorizationModule.default;
const { AuthorizationDeclinedError } = authorizationModule;
const key = piAiModule.recordKeyFor("openai-codex");
const ctx = new Context();
const controller = new AbortController();
const onSignal = () => controller.abort();
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(LocalCredentials, { dshHome, watch: false });
  await ctx.plugin(AuthorizationService);
  await ctx.plugin(piAiModule, {
    providers: {
      "openai-codex": {
        reasoning: process.env.KAI_WORK_HOST_WORKER_EFFORT ?? "high",
      },
    },
  });

  const current = await ctx.credentials.readRecord(key);
  if (statusOnly) {
    printStatus(current);
  } else if (current?.kind === "grant" && !force) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      provider: "openai-codex",
      credentialKind: "grant",
      alreadyConfigured: true,
      dshHome,
      secretPrinted: false,
    }, null, 2)}\n`);
  } else {
    const offered = ctx.authorization.describe(key);
    if (offered === undefined || !offered.methods.some((method) => method.id === "oauth")) {
      throw new Error("Pinned DSH did not expose the openai-codex OAuth flow");
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const result = await ctx.authorization.begin({
        key,
        method: "oauth",
        signal: controller.signal,
        interaction: {
          notify(notice) {
            process.stdout.write(`${notice.message}\n`);
            if (notice.code !== undefined) process.stdout.write(`Code: ${notice.code}\n`);
            if (notice.url !== undefined) {
              process.stdout.write(`URL: ${notice.url}\n`);
              if (shouldOpenBrowser()) void openBrowser(notice.url);
            }
          },
          async prompt(prompt) {
            if (prompt.kind === "select") {
              const preferred = deviceCodeLogin ? "device_code" : "browser";
              if (prompt.options.some((option) => option.id === preferred)) {
                process.stdout.write(`${prompt.message}: ${preferred}\n`);
                return preferred;
              }
            }
            if (prompt.kind === "select") {
              process.stdout.write(`${prompt.options.map((option) => `  ${option.id}: ${option.label}`).join("\n")}\n`);
            }
            try {
              return await rl.question(
                `${prompt.message}${prompt.placeholder === undefined ? "" : ` (${prompt.placeholder})`}: `,
                { signal: prompt.signal ?? controller.signal },
              );
            } catch (error) {
              if (error?.name === "AbortError") throw new AuthorizationDeclinedError();
              throw error;
            }
          },
        },
      });
      if (result.status !== "authorized") {
        throw new Error("Luna OAuth sign-in was cancelled before a grant was stored");
      }
    } finally {
      rl.close();
    }

    const stored = await ctx.credentials.readRecord(key);
    if (stored?.kind !== "grant") {
      throw new Error("OAuth reported success but the isolated DSH grant was not stored");
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      provider: "openai-codex",
      credentialKind: "grant",
      alreadyConfigured: false,
      dshHome,
      secretPrinted: false,
    }, null, 2)}\n`);
  }
} finally {
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  await ctx.fiber.dispose();
}

function printStatus(record) {
  process.stdout.write(`${JSON.stringify({
    ok: record?.kind === "grant",
    provider: "openai-codex",
    credentialConfigured: record !== undefined,
    credentialKind: record?.kind ?? null,
    dshHome,
    secretPrinted: false,
  }, null, 2)}\n`);
}

function shouldOpenBrowser() {
  return process.platform === "win32"
    && process.env.KAI_WORK_HOST_OPEN_BROWSER !== "0";
}

async function openBrowser(url) {
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Process -FilePath $args[0]",
      url,
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
}
