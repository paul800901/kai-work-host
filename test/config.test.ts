import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { DSH_DIRECTORY_NAME } from "../src/dsh-pin.js";
import { DshProfileManager, KAI_DSH_PROFILE_PATCH } from "../src/dsh-profile.js";
import type { HostConfig } from "../src/types.js";

const names = [
  "KAI_WORK_HOST_BIND",
  "KAI_WORK_HOST_BEARER_TOKEN",
  "KAI_WORK_HOST_WORKER_MODEL",
  "KAI_WORK_HOST_EXECUTION_PROFILE",
  "KAI_WORK_HOST_CONTEXT_CHARS",
  "KAI_WORK_HOST_DSH_PROVIDER",
  "KAI_WORK_HOST_HOME",
  "KAI_WORK_HOST_DSH_ROOT",
  "KAI_WORK_HOST_DSH_HOME",
  "KAI_WORK_HOST_DSH_PROFILE",
  "KAI_WORK_HOST_RUNTIME_STARTUP_MS",
] as const;

test("configuration fails closed for remote bind and non-Luna workers", () => {
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.KAI_WORK_HOST_BIND = "0.0.0.0";
    delete process.env.KAI_WORK_HOST_BEARER_TOKEN;
    assert.throws(() => loadConfig(), /non-loopback bind requires/u);

    process.env.KAI_WORK_HOST_BEARER_TOKEN = "test-only-placeholder";
    const remote = loadConfig();
    assert.equal(remote.bindHost, "0.0.0.0");

    process.env.KAI_WORK_HOST_WORKER_MODEL = "gpt-5.6-sol";
    assert.throws(() => loadConfig(), /must be a Luna model/u);

    process.env.KAI_WORK_HOST_WORKER_MODEL = "gpt-5.6-luna";
    process.env.KAI_WORK_HOST_EXECUTION_PROFILE = "wide";
    assert.throws(() => loadConfig(), /must be lean or standard/u);

    process.env.KAI_WORK_HOST_EXECUTION_PROFILE = "lean";
    delete process.env.KAI_WORK_HOST_CONTEXT_CHARS;
    const lean = loadConfig();
    assert.equal(lean.maxContextCharacters, 12_000);
    process.env.KAI_WORK_HOST_DSH_PROVIDER = "openai";
    assert.throws(() => loadConfig(), /must be openai-codex/u);
  } finally {
    for (const name of names) {
      const value = prior[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("portable defaults stay under the current user's local application data", () => {
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const config = loadConfig();
    if (process.platform === "win32") {
      assert.match(config.stateRoot, /[\\/]KAI[\\/]WorkHost$/u);
      assert.doesNotMatch(config.stateRoot, /^D:\\KAI/iu);
    }
    assert.equal(config.dshRoot, path.join(config.stateRoot, "dependencies", DSH_DIRECTORY_NAME));
    assert.equal(config.dshHome, path.join(config.stateRoot, "dsh"));
    assert.equal(config.runtimeStartupTimeoutMs, 120_000);
  } finally {
    for (const name of names) {
      const value = prior[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("managed DSH profile reads the selected Luna model from the worker environment", () => {
  assert.match(KAI_DSH_PROFILE_PATCH, /KAI_DSH_WORKER_MODEL/u);
  assert.doesNotMatch(KAI_DSH_PROFILE_PATCH, /^\s{4}model:\s+gpt-5\.6-luna\s*$/mu);
});

test("managed DSH profile excludes browser-only type gateway plugins", () => {
  for (const id of ["typert", "typert-loader", "typert-gateway"]) {
    assert.match(
      KAI_DSH_PROFILE_PATCH,
      new RegExp(`- id: ${id}\\n  disabled: true`, "u"),
    );
  }
});

test("managed SDK control waits for non-fallback provider adapter readiness", () => {
  const config: HostConfig = {
    bindHost: "127.0.0.1",
    port: 8787,
    stateRoot: path.resolve("state"),
    dshRoot: path.resolve("dsh"),
    dshHome: path.resolve("state", "dsh"),
    dshCliPath: path.resolve("dsh", "apps", "cli", "lib", "bin.js"),
    dshSdkPluginRoot: path.resolve("dsh", "packages", "sdk", "server"),
    dshProfile: "kai-work-host-test",
    dshProvider: "openai-codex",
    workerModel: "gpt-5.6-luna",
    workerEffort: "high",
    executionProfile: "lean",
    workerMaxOutputTokens: 32_768,
    runtimeStartupTimeoutMs: 120_000,
    runtimeTurnTimeoutMs: 1_800_000,
    bearerToken: null,
    maxContextCharacters: 12_000,
    maxEventBatch: 40,
  };
  const manager = new DshProfileManager(config);
  const source = (manager as unknown as { sdkControlPluginSource(): string }).sdkControlPluginSource();
  assert.match(source, /waitForProviderAdapter\(ctx, provider\)/u);
  assert.match(source, /provider === 'deepseek-official'/u);
  assert.match(source, /listProviders\(\)\.some\(\(entry\) => entry\.id === provider\)/u);
});
