import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyProcessSnapshot,
  parsePlannerInput,
  planManagedTunnel,
  type ProcessSnapshot,
  type TunnelProcessOptions,
} from "../src/tunnel-process.js";

const options: TunnelProcessOptions = {
  profileName: "kai-work-host",
  profileDir: "C:\\profiles",
  projectRoot: "C:\\KAI-Test\\kai-work-host",
};

test("planner input accepts the UTF-8 BOM emitted by Windows PowerShell", () => {
  const input = parsePlannerInput(`\uFEFF${JSON.stringify({
    processes: [],
    currentTunnelPid: null,
    options,
    restart: true,
    managedReady: false,
  })}`);
  assert.equal(input.options.profileName, "kai-work-host");
  assert.equal(input.restart, true);
});

function tunnel(processId: number, parentProcessId = 1): ProcessSnapshot {
  return {
    processId,
    parentProcessId,
    name: "tunnel-client.exe",
    creationDate: `time-${processId}`,
    commandLine: "C:/bin/tunnel-client.exe run --profile-dir C:/profiles --profile kai-work-host",
  };
}

function launcher(processId: number, parentProcessId: number): ProcessSnapshot {
  return {
    processId,
    parentProcessId,
    name: "powershell.exe",
    creationDate: `time-${processId}`,
    commandLine: "powershell.exe -File C:/KAI-Test/kai-work-host/scripts/start-stdio.ps1",
  };
}

function node(processId: number, parentProcessId: number): ProcessSnapshot {
  return {
    processId,
    parentProcessId,
    name: "node.exe",
    creationDate: `time-${processId}`,
    commandLine: "node C:/KAI-Test/kai-work-host/dist/stdio.js",
  };
}

function currentAndStale(): ProcessSnapshot[] {
  return [tunnel(100), launcher(101, 100), node(102, 101), launcher(201, 999), node(202, 201)];
}

test("single current chain is preserved and restart has one connect action", () => {
  const classification = classifyProcessSnapshot([tunnel(100), launcher(101, 100), node(102, 101)], 100, options);
  assert.deepEqual(classification.currentChains.map((chain) => [chain.launcherPid, chain.nodePid]), [[101, 102]]);
  assert.deepEqual(classification.staleChains, []);
  assert.deepEqual(classification.ambiguousReasons, []);
  assert.equal(planManagedTunnel(classification, { restart: false, managedReady: true }).action, "already-ready");
  assert.deepEqual(planManagedTunnel(classification, { restart: true, managedReady: true }), {
    action: "restart",
    cleanupChains: [],
    stopManagedTunnel: true,
    connect: true,
  });
});

test("orphan launcher and node are stale only with explicit parent evidence", () => {
  const classification = classifyProcessSnapshot([launcher(201, 999), node(202, 201)], null, options);
  assert.deepEqual(classification.currentChains, []);
  assert.deepEqual(classification.staleChains.map((chain) => [chain.launcherPid, chain.nodePid]), [[201, 202]]);
  assert.deepEqual(classification.ambiguousReasons, []);
  assert.equal(planManagedTunnel(classification, { restart: false, managedReady: false }).action, "fail-closed");
  const restart = planManagedTunnel(classification, { restart: true, managedReady: false });
  assert.equal(restart.action, "connect");
  assert.deepEqual(restart.cleanupChains.map((chain) => [chain.launcherPid, chain.nodePid]), [[201, 202]]);
});

test("explicit stale cleanup is planned while the current chain is preserved", () => {
  const classification = classifyProcessSnapshot(currentAndStale(), 100, options);
  assert.deepEqual(classification.currentChains.map((chain) => [chain.launcherPid, chain.nodePid]), [[101, 102]]);
  assert.deepEqual(classification.staleChains.map((chain) => [chain.launcherPid, chain.nodePid]), [[201, 202]]);
  const restart = planManagedTunnel(classification, { restart: true, managedReady: true });
  assert.equal(restart.action, "restart");
  assert.equal(restart.stopManagedTunnel, true);
  assert.deepEqual(restart.cleanupChains.map((chain) => [chain.launcherPid, chain.nodePid]), [[201, 202]]);
});

test("multiple current chains fail closed without cleanup", () => {
  const classification = classifyProcessSnapshot([
    tunnel(100), launcher(101, 100), node(102, 101), launcher(103, 100), node(104, 103),
  ], 100, options);
  assert.ok(classification.ambiguousReasons.some((reason) => reason.includes("multiple current")));
  const plan = planManagedTunnel(classification, { restart: true, managedReady: true });
  assert.equal(plan.action, "fail-closed");
  assert.deepEqual(plan.cleanupChains, []);
  assert.equal(plan.stopManagedTunnel, false);
  assert.equal(plan.connect, false);
});
