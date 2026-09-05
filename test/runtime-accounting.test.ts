import assert from "node:assert/strict";
import test from "node:test";
import { codexUsage, usageDelta } from "../src/codex-runtime.js";
import { countActiveTaskProcesses } from "../src/worker-runtime.js";
import { withCumulativeUsage } from "../src/task-orchestrator.js";
import type { TaskRecord, RunUsageSummary } from "../src/types.js";

test("a missing historical usage record never becomes a partial total labelled cumulative", () => {
  const usage = { incremental: codexUsage({ inputTokens: 3, outputTokens: 1, totalTokens: 4 }), cumulative: null } as RunUsageSummary;
  const task = { turns: [{ runId: "old", usage: { incremental: null } }, { runId: "new" }] } as TaskRecord;
  assert.equal(withCumulativeUsage(task, "new", usage).cumulative, null);
});

test("active process count excludes idle and exited workers", () => {
  assert.equal(countActiveTaskProcesses([
    { isAlive: () => true, hasActiveRun: () => true },
    { isAlive: () => true, hasActiveRun: () => false },
    { isAlive: () => false, hasActiveRun: () => true },
  ]), 1);
});

test("Codex inclusive input is split without charging cached tokens twice", () => {
  const first = codexUsage({ inputTokens: 100, cachedInputTokens: 30, outputTokens: 10, totalTokens: 110 });
  const last = codexUsage({ inputTokens: 240, cachedInputTokens: 80, outputTokens: 20, totalTokens: 260 });
  assert.equal(first.inputTokens, 70);
  assert.equal(first.cachedInputTokens, 30);
  assert.equal(first.totalTokens, 110);
  assert.equal(usageDelta(last, first)?.inputTokens, 90);
  assert.equal(usageDelta(last, first)?.cachedInputTokens, 50);
  assert.equal(usageDelta(last, first)?.totalTokens, 150);
  assert.equal(usageDelta(last, last)?.totalTokens, 0);
  assert.equal(usageDelta(first, last), null, "reset snapshots are not fabricated as current-turn usage");
});
