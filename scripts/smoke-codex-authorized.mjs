// Deliberately excluded from validate/CI. Requires a fresh explicit paid-smoke authorization.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../dist/config.js";
import { CodexRuntimeManager } from "../dist/codex-runtime.js";
import { DurableStore } from "../dist/durable-store.js";
import { ProjectRegistry } from "../dist/project-registry.js";
import { MemoryService } from "../dist/memory.js";
import { TaskOrchestrator } from "../dist/task-orchestrator.js";
import { HostHttpServer } from "../dist/http-server.js";

const cancelRetest = process.argv.includes("--authorized-cancel-retest");
if (!cancelRetest && !process.argv.includes("--authorized-three-turns")) throw new Error("Explicit subscription smoke authorization required");
const rootArg = process.argv[process.argv.indexOf("--root") + 1];
if (!process.argv.includes("--root") || !path.isAbsolute(rootArg)) throw new Error("Explicit isolated --root required");
if (!process.env.KAI_WORK_HOST_CODEX_HOME) throw new Error("Specify the independently authenticated KAI Codex home");
const root = path.resolve(rootArg);
await mkdir(root, { recursive: true });
// Refuse reruns, including after uncertain dispatch. Never spend three more turns on an automatic retry.
await writeFile(path.join(root, cancelRetest ? "authorized-cancel-retest.json" : "authorized-run.json"), JSON.stringify({ started: new Date().toISOString(), maximumTurns: cancelRetest ? 1 : 3 }), { flag: "wx" });
const workspace = path.join(root, "workspace");
if (!cancelRetest) await mkdir(workspace);
const config = { ...loadConfig(), stateRoot: path.join(root, "host"), bindHost: "127.0.0.1", port: 0,
  bearerToken: null, workerModel: "gpt-5.6-luna", workerEffort: "high", runtimeTurnTimeoutMs: 240_000 };
let current;
let attempts = 0;
let commandStarted = false;
const turns = [];
const webSession = "authorized-codex-isolated-smoke";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function open() {
  const store = new DurableStore(config.stateRoot);
  const runtime = new CodexRuntimeManager(config);
  const run = runtime.runTurn.bind(runtime);
  runtime.runTurn = async (request) => {
    assert.ok(++attempts <= (cancelRetest ? 1 : 3), "Authorization exhausted");
    console.log(JSON.stringify({ phase: "turn-attempt", number: attempts, model: request.model, effort: request.effort }));
    return await run({ ...request, onEvent: async (event) => {
      await request.onEvent(event);
      if (event.type === "tool/call" && event.data.item?.type === "commandExecution") commandStarted = true;
      if (["session/ready", "turn/start", "tool/call", "turn/end"].includes(event.type)) {
        console.log(JSON.stringify({ phase: "event", number: attempts, type: event.type }));
      }
    } });
  };
  const orchestrator = new TaskOrchestrator(config, store, new ProjectRegistry(store), new MemoryService(store, config.maxContextCharacters), runtime);
  await orchestrator.initialize();
  const http = new HostHttpServer(config, orchestrator);
  await http.listen();
  const address = http.address();
  const base = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: "kai-authorized-isolated-smoke", version: "0.4.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  current = { store, runtime, orchestrator, http, client, base };
}
async function close() {
  if (!current) return;
  await current.client.close();
  await current.http.close();
  await current.orchestrator.shutdown();
  current = null;
}
async function call(name, args = {}) {
  const response = await current.client.callTool({ name, arguments: { web_session_id: webSession, ...args } });
  assert.ok(!response.isError, JSON.stringify(response.content));
  return response.structuredContent;
}
async function wait(jobId) {
  const deadline = Date.now() + 250_000;
  while (Date.now() < deadline) {
    const status = await call("codexluna_status", { job_id: jobId });
    if (["completed", "failed", "cancelled", "needs_resume"].includes(status.status)) return status;
    await pause(300);
  }
  throw new Error("Isolated job did not finish within the bounded validation window");
}
async function start(prompt, number) {
  return await call("codexluna_start", { request_id: `authorized-smoke-turn-${number}`, prompt });
}
try {
  await open();
  if (cancelRetest) {
    const job = await start("Authorized isolated cancellation re-test. Run exactly one PowerShell command in the current workspace: create cancel-retest-started.txt, then Start-Sleep -Seconds 10, then create after-cancel-retest.txt. The operator will cancel after the first marker appears. Do not retry or use any other folder or network.", 4);
    const deadline = Date.now() + 120_000;
    let started = false;
    while (Date.now() < deadline) {
      started = await readFile(path.join(workspace, "cancel-retest-started.txt")).then(() => true, () => false);
      if (started) break;
      const status = await call("codexluna_status", { job_id: job.job_id });
      if (["failed", "needs_resume", "cancelled", "completed"].includes(status.status)) throw new Error(JSON.stringify(status));
      await pause(100);
    }
    assert.ok(started, "No native command-start marker");
    await call("codexluna_cancel", { job_id: job.job_id });
    const result = await wait(job.job_id);
    assert.equal(result.status, "cancelled");
    await pause(11_000);
    await assert.rejects(readFile(path.join(workspace, "after-cancel-retest.txt")), { code: "ENOENT" });
    assert.equal((await fetch(`${current.base}/healthz`)).status, 200);
    const proof = await call("file_read", { path: "proof.txt", workspace_path: workspace, permission_mode: "workspace-write" });
    assert.match(JSON.stringify(proof), /KAI_RESUMED/u);
    await writeFile(path.join(root, "cancel-retest-result.json"), JSON.stringify({ ok: true, attempts, nativeCommandStarted: true,
      noWriteAfterOriginalDeadline: true, hostHealthyAfterInterrupt: true, directMcpReadAfterInterrupt: true, result }, null, 2) + "\n");
    console.log(JSON.stringify({ ok: true, attempts, result: path.join(root, "cancel-retest-result.json") }));
  } else {
  const initialized = await call("codexluna_init", {
    request_id: "authorized-smoke-init-001", workspace_path: workspace, permission_mode: "workspace-write",
    network_access: false, model: "gpt-5.6-luna", reasoning_effort: "high", fast: true, timeout_ms: 240_000,
  });
  assert.equal(initialized.kai_memory.l1, false);
  assert.equal(initialized.kai_memory.l2, false);
  const prompt1 = "This is an authorized isolated executor test. Create proof.txt in the current workspace containing exactly KAI_FIRST followed by a newline. Do not read any other folder, use network, delegate, or change any other file. Verify the file and report only the result.";
  const first = await start(prompt1, 1);
  assert.equal((await start(prompt1, 1)).job_id, first.job_id, "Duplicate request must not dispatch another turn");
  turns.push(await wait(first.job_id));
  assert.equal(turns[0].status, "completed", JSON.stringify(turns[0]));
  assert.equal((await readFile(path.join(workspace, "proof.txt"), "utf8")).replaceAll("\r\n", "\n"), "KAI_FIRST\n");
  const thread = turns[0].luna_session_id;
  assert.ok(thread);
  await close();
  await open();
  const second = await start("Continue the isolated test. Read only proof.txt, append exactly KAI_RESUMED and a newline, verify both lines, and stop. No network or other files.", 2);
  turns.push(await wait(second.job_id));
  assert.equal(turns[1].status, "completed", JSON.stringify(turns[1]));
  assert.equal(turns[1].luna_session_id, thread, "Host restart must preserve official thread binding");
  assert.equal((await readFile(path.join(workspace, "proof.txt"), "utf8")).replaceAll("\r\n", "\n"), "KAI_FIRST\nKAI_RESUMED\n");
  commandStarted = false;
  const third = await start("Isolated cancellation test: run a local PowerShell command that waits 120 seconds (Start-Sleep -Seconds 120), then would create after-cancel.txt in the current workspace. Do nothing else. The operator will cancel this command before it completes. Do not retry a cancelled command.", 3);
  const commandDeadline = Date.now() + 90_000;
  while (!commandStarted && Date.now() < commandDeadline) await pause(200);
  assert.ok(commandStarted, "No command started for the cancellation test");
  await call("codexluna_cancel", { job_id: third.job_id });
  turns.push(await wait(third.job_id));
  assert.equal(turns[2].status, "cancelled");
  assert.equal((await fetch(`${current.base}/healthz`)).status, 200);
  const proof = await call("file_read", { path: "proof.txt", workspace_path: workspace, permission_mode: "workspace-write" });
  assert.match(JSON.stringify(proof), /KAI_RESUMED/u);
  await assert.rejects(readFile(path.join(workspace, "after-cancel.txt")), { code: "ENOENT" });
  const result = { ok: true, actualModel: "gpt-5.6-luna", effort: "high", maximumAuthorizedTurns: 3, attempts,
    sameThreadAfterRestart: true, duplicateRequestReplayed: false, hostHealthyAfterInterrupt: true,
    directMcpReadAfterInterrupt: true, automaticMemoryInjected: false, turns };
  await writeFile(path.join(root, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, attempts, result: path.join(root, "result.json") }));
  }
} catch (error) {
  await writeFile(path.join(root, cancelRetest ? "cancel-retest-result.json" : "result.json"), JSON.stringify({ ok: false, attempts, turns, error: String(error) }, null, 2) + "\n");
  throw error;
} finally { await close(); }
