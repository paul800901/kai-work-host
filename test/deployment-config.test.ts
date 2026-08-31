import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyDeploymentConfig } from "../scripts/load-deployment-config.mjs";

const affected = [
  "KAI_WORK_HOST_CONFIG",
  "KAI_WORK_HOST_HOME",
  "KAI_WORK_HOST_DSH_ROOT",
  "KAI_WORK_HOST_DSH_PROFILE",
  "KAI_WORK_HOST_INSTANCE_ID",
] as const;

test("deployment config applies only safe missing values and keeps environment overrides", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kai-work-host-config-"));
  const configDir = path.join(root, "config");
  await mkdir(configDir);
  await writeFile(path.join(configDir, "work-host.local.json"), `${JSON.stringify({
    schema_version: 1,
    instance_id: "east",
    environment: {
      KAI_WORK_HOST_HOME: "C:\\KAI-Test\\east",
      KAI_WORK_HOST_DSH_ROOT: "C:\\KAI-Test\\dsh",
      KAI_WORK_HOST_DSH_PROFILE: "kai-work-host-east",
    },
  }, null, 2)}\n`);
  const prior = Object.fromEntries(affected.map((name) => [name, process.env[name]]));
  try {
    for (const name of affected) delete process.env[name];
    process.env.KAI_WORK_HOST_HOME = "C:\\operator-override";
    const result = applyDeploymentConfig({ projectRoot: root });
    assert.equal(result.loaded, true);
    assert.equal(result.instanceId, "east");
    assert.equal(process.env.KAI_WORK_HOST_HOME, "C:\\operator-override");
    assert.equal(process.env.KAI_WORK_HOST_DSH_ROOT, "C:\\KAI-Test\\dsh");
    assert.equal(process.env.KAI_WORK_HOST_DSH_PROFILE, "kai-work-host-east");
    assert.equal(process.env.KAI_WORK_HOST_INSTANCE_ID, "east");
  } finally {
    for (const name of affected) {
      const value = prior[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment config rejects secret-bearing and unknown environment keys", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kai-work-host-config-reject-"));
  const configDir = path.join(root, "config");
  await mkdir(configDir);
  await writeFile(path.join(configDir, "work-host.local.json"), `${JSON.stringify({
    schema_version: 1,
    instance_id: "east",
    environment: { KAI_WORK_HOST_BEARER_TOKEN: "must-not-live-here" },
  })}\n`);
  const prior = process.env.KAI_WORK_HOST_CONFIG;
  try {
    delete process.env.KAI_WORK_HOST_CONFIG;
    assert.throws(
      () => applyDeploymentConfig({ projectRoot: root }),
      /unsupported or secret-bearing key/u,
    );
  } finally {
    if (prior === undefined) delete process.env.KAI_WORK_HOST_CONFIG;
    else process.env.KAI_WORK_HOST_CONFIG = prior;
    await rm(root, { recursive: true, force: true });
  }
});
