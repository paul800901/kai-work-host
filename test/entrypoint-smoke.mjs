import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyDeploymentConfig } from "../scripts/load-deployment-config.mjs";

applyDeploymentConfig();

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

const stateRoot = await mkdtemp(path.join(tmpdir(), "kai-work-host-entrypoint-"));
const port = await reservePort();
const startupTimeoutMs = Number.parseInt(process.env.KAI_WORK_HOST_RUNTIME_STARTUP_MS ?? "120000", 10);
const child = spawn(process.execPath, [path.resolve("dist/index.js")], {
  cwd: process.cwd(),
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    KAI_WORK_HOST_BIND: "127.0.0.1",
    KAI_WORK_HOST_PORT: String(port),
    KAI_WORK_HOST_HOME: stateRoot,
    KAI_WORK_HOST_DSH_HOME: path.join(stateRoot, "dsh"),
    KAI_WORK_HOST_DSH_PROFILE: "kai-work-host-entrypoint-smoke",
    KAI_WORK_HOST_RUNTIME_STARTUP_MS: String(startupTimeoutMs),
  },
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

try {
  const line = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`Host startup timed out: ${stderr}`)), startupTimeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Host exited before readiness (code=${code}): ${stderr}`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      resolve(buffer.slice(0, newline));
    });
  });
  const readiness = JSON.parse(line);
  assert.equal(readiness.service, "kai-work-host");
  assert.equal(readiness.mcp, `http://127.0.0.1:${port}/mcp`);
  assert.equal(readiness.workerModel, "gpt-5.6-luna");
  assert.equal(readiness.runtime, "dsh-sdk-jsonrpc");
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "kai-work-host", version: "0.3.0" });
  process.stdout.write("KAI Work Host entrypoint and health route are ready.\n");
} finally {
  if (child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(stateRoot, { recursive: true, force: true });
}
