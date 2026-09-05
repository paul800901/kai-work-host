import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { CodexRuntimeManager } from "../src/codex-runtime.js";
import { MemoryService } from "../src/memory.js";
import type { DurableStore } from "../src/durable-store.js";
import type { ProjectRecord, TaskRecord } from "../src/types.js";
import type { WorkerRunRequest } from "../src/worker-runtime.js";

async function fixture(kind = "workspace") {
  const root = await mkdtemp(path.join(tmpdir(), "kai-codex-test-"));
  const cwd = path.join(root, kind); await mkdir(cwd);
  const config = { ...loadConfig(), stateRoot: root, codexHome: path.join(root, "codex"),
    codexCliPath: path.resolve("test/fixtures/codex-app-server.cjs"), runtimeStartupTimeoutMs: 3_000 };
  let sessionId: string | null = null;
  const request: WorkerRunRequest = {
    taskId: "fixture", sessionId: null, model: "gpt-5.6-luna", effort: "high", fast: true,
    cwd, permissionProfile: "read-only", networkAccess: false, timeoutMs: 10_000, prompt: "execute fixture",
    onEvent: async (event) => { if (event.type === "session/ready") sessionId = String(event.data.sessionId); },
  };
  return { config, cwd, request, runtime: new CodexRuntimeManager(config), sessionId: () => sessionId,
    wire: async () => (await readFile(path.join(cwd, "fixture-wire.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)) };
}

test("official adapter preserves one thread, applies every-turn scope, and counts cumulative usage once", async () => {
  const f = await fixture();
  try {
    const first = await f.runtime.runTurn(f.request);
    assert.equal(first.status, "completed");
    assert.equal(first.diffText, "final aggregate diff");
    assert.equal(first.usage.incremental?.totalTokens, 110);
    assert.equal(first.usage.incremental?.inputTokens, 50);
    const second = await f.runtime.runTurn({ ...f.request, sessionId: f.sessionId(), effort: "medium", permissionProfile: "workspace-write", networkAccess: true });
    assert.equal(second.usage.incremental?.totalTokens, 110);
    const wire = await f.wire();
    assert.equal(wire.filter((row) => row.method === "thread/start").length, 1);
    assert.equal(wire.filter((row) => row.method === "thread/resume").length, 1);
    const turns = wire.filter((row) => row.method === "turn/start");
    assert.equal(turns[1].params.effort, "medium");
    assert.equal(turns[1].params.sandboxPolicy.type, "workspaceWrite");
    assert.equal(turns[1].params.sandboxPolicy.networkAccess, true);
    assert.ok(turns.every((row) => row.params.serviceTierForTurn === "default"));
  } finally { await f.runtime.shutdown(); }
});

test("read-only online turns use explicit turn policy without requiring a writable thread", async () => {
  const f = await fixture();
  try {
    const result = await f.runtime.runTurn({ ...f.request, networkAccess: true });
    assert.equal(result.status, "completed");
    const wire = await f.wire();
    assert.equal(wire.find((row) => row.method === "thread/start").params.sandbox, "read-only");
    assert.deepEqual(wire.find((row) => row.method === "turn/start").params.sandboxPolicy, { type: "readOnly", networkAccess: true });
  } finally { await f.runtime.shutdown(); }
});

test("worker restart resumes its durable binding and does not charge old history as the new turn", async () => {
  const f = await fixture();
  await f.runtime.runTurn(f.request);
  await f.runtime.shutdown();
  const restarted = new CodexRuntimeManager(f.config);
  try {
    const result = await restarted.runTurn({ ...f.request, sessionId: f.sessionId() });
    assert.equal(result.status, "completed");
    assert.equal(result.usage.incremental?.totalTokens, 110);
    assert.equal((await f.wire()).filter((row) => row.method === "thread/start").length, 1);
  } finally { await restarted.shutdown(); }
});

test("lost turn acknowledgement is uncertain, never automatically replayed, and explicit continuation resumes", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.runtime.runTurn({ ...f.request, prompt: "[lost-ack]" }), /uncertain|Codex exited/u);
    assert.equal((await f.wire()).filter((row) => row.method === "turn/start").length, 1);
    const next = await f.runtime.runTurn({ ...f.request, sessionId: f.sessionId(), prompt: "Inspect effects and continue" });
    assert.equal(next.status, "completed");
    assert.equal((await f.wire()).filter((row) => row.method === "thread/start").length, 1);
  } finally { await f.runtime.shutdown(); }
});

test("Luna job failure does not stop the host runtime or another task", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.runtime.runTurn({ ...f.request, prompt: "[fail]" })).status, "failed");
    assert.equal((await f.runtime.runTurn({ ...f.request, sessionId: f.sessionId() })).status, "completed");
    assert.equal((await f.runtime.status()).activeTaskProcesses, 0);
  } finally { await f.runtime.shutdown(); }
});

test("approval is declined and provider model rerouting is reported, not silently accepted", async () => {
  for (const prompt of ["[approval]", "[reroute]"]) {
    const f = await fixture();
    try {
      const result = await f.runtime.runTurn({ ...f.request, prompt }).catch((error: Error) => ({ status: "failed", error: error.message }));
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /decision|rerouted/u);
      if (prompt === "[approval]") assert.equal(JSON.parse(await readFile(path.join(f.cwd, "approval-result.json"), "utf8")).result.decision, "decline");
    } finally { await f.runtime.shutdown(); }
  }
});

test("API-key authentication and unavailable model effort never dispatch inference", async () => {
  for (const [kind, effort] of [["apikey", "high"], ["workspace", "max"]] as const) {
    const f = await fixture(kind);
    try {
      await assert.rejects(f.runtime.runTurn({ ...f.request, effort }), /Sign in|no fallback/u);
      assert.equal((await f.wire()).filter((row) => row.method === "turn/start").length, 0);
    } finally { await f.runtime.shutdown(); }
  }
});

test("interrupt is scoped to the active turn and shutdown prevents late worker startup", async () => {
  const f = await fixture();
  const running = f.runtime.runTurn({ ...f.request, prompt: "[hold]" }).catch((error: Error) => ({ status: "interrupted", error: error.message }));
  for (let i = 0; i < 100; i += 1) {
    if ((await f.wire().catch(() => [])).some((row) => row.method === "turn/start")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await f.runtime.interrupt("fixture"), true);
  assert.equal((await running).status, "interrupted");
  await f.runtime.shutdown();
  await assert.rejects(f.runtime.runTurn(f.request), /stopping/u);
});

test("context assembly never reads cross-task memory, and does not duplicate the task", async () => {
  const store = { listEpisodes: () => { throw new Error("must not read L1"); }, listFacts: () => { throw new Error("must not read L2"); } } as unknown as DurableStore;
  const memory = new MemoryService(store, 12_000);
  const project = { projectId: "p", rootPath: "/fixture", instructions: ["explicit instruction"] } as ProjectRecord;
  const capsule = await memory.compile(project, { taskId: "t", goal: "goal-sentinel" } as TaskRecord);
  assert.match(capsule.text, /explicit instruction/u);
  assert.doesNotMatch(capsule.text, /goal-sentinel|L0|L1|L2/u);
  assert.deepEqual(capsule.sourceRefs, ["project:p"]);
});
