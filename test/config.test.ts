import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { DSH_DIRECTORY_NAME } from "../src/dsh-pin.js";
import { KAI_DSH_PROFILE_PATCH } from "../src/dsh-profile.js";

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
