import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyDeploymentConfig } from "./load-deployment-config.mjs";

applyDeploymentConfig();
const temporaryStateRoot = await mkdtemp(path.join(tmpdir(), "kai-work-host-dsh-probe-"));
process.env.KAI_WORK_HOST_HOME = temporaryStateRoot;
process.env.KAI_WORK_HOST_DSH_HOME = path.join(temporaryStateRoot, "dsh");
process.env.KAI_WORK_HOST_DSH_PROFILE = "kai-work-host-keyless-probe";

const [{ loadConfig }, { DshRuntimeManager }] = await Promise.all([
  import("../dist/config.js"),
  import("../dist/dsh-runtime.js"),
]);

const config = loadConfig();
const runtime = new DshRuntimeManager(config);

try {
  const probe = await runtime.probe();
  const status = await runtime.status();
  process.stdout.write(`${JSON.stringify({
    probe,
    profile: status.profile,
    engine: status.engine,
    provider: status.provider,
    model: status.model,
    codexProductRuntimeUsed: status.codexProductRuntimeUsed,
  }, null, 2)}\n`);
} finally {
  await runtime.shutdown();
  await rm(temporaryStateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
