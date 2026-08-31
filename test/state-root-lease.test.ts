import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireStateRootLease } from "../src/state-root-lease.js";

test("one local process owns a KAI Work Host state root at a time", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "kai-work-host-lease-"));
  const first = await acquireStateRootLease(stateRoot);
  try {
    await assert.rejects(
      acquireStateRootLease(stateRoot),
      /already owned by another local process/u,
    );
  } finally {
    await first.close();
  }
  const second = await acquireStateRootLease(stateRoot);
  await second.close();
});
