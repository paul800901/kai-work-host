import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { CODEX_WORKER_CONFIG } from "../src/codex-runtime.js";
import { codexEnvironment } from "../src/worker-runtime.js";

const names = ["KAI_WORK_HOST_BIND", "KAI_WORK_HOST_BEARER_TOKEN", "KAI_WORK_HOST_WORKER_MODEL",
  "KAI_WORK_HOST_EXECUTION_PROFILE", "KAI_WORK_HOST_CONTEXT_CHARS", "KAI_WORK_HOST_HOME",
  "KAI_WORK_HOST_CODEX_HOME", "KAI_WORK_HOST_CODEX_CLI", "KAI_WORK_HOST_RUNTIME_STARTUP_MS"];

test("configuration keeps isolated portable defaults and rejects non-Luna workers", () => {
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const config = loadConfig();
    assert.equal(config.codexHome, path.join(config.stateRoot, "codex"));
    assert.match(config.codexCliPath, /node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex.js$/u);
    process.env.KAI_WORK_HOST_BIND = "0.0.0.0";
    assert.throws(() => loadConfig(), /non-loopback bind requires/u);
    process.env.KAI_WORK_HOST_BEARER_TOKEN = "test-only-placeholder";
    assert.equal(loadConfig().bindHost, "0.0.0.0");
    process.env.KAI_WORK_HOST_WORKER_MODEL = "gpt-5.6-sol";
    assert.throws(() => loadConfig(), /must be a Luna model/u);
    process.env.KAI_WORK_HOST_WORKER_MODEL = "gpt-5.6-luna";
    process.env.KAI_WORK_HOST_EXECUTION_PROFILE = "wide";
    assert.throws(() => loadConfig(), /must be lean or standard/u);
  } finally {
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name];
    }
  }
});

test("worker cannot inherit desktop state, API billing, provider overrides or DSH credentials", () => {
  const inherited = { PATH: "fixture", OPENAI_API_KEY: "test", OPENAI_BASE_URL: "test", CODEX_HOME: "desktop",
    CODEX_API_KEY: "test", DSH_HOME: "old", KAI_DSH_WORKER_MODEL: "other" };
  const env = codexEnvironment({ codexHome: "isolated-instance" }, inherited);
  assert.deepEqual(env, { PATH: "fixture", CODEX_HOME: "isolated-instance" });
  assert.equal(inherited.CODEX_HOME, "desktop");
  assert.equal(CODEX_WORKER_CONFIG.forced_login_method, "chatgpt");
  assert.equal(CODEX_WORKER_CONFIG["memories.generate_memories"], false);
  assert.equal(CODEX_WORKER_CONFIG["memories.use_memories"], false);
  assert.equal(CODEX_WORKER_CONFIG["features.multi_agent"], false);
  assert.equal(CODEX_WORKER_CONFIG.approvals_reviewer, "user");
});
