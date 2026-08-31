import assert from "node:assert/strict";
import test from "node:test";

import { accountRuntimeUsage, countActiveTaskProcesses } from "../src/dsh-runtime.js";

const worker = (alive: boolean, active: boolean) => ({
  isAlive: () => alive,
  hasActiveRun: () => active,
});

test("active process status counts live turns, not idle named-session workers", () => {
  assert.equal(countActiveTaskProcesses([
    worker(true, false), // completed turn; process remains for session follow-up
    worker(false, true), // failed/exited process
    worker(true, true),
  ]), 1);
  assert.equal(countActiveTaskProcesses([worker(true, false)]), 0);
});

test("provider cumulative usage is converted to one per-turn delta", () => {
  const first = accountRuntimeUsage(null, {
    accounting: "cumulative",
    inputTokens: 100,
    cacheReadTokens: 30,
    outputTokens: 10,
  });
  const second = accountRuntimeUsage(first.providerCumulative, {
    accounting: "cumulative",
    inputTokens: 120,
    cacheReadTokens: 80,
    outputTokens: 18,
  });

  assert.equal(first.accounting, "provider-cumulative-delta");
  assert.equal(first.incremental.inputTokens, 100);
  assert.equal(first.incremental.uncachedInputTokens, 100);
  assert.equal(first.incremental.cachedInputTokens, 30);
  assert.equal(first.incremental.outputTokens, 10);
  assert.equal(first.incremental.totalTokens, 140);
  assert.equal(second.incremental.inputTokens, 20);
  assert.equal(second.incremental.cachedInputTokens, 50);
  assert.equal(second.incremental.outputTokens, 8);
  assert.equal(second.incremental.totalTokens, 78);
  assert.equal(first.incremental.totalTokens + second.incremental.totalTokens, 218);
  assert.equal(second.providerCumulative?.totalTokens, 218);
});

test("ordinary per-event usage remains additive because it is not marked cumulative", () => {
  const first = accountRuntimeUsage(null, {
    inputTokens: 100,
    cacheReadTokens: 30,
    outputTokens: 10,
  });
  const second = accountRuntimeUsage(null, {
    inputTokens: 20,
    cacheReadTokens: 50,
    outputTokens: 8,
  });

  assert.equal(first.accounting, "per-event-incremental");
  assert.equal(first.incremental.totalTokens, 140);
  assert.equal(second.incremental.totalTokens, 78);
});
