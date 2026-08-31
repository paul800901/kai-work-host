import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { countActiveTaskProcesses } from "../src/dsh-runtime.js";
import type {
  RuntimeEventSummary,
  WorkerRunRequest,
  WorkerRunResult,
  WorkerRuntimeControl,
  WorkerRuntimeStatus,
} from "../src/dsh-runtime.js";
import { HostError } from "../src/errors.js";
import { CompatibilityService } from "../src/compat/compatibility-service.js";
import { CompatibilityStateStore } from "../src/compat/bridge-state.js";
import { DurableStore } from "../src/durable-store.js";
import { HostHttpServer } from "../src/http-server.js";
import { MemoryService } from "../src/memory.js";
import { ProjectRegistry } from "../src/project-registry.js";
import { effectiveContextCharacterCap, TaskOrchestrator } from "../src/task-orchestrator.js";
import type {
  HostConfig,
  PermissionProfile,
  RuntimeEffort,
  TaskStatus,
  TokenUsageBreakdown,
} from "../src/types.js";

const terminal = new Set<TaskStatus>(["completed", "failed", "interrupted", "needs_resume"]);

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function waitForTask(
  orchestrator: TaskOrchestrator,
  taskId: string,
  predicate: (task: Record<string, unknown>) => boolean,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let afterSequence = 0;
  while (Date.now() < deadline) {
    const update = record(await orchestrator.wait(taskId, afterSequence, 300));
    const task = record(update.task);
    afterSequence = typeof update.nextSequence === "number" ? update.nextSequence : afterSequence;
    if (predicate(task)) return update;
  }
  assert.fail(`Timed out waiting for task ${taskId}: ${JSON.stringify(await orchestrator.receipt(taskId))}`);
}

async function waitForTerminal(
  client: Client,
  jobId: string,
  webSessionId: string,
  timeoutMs = 45_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let latest: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const polled = await client.callTool({
      name: "terminal_status",
      arguments: { job_id: jobId, web_session_id: webSessionId },
    });
    assert.equal(polled.isError, undefined);
    latest = record(polled.structuredContent);
    if (latest.status === "completed") return latest;
    if (latest.status !== "running") {
      assert.fail(`Terminal job ${jobId} ended as ${String(latest.status)}: ${JSON.stringify(latest)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for terminal job ${jobId}: ${JSON.stringify(latest)}`);
}

function taskIdFrom(result: Record<string, unknown>): string {
  if (typeof result.taskId !== "string") assert.fail("Task result did not contain a taskId");
  return result.taskId;
}

function currentInstruction(prompt: string): string {
  const taskStart = prompt.lastIndexOf("<task>");
  if (taskStart >= 0) return prompt.slice(taskStart);
  const authorizationUpdateEnd = prompt.lastIndexOf("</authorization_update>");
  if (authorizationUpdateEnd >= 0) return prompt.slice(authorizationUpdateEnd + "</authorization_update>".length);
  return prompt;
}

class FakeDshRuntime implements WorkerRuntimeControl {
  readonly prompts: Array<{
    taskId: string;
    sessionId: string;
    model: string;
    effort: RuntimeEffort;
    fast: boolean;
    permissionProfile: PermissionProfile;
    networkAccess: boolean;
    timeoutMs: number;
    prompt: string;
  }> = [];
  private readonly held = new Map<string, { reject: (error: Error) => void }>();

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  status(): Promise<WorkerRuntimeStatus> {
    return Promise.resolve({
      engine: "dsh-sdk-jsonrpc",
      profile: {
        ready: true,
        dshVersion: "0.1.1-rc.2",
        dshCommit: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
        profileDir: "test-profile",
        profileHash: "test-hash",
        credentialConfigured: true,
        credentialKind: "grant",
      },
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      effort: "high",
      activeTaskProcesses: this.held.size,
      codexProductRuntimeUsed: false,
      networkIsolation: "model-policy-only",
    });
  }

  async runTurn(request: WorkerRunRequest): Promise<WorkerRunResult> {
    this.prompts.push({
      taskId: request.taskId,
      sessionId: request.sessionId,
      model: request.model,
      effort: request.effort,
      fast: request.fast,
      permissionProfile: request.permissionProfile,
      networkAccess: request.networkAccess,
      timeoutMs: request.timeoutMs,
      prompt: request.prompt,
    });
    await request.onEvent(event("turn/start", 1, { turn: this.prompts.length }));
    const instruction = currentInstruction(request.prompt);
    if (instruction.includes("[crash]")) {
      throw new HostError("runtime_exited", "Simulated DSH process loss");
    }
    if (instruction.includes("[hold]")) {
      return new Promise<WorkerRunResult>((_resolve, reject) => {
        this.held.set(request.taskId, { reject });
      });
    }
    await request.onEvent(event("request/context", 2, {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      contextWindow: 272_000,
    }));
    await request.onEvent(event("tool/call", 3, {
      turn: 1,
      step: 1,
      callId: "call-1",
      name: "read_file",
      argumentsDigest: "digest-only",
    }));
    await request.onEvent(event("tool/result", 4, {
      turn: 1,
      step: 1,
      callId: "call-1",
      tool: "read_file",
      error: null,
    }));
    const finalMessage = this.prompts.length === 1
      ? "Fake Luna completed the requested work."
      : "Fake Luna completed the concise follow-up.";
    await request.onEvent(event("assistant/message", 5, {
      turn: 1,
      step: 1,
      text: finalMessage,
      usage: { inputTokens: 120, cacheReadTokens: 80, outputTokens: 12, reasoningTokens: 4 },
    }));
    await request.onEvent(event("turn/end", 6, { turn: 1, reason: { kind: "completed" } }));
    const incremental: TokenUsageBreakdown = {
      inputTokens: 120,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 0,
      outputTokens: 12,
      reasoningOutputTokens: 4,
      totalTokens: 212,
    };
    return {
      messageId: `message-${this.prompts.length}`,
      status: "completed",
      reason: { kind: "completed" },
      finalMessage,
      error: null,
      usage: { source: "runtime", cumulative: null, incremental, modelContextWindow: 272_000 },
      eventSummaries: [event("turn/end", 6, { turn: 1, reason: { kind: "completed" } })],
      validation: ["read_file: completed"],
      diffText: "diff --git a/example.txt b/example.txt\n",
    };
  }

  interrupt(taskId: string): Promise<boolean> {
    const held = this.held.get(taskId);
    if (held === undefined) return Promise.resolve(false);
    this.held.delete(taskId);
    held.reject(new HostError("runtime_interrupted", "Simulated interrupt"));
    return Promise.resolve(true);
  }

  probe(): Promise<Record<string, unknown>> {
    return Promise.resolve({ ok: true, paidModelInvoked: false });
  }

  shutdown(): Promise<void> {
    for (const held of this.held.values()) held.reject(new HostError("runtime_interrupted", "Shutdown"));
    this.held.clear();
    return Promise.resolve();
  }
}

function event(type: string, sequence: number, data: Record<string, unknown>): RuntimeEventSummary {
  return { type, sequence, at: new Date().toISOString(), data };
}

test("legacy WebGPT bindings receive safe runtime-selection defaults on load", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "kai-work-host-compat-"));
  const compatibilityRoot = path.join(stateRoot, "compatibility");
  await mkdir(compatibilityRoot, { recursive: true });
  const legacyBinding = {
    schemaVersion: 1,
    webSessionId: "legacy-webgpt-session",
    projectId: "legacy-project",
    taskId: null,
    workspacePath: "D:\\legacy-project",
    permissionMode: "read-only",
    lastJobId: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
  await writeFile(path.join(compatibilityRoot, "state.json"), `${JSON.stringify({
    schemaVersion: 1,
    sessions: { "legacy-webgpt-session": legacyBinding },
    jobs: {},
    initializations: {
      legacy: {
        schemaVersion: 1,
        initializationId: "legacy",
        webSessionId: "legacy-webgpt-session",
        requestId: "legacy-init-request",
        requestFingerprint: "legacy-fingerprint",
        binding: legacyBinding,
        createdAt: "2026-08-30T00:00:00.000Z",
      },
    },
    startReservations: {},
  })}\n`, "utf8");

  const state = new CompatibilityStateStore(stateRoot, {
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    fast: true,
    timeoutMs: 30_000,
  });
  const binding = state.binding("legacy-webgpt-session");
  assert.equal(binding?.networkAccess, false);
  assert.equal(binding?.model, "gpt-5.6-luna");
  assert.equal(binding?.reasoningEffort, "high");
  assert.equal(binding?.fast, true);
  assert.equal(binding?.timeoutMs, 30_000);
  const initialization = state.initializationByRequest("legacy-webgpt-session", "legacy-init-request");
  assert.equal(initialization?.binding.model, "gpt-5.6-luna");
  assert.equal(initialization?.binding.reasoningEffort, "high");
});

test("WebGPT fast mode selects compact KAI context without claiming a provider fast tier", () => {
  assert.equal(effectiveContextCharacterCap(12_000, true), 8_000);
  assert.equal(effectiveContextCharacterCap(12_000, false), 12_000);
  assert.equal(effectiveContextCharacterCap(6_000, true), 6_000);
});

test("durable WebGPT-to-DSH-Luna lifecycle keeps one session, thin follow-ups, interruption, and no-replay recovery", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kai-work-host-"));
  const stateRoot = path.join(root, "state");
  const projectRoot = path.join(root, "project");
  const otherProjectRoot = path.join(root, "other-project");
  await Promise.all([mkdir(projectRoot, { recursive: true }), mkdir(otherProjectRoot, { recursive: true })]);

  const config: HostConfig = {
    bindHost: "127.0.0.1",
    port: 8787,
    stateRoot,
    dshRoot: path.join(root, "dsh-install"),
    dshHome: path.join(stateRoot, "dsh"),
    dshCliPath: path.join(root, "dsh-install", "apps", "cli", "lib", "bin.js"),
    dshSdkPluginRoot: path.join(root, "dsh-install", "packages", "sdk", "server"),
    dshProfile: "kai-work-host",
    dshProvider: "openai-codex",
    workerModel: "gpt-5.6-luna",
    workerEffort: "high",
    executionProfile: "lean",
    workerMaxOutputTokens: 32_768,
    runtimeStartupTimeoutMs: 5_000,
    runtimeTurnTimeoutMs: 30_000,
    bearerToken: null,
    maxContextCharacters: 8_000,
    maxEventBatch: 100,
  };
  const store = new DurableStore(stateRoot);
  const projects = new ProjectRegistry(store);
  const memory = new MemoryService(store, config.maxContextCharacters);
  const runtime = new FakeDshRuntime();
  const orchestrator = new TaskOrchestrator(config, store, projects, memory, runtime);

  try {
    await orchestrator.initialize();
    const project = await projects.register({
      projectId: "fixture_project",
      name: "Fixture Project",
      rootPath: projectRoot,
      trust: "development",
      allowedPermissionProfiles: ["read-only", "workspace-write"],
      defaultPermissionProfile: "workspace-write",
      networkAccess: false,
      instructions: ["Do not touch files outside this fixture root."],
    });
    await assert.rejects(
      projects.register({
        projectId: "fixture_project",
        name: "Rebound Project",
        rootPath: otherProjectRoot,
        trust: "development",
        allowedPermissionProfiles: ["workspace-write"],
        defaultPermissionProfile: "workspace-write",
        networkAccess: false,
        instructions: [],
      }),
      /already bound/u,
    );
    await assert.rejects(
      memory.recordFact({
        projectId: project.projectId,
        kind: "constraint",
        statement: "Evidence is mandatory.",
        evidenceRefs: [],
        status: "active",
      }),
      /evidence reference/u,
    );
    await memory.recordFact({
      projectId: project.projectId,
      factId: "fact-evidence",
      kind: "constraint",
      statement: "Use only the fixture project.",
      evidenceRefs: ["project:fixture_project"],
      status: "active",
    });
    await assert.rejects(
      orchestrator.startTask({
        requestId: "oversized-task-001",
        projectId: project.projectId,
        goal: "x".repeat(12_001),
        acceptanceCriteria: [],
        constraints: [],
        networkAccess: false,
      }),
      /exceed 12000 characters/u,
    );

    const normal = await orchestrator.startTask({
      requestId: "start-normal-001",
      projectId: project.projectId,
      goal: "Implement and validate a small change.",
      acceptanceCriteria: ["A receipt exists."],
      constraints: ["Do not use a browser."],
      networkAccess: false,
    });
    const normalTaskId = taskIdFrom(normal);
    const normalDone = await waitForTask(orchestrator, normalTaskId, (task) => task.status === "completed");
    assert.equal(record(normalDone.task).lastAgentMessage, "Fake Luna completed the requested work.");
    assert.equal((await store.listEpisodes(project.projectId, 20)).length, 1);
    const completedRuntime = record((await orchestrator.hostStatus()).runtime);
    assert.equal(completedRuntime.activeTaskProcesses, 0);
    const duplicate = await orchestrator.startTask({
      requestId: "start-normal-001",
      projectId: project.projectId,
      goal: "This duplicate must not run.",
      acceptanceCriteria: [],
      constraints: [],
      networkAccess: false,
    });
    assert.equal(duplicate.taskId, normalTaskId);
    assert.equal(duplicate.duplicate, true);

    await orchestrator.followup({
      requestId: "follow-normal-001",
      taskId: normalTaskId,
      message: "Run one concise follow-up verification.",
      mode: "new_turn",
    });
    await waitForTask(
      orchestrator,
      normalTaskId,
      (task) => task.status === "completed" && Number(task.eventSequence) > Number(record(normalDone.task).eventSequence),
    );
    assert.equal((await store.listEpisodes(project.projectId, 20)).length, 2);
    const taskPrompts = runtime.prompts.filter((entry) => entry.taskId === normalTaskId);
    assert.equal(taskPrompts.length, 2);
    assert.equal(taskPrompts[0]?.sessionId, taskPrompts[1]?.sessionId);
    assert.match(taskPrompts[0]?.prompt ?? "", /<kai_context/u);
    assert.doesNotMatch(taskPrompts[1]?.prompt ?? "", /<kai_context/u);

    const normalReceipt = record(await orchestrator.receipt(normalTaskId));
    const turns = normalReceipt.turns as Array<Record<string, unknown>>;
    assert.equal(turns.length, 2);
    for (const turn of turns) {
      assert.equal(turn.status, "completed");
      assert.ok(existsSync(String(turn.receiptArtifact)));
      assert.ok(existsSync(String(turn.diffArtifact)));
      assert.equal(record(turn.runtimeBinding).engine, "dsh-sdk-jsonrpc");
    }
    const secondUsage = record(turns[1]?.usage);
    assert.equal(record(secondUsage.incremental).inputTokens, 120);
    assert.equal(record(secondUsage.incremental).uncachedInputTokens, 120);
    assert.equal(record(secondUsage.incremental).cachedInputTokens, 80);
    assert.equal(record(secondUsage.incremental).outputTokens, 12);
    assert.equal(record(secondUsage.incremental).totalTokens, 212);
    assert.equal(record(secondUsage.cumulative).totalTokens, 424);

    const held = await orchestrator.startTask({
      requestId: "start-held-task-001",
      projectId: project.projectId,
      goal: "[hold] Remain active until interrupted.",
      acceptanceCriteria: [],
      constraints: [],
      networkAccess: false,
    });
    const heldTaskId = taskIdFrom(held);
    await waitForTask(orchestrator, heldTaskId, (task) => task.status === "running");
    const liveRuntime = record((await orchestrator.hostStatus()).runtime);
    assert.equal(liveRuntime.activeTaskProcesses, 1);
    await assert.rejects(
      orchestrator.followup({
        requestId: "busy-followup-001",
        taskId: heldTaskId,
        message: "Do not queue this.",
        mode: "auto",
      }),
      /still active/u,
    );
    await orchestrator.interrupt({
      requestId: "interrupt-held-001",
      taskId: heldTaskId,
      reason: "Test explicit interruption.",
    });
    await waitForTask(orchestrator, heldTaskId, (task) => task.status === "interrupted");
    assert.equal((await store.listEpisodes(project.projectId, 20)).length, 3);
    const interruptedRuntime = record((await orchestrator.hostStatus()).runtime);
    assert.equal(interruptedRuntime.activeTaskProcesses, 0);

    const crashed = await orchestrator.startTask({
      requestId: "start-crash-task-001",
      projectId: project.projectId,
      goal: "[crash] Simulate DSH runtime loss.",
      acceptanceCriteria: [],
      constraints: [],
      networkAccess: false,
    });
    const crashedTaskId = taskIdFrom(crashed);
    const crashUpdate = await waitForTask(orchestrator, crashedTaskId, (task) => task.status === "needs_resume");
    assert.equal(record(crashUpdate.needsAction).kind, "recovery");
    const crashedReceipt = record(await orchestrator.receipt(crashedTaskId));
    const crashedTurn = record((crashedReceipt.turns as unknown[])[0]);
    assert.equal(crashedTurn.status, "needs_resume");
    assert.match(String(crashedTurn.error), /No model turn was replayed/u);
    const failedRuntime = record((await orchestrator.hostStatus()).runtime);
    assert.equal(failedRuntime.activeTaskProcesses, 0);
    const recovery = await orchestrator.recover({ requestId: "recover-crash-001", taskId: crashedTaskId });
    assert.equal(recovery.replayed, false);
    assert.equal(recovery.resumableNamedSession, true);
    await orchestrator.followup({
      requestId: "continue-crash-001",
      taskId: crashedTaskId,
      message: "Continue safely after inspecting current state.",
      mode: "new_turn",
    });
    await waitForTask(orchestrator, crashedTaskId, (task) => task.status === "completed");
    assert.equal((await store.listEpisodes(project.projectId, 20)).length, 4);
    const recoveredPrompts = runtime.prompts.filter((entry) => entry.taskId === crashedTaskId);
    assert.equal(recoveredPrompts.length, 2);
    assert.equal(recoveredPrompts[0]?.sessionId, recoveredPrompts[1]?.sessionId);
    assert.match(recoveredPrompts[1]?.prompt ?? "", /prior process ended with an uncertain turn/u);

    const episodes = await store.listEpisodes(project.projectId, 20);
    assert.ok(episodes.length >= 4);
    assert.equal(new Set(episodes.map((episode) => episode.episodeId)).size, episodes.length);
    assert.ok(episodes.every((episode) => episode.eventRange.to >= 1));

    const status = await orchestrator.hostStatus();
    assert.equal(status.codexProductRuntimeUsed, false);
    assert.equal(record(status.runtime).engine, "dsh-sdk-jsonrpc");

    const recoveryCompatibility = new CompatibilityService(orchestrator, config);
    const recoveryWebSessionId = "webgpt-start-reservation-recovery";
    await recoveryCompatibility.initialize(recoveryWebSessionId, {
      workspacePath: projectRoot,
      permissionMode: "workspace-write",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      fast: true,
      timeoutMs: 30_000,
      networkAccess: false,
      requestId: "init-reservation-recovery-001",
    });
    const originalAttachStart = recoveryCompatibility.state.attachStart.bind(recoveryCompatibility.state);
    let injectAttachFailure = true;
    recoveryCompatibility.state.attachStart = (reservationId, job) => {
      if (injectAttachFailure) {
        injectAttachFailure = false;
        throw new Error("Injected compatibility attach failure");
      }
      return originalAttachStart(reservationId, job);
    };
    const recoveryPrompt = "Verify durable compatibility start reservation recovery.";
    await assert.rejects(
      recoveryCompatibility.start({
        webSessionId: recoveryWebSessionId,
        prompt: recoveryPrompt,
        requestId: "start-reservation-recovery-001",
      }),
      /Injected compatibility attach failure/u,
    );
    const reservedTask = (await store.listTasks()).find(
      (task) => task.requestLedger["start:start-reservation-recovery-001"] !== undefined,
    );
    assert.ok(reservedTask);
    await waitForTask(orchestrator, reservedTask.taskId, (task) => terminal.has(String(task.status) as TaskStatus));
    const recoveryPromptCount = runtime.prompts.filter((entry) => entry.taskId === reservedTask.taskId).length;
    assert.equal(recoveryPromptCount, 1);
    await assert.rejects(
      recoveryCompatibility.start({
        webSessionId: recoveryWebSessionId,
        prompt: "A different instruction must not attach to the reserved run.",
        requestId: "start-reservation-recovery-001",
      }),
      /already used with different Luna instructions/u,
    );
    await assert.rejects(
      recoveryCompatibility.start({
        webSessionId: recoveryWebSessionId,
        prompt: "A newer instruction must wait until the reserved run is attached.",
        requestId: "start-reservation-newer-001",
      }),
      /unfinished request_id start-reservation-recovery-001/u,
    );
    const recoveredCompatibilityStart = await recoveryCompatibility.start({
      webSessionId: recoveryWebSessionId,
      prompt: recoveryPrompt,
      requestId: "start-reservation-recovery-001",
    });
    assert.equal(recoveredCompatibilityStart.job.taskId, reservedTask.taskId);
    assert.equal(runtime.prompts.filter((entry) => entry.taskId === reservedTask.taskId).length, 1);
    assert.equal(
      recoveryCompatibility.state.startReservationByRequest(
        recoveryWebSessionId,
        "start-reservation-recovery-001",
      )?.state,
      "attached",
    );
    await waitForTask(orchestrator, reservedTask.taskId, (task) => terminal.has(String(task.status) as TaskStatus));

    injectAttachFailure = true;
    const followupRecoveryPrompt = "[hold] Verify durable follow-up reservation recovery while the turn is active.";
    await assert.rejects(
      recoveryCompatibility.start({
        webSessionId: recoveryWebSessionId,
        prompt: followupRecoveryPrompt,
        requestId: "followup-reservation-recovery-001",
        reasoningEffort: "medium",
        fast: false,
      }),
      /Injected compatibility attach failure/u,
    );
    const recoveredCompatibilityFollowup = await recoveryCompatibility.start({
      webSessionId: recoveryWebSessionId,
      prompt: followupRecoveryPrompt,
      requestId: "followup-reservation-recovery-001",
      reasoningEffort: "medium",
      fast: false,
    });
    assert.equal(recoveredCompatibilityFollowup.job.taskId, reservedTask.taskId);
    assert.equal(
      recoveryCompatibility.state.startReservationByRequest(
        recoveryWebSessionId,
        "followup-reservation-recovery-001",
      )?.state,
      "attached",
    );
    await waitForTask(orchestrator, reservedTask.taskId, (task) => task.status === "running");
    await orchestrator.interrupt({
      requestId: "interrupt-followup-reservation-recovery-001",
      taskId: reservedTask.taskId,
      reason: "Finish follow-up reservation recovery test.",
    });
    await waitForTask(orchestrator, reservedTask.taskId, (task) => task.status === "interrupted");

    const httpServer = new HostHttpServer({ ...config, port: 0 }, orchestrator);
    await httpServer.listen();
    const address = httpServer.address();
    assert.ok(address);
    const health = await fetch(`http://${address.host}:${address.port}/healthz`);
    assert.equal(health.status, 200);
    const transport = new StreamableHTTPClientTransport(new URL(`http://${address.host}:${address.port}/mcp`));
    const client = new Client({ name: "kai-work-host-test", version: "0.3.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 19);
      const privateRestore = tools.tools.find((tool) => tool.name === "file_image_preview_restore");
      assert.ok(privateRestore);
      assert.equal(privateRestore._meta?.["openai/visibility"], "private");
      assert.deepEqual(privateRestore._meta?.ui, { visibility: ["app"] });
      const publicNames = tools.tools
        .filter((tool) => tool._meta?.["openai/visibility"] !== "private")
        .map((tool) => tool.name)
        .sort();
      assert.deepEqual(publicNames, [
        "codexluna_init",
        "codexluna_start",
        "codexluna_status",
        "codexluna_cancel",
        "codexluna_session",
        "file_read",
        "file_import_attachment",
        "file_image_preview",
        "file_list",
        "file_search",
        "file_write",
        "file_create_directory",
        "file_delete_directory",
        "terminal_start",
        "terminal_exec",
        "terminal_status",
        "terminal_write_stdin",
        "terminal_cancel",
      ].sort());
      const initTool = tools.tools.find((tool) => tool.name === "codexluna_init");
      assert.ok(initTool);
      const initSchema = record(initTool.inputSchema);
      const initProperties = record(initSchema.properties);
      assert.ok("request_id" in initProperties);
      assert.ok(Array.isArray(initSchema.required) && initSchema.required.includes("request_id"));
      assert.ok(Array.isArray(initSchema.required) && initSchema.required.includes("permission_mode"));
      const startTool = tools.tools.find((tool) => tool.name === "codexluna_start");
      assert.ok(startTool);
      const startSchema = record(startTool.inputSchema);
      assert.ok(Array.isArray(startSchema.required) && startSchema.required.includes("request_id"));

      const webSessionId = "webgpt-test-session-001";
      const initializationArguments = {
        web_session_id: webSessionId,
        request_id: "init-fixture-001",
        workspace_path: projectRoot,
        model: "gpt-5.6-luna",
        reasoning_effort: "high",
        fast: true,
        permission_mode: "workspace-write",
        network_access: false,
        timeout_ms: 30_000,
      };
      const initialized = await client.callTool({
        name: "codexluna_init",
        arguments: initializationArguments,
      });
      assert.equal(initialized.isError, undefined);
      const initializedData = record(initialized.structuredContent);
      assert.equal(initializedData.web_session_id, webSessionId);
      assert.equal(initializedData.request_id, "init-fixture-001");
      assert.deepEqual(record(initializedData.kai_memory), {
        l0: true,
        l1: true,
        l2: true,
        project_id: "fixture_project",
      });
      const duplicateInitialization = await client.callTool({
        name: "codexluna_init",
        arguments: initializationArguments,
      });
      assert.equal(duplicateInitialization.isError, undefined);
      assert.deepEqual(record(duplicateInitialization.structuredContent), initializedData);
      const restoredInitialization = await client.callTool({
        name: "codexluna_init",
        arguments: {
          ...initializationArguments,
          request_id: "init-fixture-restore-001",
        },
      });
      assert.equal(restoredInitialization.isError, undefined);
      const restoredInitializationData = record(restoredInitialization.structuredContent);
      assert.equal(restoredInitializationData.request_id, "init-fixture-restore-001");
      assert.equal(restoredInitializationData.workspace_path, initializedData.workspace_path);
      assert.equal(restoredInitializationData.permission_mode, initializedData.permission_mode);
      const conflictingInitialization = await client.callTool({
        name: "codexluna_init",
        arguments: {
          ...initializationArguments,
          timeout_ms: 20_000,
        },
      });
      assert.equal(conflictingInitialization.isError, true);
      assert.match(
        JSON.stringify(conflictingInitialization.content),
        /already used with different initialization settings/u,
      );

      const outsideSecret = path.join(otherProjectRoot, "outside-secret.txt");
      const linkedOutside = path.join(projectRoot, "linked-outside");
      await writeFile(outsideSecret, "MUST_NOT_ESCAPE", "utf8");
      let linkCreated = false;
      try {
        await symlink(otherProjectRoot, linkedOutside, process.platform === "win32" ? "junction" : "dir");
        linkCreated = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
      if (linkCreated) {
        const escapedRead = await client.callTool({
          name: "file_read",
          arguments: {
            web_session_id: webSessionId,
            path: "linked-outside/outside-secret.txt",
            workspace_path: projectRoot,
            permission_mode: "workspace-write",
          },
        });
        assert.equal(escapedRead.isError, true);
      }

      const listed = await client.callTool({
        name: "file_list",
        arguments: {
          web_session_id: webSessionId,
          path: ".",
          workspace_path: projectRoot,
          permission_mode: "workspace-write",
        },
      });
      assert.equal(listed.isError, undefined);
      assert.equal(Array.isArray(record(listed.structuredContent).entries), true);

      const terminalResult = await client.callTool({
        name: "terminal_exec",
        arguments: {
          web_session_id: webSessionId,
          command: process.platform === "win32" ? "Write-Output 'KAI_TERMINAL_OK'" : "printf 'KAI_TERMINAL_OK\\n'",
          cwd: ".",
          workspace_path: projectRoot,
          permission_mode: "workspace-write",
          request_id: "terminal-fixture-001",
          wait_timeout_ms: 500,
        },
      });
      assert.equal(terminalResult.isError, undefined);
      const terminalData = record(terminalResult.structuredContent);
      const terminalCompleted = terminalData.status === "completed"
        ? terminalData
        : await waitForTerminal(client, String(terminalData.job_id), webSessionId);
      assert.match(String(terminalCompleted.output), /KAI_TERMINAL_OK/u);
      const duplicateTerminal = await client.callTool({
        name: "terminal_exec",
        arguments: {
          web_session_id: webSessionId,
          command: process.platform === "win32" ? "Write-Output 'KAI_TERMINAL_OK'" : "printf 'KAI_TERMINAL_OK\\n'",
          cwd: ".",
          workspace_path: projectRoot,
          permission_mode: "workspace-write",
          request_id: "terminal-fixture-001",
          wait_timeout_ms: 0,
        },
      });
      assert.equal(duplicateTerminal.isError, undefined);
      assert.equal(
        record(duplicateTerminal.structuredContent).job_id,
        record(terminalResult.structuredContent).job_id,
      );
      const otherWebSessionId = "webgpt-test-session-002";
      const otherInitialized = await client.callTool({
        name: "codexluna_init",
        arguments: {
          web_session_id: otherWebSessionId,
          request_id: "init-fixture-002",
          workspace_path: projectRoot,
          model: "gpt-5.6-luna",
          reasoning_effort: "low",
          fast: false,
          permission_mode: "read-only",
          network_access: false,
          timeout_ms: 30_000,
        },
      });
      assert.equal(otherInitialized.isError, undefined);
      assert.equal(record(otherInitialized.structuredContent).reasoning_effort, "low");
      assert.equal(record(otherInitialized.structuredContent).fast, false);
      const foreignTerminalStatus = await client.callTool({
        name: "terminal_status",
        arguments: {
          web_session_id: otherWebSessionId,
          job_id: record(terminalResult.structuredContent).job_id,
        },
      });
      assert.equal(foreignTerminalStatus.isError, true);

      const blockedNetworkExpansion = await client.callTool({
        name: "codexluna_start",
        arguments: {
          web_session_id: webSessionId,
          request_id: "network-not-authorized-001",
          network_access: true,
          prompt: "This must be rejected before Luna starts.",
        },
      });
      assert.equal(blockedNetworkExpansion.isError, true);

      const mismatchedWorkspace = await client.callTool({
        name: "codexluna_start",
        arguments: {
          web_session_id: webSessionId,
          request_id: "wrong-workspace-001",
          workspace_path: otherProjectRoot,
          prompt: "This must not run in either workspace.",
        },
      });
      assert.equal(mismatchedWorkspace.isError, true);

      const started = await client.callTool({
        name: "codexluna_start",
        arguments: {
          web_session_id: webSessionId,
          request_id: "luna-fixture-turn-001",
          prompt: "Inspect the fixture project and report a concise verification.",
        },
      });
      assert.equal(started.isError, undefined);
      const jobId = String(record(started.structuredContent).job_id);
      let lunaStatus: Record<string, unknown> | null = null;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const polled = await client.callTool({
          name: "codexluna_status",
          arguments: { job_id: jobId, web_session_id: webSessionId },
        });
        assert.equal(polled.isError, undefined);
        lunaStatus = record(polled.structuredContent);
        if (lunaStatus.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(lunaStatus?.status, "completed");
      assert.equal(typeof lunaStatus?.luna_session_id, "string");
      assert.equal(lunaStatus?.permission_mode, "workspace-write");
      assert.equal(lunaStatus?.network_access, false);
      assert.equal(lunaStatus?.timeout_ms, 30_000);
      assert.equal(lunaStatus?.model, "gpt-5.6-luna");
      assert.equal(lunaStatus?.reasoning_effort, "high");
      assert.equal(lunaStatus?.fast, true);
      const firstRuntimePrompt = runtime.prompts.find((entry) => entry.sessionId === lunaStatus?.luna_session_id);
      assert.equal(firstRuntimePrompt?.model, "gpt-5.6-luna");
      assert.equal(firstRuntimePrompt?.effort, "high");
      assert.equal(firstRuntimePrompt?.fast, true);
      const foreignLunaStatus = await client.callTool({
        name: "codexluna_status",
        arguments: { job_id: jobId, web_session_id: otherWebSessionId },
      });
      assert.equal(foreignLunaStatus.isError, true);

      const promptCountBeforeBlockedSelection = runtime.prompts.length;
      const blockedEffort = await client.callTool({
        name: "codexluna_start",
        arguments: {
          web_session_id: webSessionId,
          request_id: "effort-above-ceiling-001",
          reasoning_effort: "xhigh",
          prompt: "This must be rejected before Luna starts.",
        },
      });
      assert.equal(blockedEffort.isError, true);
      const blockedModel = await client.callTool({
        name: "codexluna_start",
        arguments: {
          web_session_id: webSessionId,
          request_id: "non-luna-model-001",
          model: "gpt-5.5",
          prompt: "This must be rejected before Luna starts.",
        },
      });
      assert.equal(blockedModel.isError, true);
      assert.equal(runtime.prompts.length, promptCountBeforeBlockedSelection);
      const bindingAfterBlockedSelection = await client.callTool({
        name: "codexluna_session",
        arguments: { web_session_id: webSessionId },
      });
      assert.equal(bindingAfterBlockedSelection.isError, undefined);
      const unpollutedBinding = record(record(bindingAfterBlockedSelection.structuredContent).binding);
      assert.equal(unpollutedBinding.model, "gpt-5.6-luna");
      assert.equal(unpollutedBinding.reasoning_effort, "high");
      assert.equal(unpollutedBinding.fast, true);

      const duplicateStarted = await client.callTool({
        name: "codexluna_start",
        arguments: {
          web_session_id: webSessionId,
          request_id: "luna-fixture-turn-001",
          prompt: "Inspect the fixture project and report a concise verification.",
        },
      });
      assert.equal(duplicateStarted.isError, undefined);
      assert.equal(record(duplicateStarted.structuredContent).job_id, jobId);

      const durableLunaSessionId = String(lunaStatus?.luna_session_id);
      const readOnlyStarted = await client.callTool({
        name: "codexluna_start",
        arguments: {
          web_session_id: webSessionId,
          permission_mode: "read-only",
          reasoning_effort: "medium",
          fast: false,
          request_id: "luna-fixture-turn-002",
          timeout_ms: 5_000,
          prompt: "Continue in the same durable Luna session using read-only access.",
        },
      });
      assert.equal(readOnlyStarted.isError, undefined);
      assert.equal(record(readOnlyStarted.structuredContent).permission_mode, "read-only");
      assert.equal(record(readOnlyStarted.structuredContent).timeout_ms, 5_000);
      assert.equal(record(readOnlyStarted.structuredContent).reasoning_effort, "medium");
      assert.equal(record(readOnlyStarted.structuredContent).fast, false);
      const staleInitialization = await client.callTool({
        name: "codexluna_init",
        arguments: {
          ...initializationArguments,
          request_id: "init-fixture-stale-001",
        },
      });
      assert.equal(staleInitialization.isError, true);
      assert.match(
        JSON.stringify(staleInitialization.content),
        /already initialized with different settings/u,
      );
      const blockedDirectWrite = await client.callTool({
        name: "file_write",
        arguments: {
          web_session_id: webSessionId,
          path: "must-not-write.txt",
          content: "blocked",
          workspace_path: projectRoot,
          permission_mode: "workspace-write",
        },
      });
      assert.equal(blockedDirectWrite.isError, true);
      assert.equal(existsSync(path.join(projectRoot, "must-not-write.txt")), false);
      const readOnlyJobId = String(record(readOnlyStarted.structuredContent).job_id);
      let readOnlyStatus: Record<string, unknown> | null = null;
      const readOnlyDeadline = Date.now() + 15_000;
      while (Date.now() < readOnlyDeadline) {
        const polled = await client.callTool({
          name: "codexluna_status",
          arguments: { job_id: readOnlyJobId, web_session_id: webSessionId },
        });
        assert.equal(polled.isError, undefined);
        readOnlyStatus = record(polled.structuredContent);
        if (readOnlyStatus.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(readOnlyStatus?.status, "completed");
      assert.equal(readOnlyStatus?.luna_session_id, durableLunaSessionId);
      assert.equal(readOnlyStatus?.permission_mode, "read-only");
      assert.equal(readOnlyStatus?.timeout_ms, 5_000);
      assert.equal(readOnlyStatus?.reasoning_effort, "medium");
      assert.equal(readOnlyStatus?.fast, false);

      const writeStarted = await client.callTool({
        name: "codexluna_start",
        arguments: {
          web_session_id: webSessionId,
          permission_mode: "workspace-write",
          reasoning_effort: "low",
          fast: true,
          request_id: "luna-fixture-turn-003",
          timeout_ms: 7_000,
          prompt: "Continue in the same durable Luna session using workspace-write access.",
        },
      });
      assert.equal(writeStarted.isError, undefined);
      const writeJobId = String(record(writeStarted.structuredContent).job_id);
      let writeStatus: Record<string, unknown> | null = null;
      const writeDeadline = Date.now() + 15_000;
      while (Date.now() < writeDeadline) {
        const polled = await client.callTool({
          name: "codexluna_status",
          arguments: { job_id: writeJobId, web_session_id: webSessionId },
        });
        assert.equal(polled.isError, undefined);
        writeStatus = record(polled.structuredContent);
        if (writeStatus.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(writeStatus?.status, "completed");
      assert.equal(writeStatus?.luna_session_id, durableLunaSessionId);
      assert.equal(writeStatus?.permission_mode, "workspace-write");
      assert.equal(writeStatus?.timeout_ms, 7_000);
      assert.equal(writeStatus?.reasoning_effort, "low");
      assert.equal(writeStatus?.fast, true);

      const historicalFirstStatus = await client.callTool({
        name: "codexluna_status",
        arguments: { job_id: jobId, web_session_id: webSessionId },
      });
      assert.equal(historicalFirstStatus.isError, undefined);
      assert.equal(record(historicalFirstStatus.structuredContent).reasoning_effort, "high");
      assert.equal(record(historicalFirstStatus.structuredContent).fast, true);

      const crashStarted = await client.callTool({
        name: "codexluna_start",
        arguments: {
          web_session_id: otherWebSessionId,
          request_id: "luna-needs-resume-001",
          permission_mode: "read-only",
          prompt: "[crash] Verify recovery status fidelity.",
        },
      });
      assert.equal(crashStarted.isError, undefined);
      const crashJobId = String(record(crashStarted.structuredContent).job_id);
      let crashStatus: Record<string, unknown> | null = null;
      const crashDeadline = Date.now() + 15_000;
      while (Date.now() < crashDeadline) {
        const polled = await client.callTool({
          name: "codexluna_status",
          arguments: { job_id: crashJobId, web_session_id: otherWebSessionId },
        });
        assert.equal(polled.isError, undefined);
        crashStatus = record(polled.structuredContent);
        if (crashStatus.status === "needs_resume") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(crashStatus?.status, "needs_resume");
      assert.match(String(crashStatus?.error), /No model turn was replayed/u);

      const webSessionPrompts = runtime.prompts.filter((entry) => entry.sessionId === durableLunaSessionId);
      assert.deepEqual(
        webSessionPrompts.map((entry) => entry.permissionProfile),
        ["workspace-write", "read-only", "workspace-write"],
      );
      assert.deepEqual(
        webSessionPrompts.map((entry) => [entry.model, entry.effort, entry.fast]),
        [
          ["gpt-5.6-luna", "high", true],
          ["gpt-5.6-luna", "medium", false],
          ["gpt-5.6-luna", "low", true],
        ],
      );
      assert.match(webSessionPrompts[0]?.prompt ?? "", /<execution_mode mode="fast">/u);
      assert.match(webSessionPrompts[1]?.prompt ?? "", /<execution_mode mode="standard">/u);
      assert.match(webSessionPrompts[2]?.prompt ?? "", /<execution_mode mode="fast">/u);

      const heldLuna = await client.callTool({
        name: "codexluna_start",
        arguments: {
          web_session_id: webSessionId,
          request_id: "luna-held-turn-001",
          reasoning_effort: "medium",
          fast: false,
          prompt: "[hold] Keep this compatibility turn active until cancellation.",
        },
      });
      assert.equal(heldLuna.isError, undefined);
      const heldJobId = String(record(heldLuna.structuredContent).job_id);
      const heldDeadline = Date.now() + 15_000;
      while (Date.now() < heldDeadline) {
        const heldStatus = await client.callTool({
          name: "codexluna_status",
          arguments: { job_id: heldJobId, web_session_id: webSessionId },
        });
        if (record(heldStatus.structuredContent).status === "running") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const blockedWhileBusy = await client.callTool({
        name: "codexluna_start",
        arguments: {
          web_session_id: webSessionId,
          request_id: "luna-must-not-pollute-binding-001",
          reasoning_effort: "high",
          fast: true,
          prompt: "This must not change the binding while another turn is active.",
        },
      });
      assert.equal(blockedWhileBusy.isError, true);
      assert.equal(
        runtime.prompts.filter((entry) => entry.sessionId === durableLunaSessionId).length,
        4,
      );
      const bindingWhileBusy = await client.callTool({
        name: "codexluna_session",
        arguments: { web_session_id: webSessionId },
      });
      const heldBinding = record(record(bindingWhileBusy.structuredContent).binding);
      assert.equal(heldBinding.reasoning_effort, "medium");
      assert.equal(heldBinding.fast, false);
      const cancelledHeld = await client.callTool({
        name: "codexluna_cancel",
        arguments: { job_id: heldJobId, web_session_id: webSessionId },
      });
      assert.equal(cancelledHeld.isError, undefined);
      const afterBusy = await client.callTool({
        name: "codexluna_start",
        arguments: {
          web_session_id: webSessionId,
          request_id: "luna-after-busy-001",
          reasoning_effort: "low",
          fast: true,
          prompt: "Verify a rejected busy request left no stale reservation.",
        },
      });
      assert.equal(afterBusy.isError, undefined);
      const afterBusyJobId = String(record(afterBusy.structuredContent).job_id);
      const afterBusyDeadline = Date.now() + 15_000;
      let afterBusyFinalStatus: unknown = null;
      while (Date.now() < afterBusyDeadline) {
        const afterBusyStatus = await client.callTool({
          name: "codexluna_status",
          arguments: { job_id: afterBusyJobId, web_session_id: webSessionId },
        });
        afterBusyFinalStatus = record(afterBusyStatus.structuredContent).status;
        if (afterBusyFinalStatus === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(afterBusyFinalStatus, "completed");
    } finally {
      await client.close();
      await httpServer.close();
    }

    const persistedStore = new DurableStore(stateRoot);
    const persistedHost = await persistedStore.initialize();
    assert.equal(persistedHost.hostId, store.getHostIdentity().hostId);
    assert.equal((await persistedStore.getTask(normalTaskId)).status, "completed");
    assert.ok(terminal.has((await persistedStore.getTask(crashedTaskId)).status));
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
  }
});
