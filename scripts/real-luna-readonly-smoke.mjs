import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { applyDeploymentConfig } from "./load-deployment-config.mjs";

applyDeploymentConfig();

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = process.env.KAI_SMOKE_MCP_URL ?? "http://127.0.0.1:8787/mcp";
const projectRoot = path.resolve(process.env.KAI_SMOKE_PROJECT_ROOT ?? process.cwd());
const watchedFiles = ["package.json", "README.md"];
const terminalStatuses = new Set(["completed", "failed", "cancelled", "needs_resume"]);

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} did not return an object`);
  }
  return value;
}

async function digest(relativePath) {
  const bytes = await readFile(path.join(projectRoot, relativePath));
  return createHash("sha256").update(bytes).digest("hex");
}

async function snapshot() {
  return Object.fromEntries(await Promise.all(watchedFiles.map(async (file) => [file, await digest(file)])));
}

function resultText(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

const before = await snapshot();
const transport = new StreamableHTTPClientTransport(new URL(endpoint));
const client = new Client({ name: "kai-real-luna-readonly-smoke", version: "0.1.0" });

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${resultText(result)}`);
  return object(result.structuredContent ?? {}, name);
}

const webSessionId = `real-readonly-smoke-${randomUUID()}`;
let jobId;
let finalStatus;

try {
  await client.connect(transport);
  const initialized = await call("codexluna_init", {
    web_session_id: webSessionId,
    workspace_path: projectRoot,
    model: "gpt-5.6-luna",
    reasoning_effort: "high",
    fast: true,
    permission_mode: "read-only",
    network_access: false,
    timeout_ms: 10 * 60_000,
  });
  if (initialized.permission_mode !== "read-only" || initialized.network_access !== false) {
    throw new Error(`Unexpected effective authorization: ${JSON.stringify(initialized)}`);
  }

  const started = await call("codexluna_start", {
    web_session_id: webSessionId,
    request_id: `real-readonly-turn-${randomUUID()}`,
    permission_mode: "read-only",
    network_access: false,
    timeout_ms: 10 * 60_000,
    prompt: [
      "Perform a strictly read-only inspection of package.json and README.md in this project.",
      "Report the package name and version from package.json, then report one capability explicitly listed as excluded or not yet supported in README.md.",
      "Do not inspect secrets or unrelated paths.",
      "The response states the package name and version exactly as read.",
      "The response identifies one documented exclusion from README.md.",
      "No file or Git state is modified.",
      "Read package.json and README.md only.",
      "Do not write, patch, install, fetch from the network, run tests, or invoke another agent.",
      "If any requested read is unavailable, report the limitation instead of changing permissions.",
    ].join(" "),
  });

  jobId = started.job_id;
  if (typeof jobId !== "string") throw new Error("codexluna_start did not return job_id");

  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    finalStatus = await call("codexluna_status", { job_id: jobId, web_session_id: webSessionId });
    if (terminalStatuses.has(finalStatus.status)) break;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }

  if (finalStatus?.status !== "completed") {
    throw new Error(`Real Luna smoke did not complete: ${String(finalStatus?.status)}`);
  }
} finally {
  await client.close().catch(() => undefined);
}

const after = await snapshot();
const hashesUnchanged = watchedFiles.every((file) => before[file] === after[file]);
if (!hashesUnchanged) throw new Error("Read-only smoke changed a watched source file");

console.log(JSON.stringify({
  ok: true,
  endpoint,
  webSessionId,
  jobId,
  status: finalStatus.status,
  lunaSessionId: finalStatus.luna_session_id,
  finalMessage: finalStatus.final_message,
  eventCount: finalStatus.event_count,
  watchedFiles,
  hashesUnchanged,
}, null, 2));
