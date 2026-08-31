import path from "node:path";

import type {
  RuntimeEventSummary,
  WorkerRunResult,
  WorkerRuntimeControl,
} from "./dsh-runtime.js";
import { errorMessage, HostError } from "./errors.js";
import { newId, sha256 } from "./ids.js";
import type { MemoryService } from "./memory.js";
import type { ProjectRegistry } from "./project-registry.js";
import type { DurableStore } from "./durable-store.js";
import type {
  HostConfig,
  PermissionProfile,
  ProjectRecord,
  RuntimeEffort,
  RunUsageSummary,
  RuntimeBinding,
  TaskRecord,
  TaskStatus,
  TaskTurnRecord,
  TokenUsageBreakdown,
} from "./types.js";

const VERSION = "0.3.0";
const MAX_TASK_DIRECTIVE_CHARACTERS = 12_000;
const MAX_STORED_AGENT_MESSAGE_CHARACTERS = 16_000;
const ACTIVE_TASK_STATUSES = new Set<TaskStatus>(["queued", "starting", "running"]);
const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"] as const;

/** WebGPT fast mode keeps KAI's first-turn memory capsule compact; it is not a provider fast tier. */
export function effectiveContextCharacterCap(maximum: number, fast: boolean): number {
  return fast ? Math.min(maximum, 8_000) : maximum;
}

export interface StartTaskInput {
  requestId: string;
  projectId: string;
  goal: string;
  acceptanceCriteria: string[];
  constraints: string[];
  permissionProfile?: PermissionProfile | undefined;
  networkAccess: boolean;
  timeoutMs?: number | undefined;
  model?: string | undefined;
  effort?: RuntimeBinding["effort"] | undefined;
  fast?: boolean | undefined;
}

export interface FollowupInput {
  requestId: string;
  taskId: string;
  message: string;
  mode: "auto" | "steer" | "new_turn";
  permissionProfile?: PermissionProfile | undefined;
  networkAccess?: boolean | undefined;
  timeoutMs?: number | undefined;
  model?: string | undefined;
  effort?: RuntimeBinding["effort"] | undefined;
  fast?: boolean | undefined;
}

export interface InterruptInput {
  requestId: string;
  taskId: string;
  reason: string;
}

export interface RecoverInput {
  requestId: string;
  taskId: string;
}

export class TaskOrchestrator {
  private initialized = false;
  private readonly operationLocks = new Map<string, Promise<void>>();
  private readonly cancelledRuns = new Set<string>();

  constructor(
    private readonly config: HostConfig,
    readonly store: DurableStore,
    readonly projects: ProjectRegistry,
    readonly memory: MemoryService,
    private readonly runtime: WorkerRuntimeControl,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.initialize();
    await this.runtime.prepare();
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    await this.runtime.shutdown();
  }

  async hostStatus(): Promise<Record<string, unknown>> {
    await this.initialize();
    const [projects, tasks, runtime] = await Promise.all([
      this.store.listProjects(),
      this.store.listTasks(),
      this.runtime.status(),
    ]);
    return {
      hostId: this.store.getHostIdentity().hostId,
      mode: "remote-worker",
      executionProfile: this.config.executionProfile,
      highLevelAuthority: "webgpt_sol",
      localWorker: {
        model: this.config.workerModel,
        provider: this.config.dshProvider,
        effort: this.config.workerEffort,
        planner: false,
      },
      runtime,
      stateRoot: this.config.stateRoot,
      projectCount: projects.length,
      taskCounts: countBy(tasks.map((task) => task.status)),
      capabilities: [
        "durable_host_project_task",
        "dsh_named_session_resume",
        "multi_turn_followup",
        "wait_and_interrupt",
        "l0_l1_l2_context",
        "file_sandbox_and_local_tools",
        "diff_and_execution_receipt",
        "no_uncertain_turn_replay",
      ],
      intentionallyExcluded: [
        "local_high_level_planner",
        "subagents",
        "browser",
        "computer_use",
        "web_search",
        "deployment",
        "publishing",
        "git_push",
      ],
      policyBoundaries: {
        fileAccess: "dsh-sandbox",
        toolNetworkAccess: "model-policy-only",
        externalEffects: "not_exposed",
      },
      codexProductRuntimeUsed: false,
      version: VERSION,
    };
  }

  async startTask(input: StartTaskInput): Promise<Record<string, unknown>> {
    await this.initialize();
    return this.withOperationLock(`start:${input.requestId}`, async () => {
      const prior = (await this.store.listTasks()).find(
        (task) => task.requestLedger[`start:${input.requestId}`] !== undefined,
      );
      if (prior !== undefined) {
        const ledger = prior.requestLedger[`start:${input.requestId}`];
        return { ...this.taskSummary(prior, true), ...ledger?.result };
      }

      const goal = input.goal.trim();
      const acceptanceCriteria = cleanList(input.acceptanceCriteria);
      const constraints = cleanList(input.constraints);
      validateDirective(goal, acceptanceCriteria, constraints);
      const { project, permissionProfile } = await this.projects.resolve(
        input.projectId,
        input.permissionProfile,
      );
      this.validateAuthorization(project, permissionProfile, input.networkAccess);
      const timeoutMs = this.turnTimeout(input.timeoutMs);

      const now = new Date().toISOString();
      const taskId = newId("task");
      const runId = newId("run");
      const binding = this.runtimeBindingForTurn({ taskId, runtimeBinding: null }, input);
      const firstTurn: TaskTurnRecord = {
        runId,
        requestId: input.requestId,
        permissionProfile,
        networkAccess: input.networkAccess,
        timeoutMs,
        turnId: null,
        status: "starting",
        startedAt: now,
        completedAt: null,
        promptDigest: null,
        finalMessage: null,
        diffArtifact: null,
        receiptArtifact: null,
        runtimeBinding: binding,
        usage: null,
      };
      const task: TaskRecord = {
        schemaVersion: 1,
        taskId,
        hostId: this.store.getHostIdentity().hostId,
        projectId: project.projectId,
        requestedBy: "webgpt_sol",
        goal,
        acceptanceCriteria,
        constraints,
        permissionProfile,
        networkAccess: input.networkAccess,
        status: "queued",
        runtimeBinding: binding,
        codexThreadId: null,
        activeTurnId: runId,
        eventSequence: 0,
        lastAgentMessage: null,
        lastError: null,
        contextSources: [],
        turns: [firstTurn],
        pendingInteractions: [],
        requestLedger: {
          [`start:${input.requestId}`]: {
            operation: "start",
            requestId: input.requestId,
            state: "reserved",
            result: { taskId, runId },
            createdAt: now,
            updatedAt: now,
          },
        },
        createdAt: now,
        updatedAt: now,
      };
      await this.store.createTask(task);
      await this.store.completeTaskRequest(taskId, "start", input.requestId, { taskId, runId });
      void this.executeTurn(taskId, runId, { includeContext: true, recoveryContinuation: false })
        .catch(() => undefined);
      return this.taskSummary(task, false);
    });
  }

  async followup(input: FollowupInput): Promise<Record<string, unknown>> {
    await this.initialize();
    return this.withOperationLock(`followup:${input.taskId}:${input.requestId}`, async () => {
      const task = await this.store.getTask(input.taskId);
      const existing = task.requestLedger[`followup:${input.requestId}`];
      if (existing !== undefined) return { ...existing.result, duplicate: true };
      const message = input.message.trim();
      if (message.length === 0) throw new HostError("followup_invalid", "Follow-up message cannot be blank");
      if (message.length > MAX_TASK_DIRECTIVE_CHARACTERS) {
        throw new HostError("followup_too_large", `Follow-up exceeds ${MAX_TASK_DIRECTIVE_CHARACTERS} characters`);
      }
      if (input.mode === "steer") {
        throw new HostError(
          "steer_not_supported",
          "The DSH SDK runtime has no prompt-cancel or live steer method. Wait for the turn or interrupt it, then send a new turn.",
        );
      }
      if (ACTIVE_TASK_STATUSES.has(task.status)) {
        throw new HostError(
          "task_busy",
          "This Luna task is still active. Wait for completion, or interrupt it before sending a follow-up.",
        );
      }

      const { project, permissionProfile } = await this.projects.resolve(
        task.projectId,
        input.permissionProfile ?? task.permissionProfile,
      );
      const networkAccess = input.networkAccess ?? task.networkAccess;
      this.validateAuthorization(project, permissionProfile, networkAccess);
      const timeoutMs = this.turnTimeout(input.timeoutMs);

      const runId = newId("run");
      const recovering = task.status === "needs_resume";
      const binding = this.runtimeBindingForTurn(task, input);
      const reservation = await this.store.reserveTaskRequest(
        task.taskId,
        "followup",
        input.requestId,
        { taskId: task.taskId, runId, mode: "new_turn" },
      );
      if (!reservation.isNew) return { ...reservation.entry.result, duplicate: true };

      await this.store.transitionTask(
        task.taskId,
        (current) => {
          current.runtimeBinding = binding;
          current.permissionProfile = permissionProfile;
          current.networkAccess = networkAccess;
          current.status = "queued";
          current.activeTurnId = runId;
          current.lastError = null;
          current.turns.push({
            runId,
            requestId: input.requestId,
            permissionProfile,
            networkAccess,
            timeoutMs,
            turnId: null,
            status: "starting",
            startedAt: new Date().toISOString(),
            completedAt: null,
            promptDigest: sha256(message),
            finalMessage: null,
            diffArtifact: null,
            receiptArtifact: null,
            runtimeBinding: binding,
            usage: null,
          });
        },
        "turn.queued",
        { runId, recoveryContinuation: recovering, permissionProfile, networkAccess, timeoutMs },
      );
      let prompt = recovering
        ? `[RECOVERY CONTINUATION]\nThe prior process ended with an uncertain turn. Do not assume it failed or replay it. Inspect the current workspace and durable session state before continuing.\n\n${message}`
        : message;
      // Repeat the exact per-turn authorization even when unchanged. Luna must
      // not have to infer the current brain decision from earlier context.
      prompt = [
        this.authorizationUpdate(permissionProfile, networkAccess),
        this.executionMode(binding.fast ?? this.defaultFast()),
        prompt,
      ].join("\n\n");
      void this.executeTurn(task.taskId, runId, {
        includeContext: task.runtimeBinding === undefined || task.runtimeBinding === null,
        recoveryContinuation: recovering,
        prompt,
      }).catch(() => undefined);
      const result = { taskId: task.taskId, runId, mode: "new_turn" };
      await this.store.completeTaskRequest(task.taskId, "followup", input.requestId, result);
      return { ...result, duplicate: false };
    });
  }

  async wait(taskId: string, afterSequence: number, timeoutMs: number): Promise<Record<string, unknown>> {
    await this.initialize();
    const events = await this.store.waitForEvents(
      taskId,
      afterSequence,
      Math.min(Math.max(timeoutMs, 0), 30_000),
      this.config.maxEventBatch,
    );
    const task = await this.store.getTask(taskId);
    return {
      task: this.taskSummary(task, false),
      events,
      nextSequence: events.at(-1)?.sequence ?? afterSequence,
      needsAction: this.pendingAction(task),
    };
  }

  async interrupt(input: InterruptInput): Promise<Record<string, unknown>> {
    await this.initialize();
    return this.withOperationLock(`interrupt:${input.taskId}:${input.requestId}`, async () => {
      const task = await this.store.getTask(input.taskId);
      const existing = task.requestLedger[`interrupt:${input.requestId}`];
      if (existing !== undefined) return { ...existing.result, duplicate: true };
      if (!ACTIVE_TASK_STATUSES.has(task.status) || task.activeTurnId === null) {
        throw new HostError("no_active_turn", `Task ${task.taskId} has no active Luna turn`);
      }
      const run = this.currentRun(task);
      await this.store.reserveTaskRequest(task.taskId, "interrupt", input.requestId, {
        taskId: task.taskId,
        runId: run.runId,
      });
      this.cancelledRuns.add(run.runId);
      const processFound = await this.runtime.interrupt(task.taskId);
      await this.store.transitionTask(
        task.taskId,
        () => undefined,
        "turn.interrupt_requested",
        { runId: run.runId, reason: input.reason, processFound },
      );
      if (!processFound) {
        await this.finalizeSynthetic(task.taskId, run.runId, "interrupted", null, input.reason);
      }
      const result = { taskId: task.taskId, runId: run.runId, requested: true, processFound };
      await this.store.completeTaskRequest(task.taskId, "interrupt", input.requestId, result);
      return { ...result, duplicate: false };
    });
  }

  async recover(input: RecoverInput): Promise<Record<string, unknown>> {
    await this.initialize();
    return this.withOperationLock(`recover:${input.taskId}:${input.requestId}`, async () => {
      const task = await this.store.getTask(input.taskId);
      const existing = task.requestLedger[`recover:${input.requestId}`];
      if (existing !== undefined) return { ...existing.result, duplicate: true };
      await this.store.reserveTaskRequest(task.taskId, "recover", input.requestId, { taskId: task.taskId });
      const binding = task.runtimeBinding ?? null;
      await this.store.transitionTask(
        task.taskId,
        () => undefined,
        "task.recovery_inspected",
        {
          replayed: false,
          resumableNamedSession: binding !== null,
          sessionId: binding?.sessionId ?? null,
          legacyCodexTask: binding === null && task.codexThreadId !== null,
        },
      );
      const result = {
        taskId: task.taskId,
        status: task.status,
        replayed: false,
        resumableNamedSession: binding !== null,
        sessionId: binding?.sessionId ?? null,
        nextStep: "Send an explicit follow-up. KAI Work Host will inspect current state and continue without replaying the uncertain prompt.",
      };
      await this.store.completeTaskRequest(task.taskId, "recover", input.requestId, result);
      return { ...result, duplicate: false };
    });
  }

  async receipt(taskId: string): Promise<Record<string, unknown>> {
    await this.initialize();
    const task = await this.store.getTask(taskId);
    const events = await this.store.readEvents(taskId, Math.max(0, task.eventSequence - 30), 30);
    return {
      taskId: task.taskId,
      hostId: task.hostId,
      projectId: task.projectId,
      status: task.status,
      runtimeBinding: task.runtimeBinding ?? null,
      permissionProfile: task.permissionProfile,
      networkAccess: task.networkAccess,
      legacyCodexThreadId: task.codexThreadId,
      activeTurnId: task.activeTurnId,
      goal: task.goal,
      lastAgentMessage: task.lastAgentMessage,
      lastError: task.lastError,
      contextSources: task.contextSources,
      turns: task.turns,
      pendingAction: this.pendingAction(task),
      recentEvents: events,
      eventSequence: task.eventSequence,
    };
  }

  private async executeTurn(
    taskId: string,
    runId: string,
    options: { includeContext: boolean; recoveryContinuation: boolean; prompt?: string },
  ): Promise<void> {
    try {
      let task = await this.store.getTask(taskId);
      const project = await this.store.getProject(task.projectId);
      const binding = this.runtimeBindingForTurn(task, {});
      const queuedRun = this.requireRun(task, runId);
      const permissionProfile = queuedRun.permissionProfile ?? task.permissionProfile;
      const networkAccess = queuedRun.networkAccess ?? task.networkAccess;
      const timeoutMs = queuedRun.timeoutMs ?? this.config.runtimeTurnTimeoutMs;
      let prompt = options.prompt ?? "";
      if (options.includeContext) {
        const capsule = await this.memory.compile(project, task, this.contextCap(binding));
        const contextArtifact = await this.store.writeContextSnapshot(task.taskId, runId, {
          schemaVersion: 1,
          taskId: task.taskId,
          runId,
          digest: capsule.digest,
          sourceRefs: capsule.sourceRefs,
          characterCount: capsule.characterCount,
          text: capsule.text,
        });
        prompt = this.initialPrompt(task, capsule.text, capsule.digest, binding.fast ?? this.defaultFast());
        await this.store.transitionTask(
          task.taskId,
          (current) => {
            current.runtimeBinding = binding;
            current.contextSources = capsule.sourceRefs;
            this.requireRun(current, runId).promptDigest = sha256(prompt);
          },
          "context.compiled",
          {
            runId,
            digest: capsule.digest,
            sourceRefs: capsule.sourceRefs,
            characterCount: capsule.characterCount,
            artifactPath: contextArtifact,
          },
        );
      }
      if (this.cancelledRuns.has(runId)) {
        await this.finalizeSynthetic(taskId, runId, "interrupted", null, "Interrupted before Luna started");
        return;
      }
      await this.store.transitionTask(
        task.taskId,
        (current) => {
          current.status = "starting";
          current.activeTurnId = runId;
          const run = this.requireRun(current, runId);
          run.status = "starting";
          run.runtimeBinding = binding;
          if (run.promptDigest === null) run.promptDigest = sha256(prompt);
        },
        "runtime.turn_starting",
        {
          runId,
          engine: binding.engine,
          provider: binding.provider,
          model: binding.model,
          sessionId: binding.sessionId,
          effort: binding.effort ?? this.config.workerEffort,
          fast: binding.fast ?? this.defaultFast(),
          permissionProfile,
          networkAccess,
          timeoutMs,
          recoveryContinuation: options.recoveryContinuation,
        },
      );
      task = await this.store.getTask(taskId);
      const result = await this.runtime.runTurn({
        taskId: task.taskId,
        sessionId: binding.sessionId,
        model: binding.model,
        effort: binding.effort ?? this.config.workerEffort,
        fast: binding.fast ?? this.defaultFast(),
        cwd: project.rootPath,
        permissionProfile,
        networkAccess,
        timeoutMs,
        prompt,
        onEvent: (event) => this.handleRuntimeEvent(task.taskId, runId, event),
      });
      if (this.cancelledRuns.has(runId) && result.status !== "interrupted") {
        await this.finalizeSynthetic(taskId, runId, "interrupted", result, "Interrupted by request");
      } else {
        await this.finalizeResult(task.taskId, runId, result);
      }
    } catch (error) {
      if (this.cancelledRuns.has(runId) || isHostErrorCode(error, "runtime_interrupted")) {
        await this.finalizeSynthetic(taskId, runId, "interrupted", null, "Interrupted by request");
      } else if (isHostErrorCode(error, "runtime_exited") || isHostErrorCode(error, "runtime_turn_timeout")) {
        await this.markNeedsResume(taskId, runId, error);
      } else {
        await this.finalizeSynthetic(taskId, runId, "failed", null, errorMessage(error));
      }
    } finally {
      this.cancelledRuns.delete(runId);
    }
  }

  private async handleRuntimeEvent(taskId: string, runId: string, event: RuntimeEventSummary): Promise<void> {
    const eventType = event.type === "tool/call"
      ? "runtime.tool_called"
      : event.type === "tool/result"
        ? "runtime.tool_completed"
        : event.type === "assistant/message"
          ? "runtime.agent_message"
          : `runtime.${event.type.replaceAll("/", "_")}`;
    await this.store.transitionTask(
      taskId,
      (task) => {
        const run = this.requireRun(task, runId);
        if (event.type === "turn/start") {
          const runtimeTurn = `dsh:${String(event.data.turn ?? runId)}`;
          run.turnId = runtimeTurn;
          run.status = "inProgress";
          task.status = "running";
          task.activeTurnId = runtimeTurn;
        }
        if (event.type === "assistant/message" && typeof event.data.text === "string") {
          const text = event.data.text.slice(0, MAX_STORED_AGENT_MESSAGE_CHARACTERS);
          if (text.length > 0) {
            run.finalMessage = text;
            task.lastAgentMessage = text;
          }
        }
      },
      eventType,
      { runId, runtimeSequence: event.sequence, runtimeAt: event.at, ...event.data },
    );
  }

  private async finalizeResult(taskId: string, runId: string, result: WorkerRunResult): Promise<void> {
    const task = await this.store.getTask(taskId);
    const run = this.requireRun(task, runId);
    if (isTerminalRun(run)) return;
    const runtimeBinding = this.receiptRuntimeBinding(task, run);
    const runtimeArtifact = await this.store.writeArtifact(
      taskId,
      `runtime-${runId}.json`,
      `${JSON.stringify({ schemaVersion: 1, taskId, runId, events: result.eventSummaries }, null, 2)}\n`,
    );
    const diffArtifact = result.diffText === null
      ? null
      : await this.store.writeArtifact(
        taskId,
        `diff-${runId}.patch`,
        result.diffText.endsWith("\n") ? result.diffText : `${result.diffText}\n`,
      );
    const usage = withCumulativeUsage(task, runId, result.usage);
    const completedAt = new Date().toISOString();
    const receipt = {
      schemaVersion: 1,
      hostId: task.hostId,
      projectId: task.projectId,
      taskId,
      runId,
      runtimeBinding,
      permissionProfile: run.permissionProfile ?? task.permissionProfile,
      networkAccess: run.networkAccess ?? task.networkAccess,
      timeoutMs: run.timeoutMs ?? this.config.runtimeTurnTimeoutMs,
      turnId: run.turnId,
      status: result.status,
      finalMessage: result.finalMessage,
      diffArtifact,
      runtimeArtifact,
      usage,
      validation: result.validation,
      reason: result.reason,
      error: result.error,
      completedAt,
    };
    const receiptPath = await this.store.writeArtifact(
      taskId,
      `receipt-${runId}.json`,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    const episodeId = `episode_${sha256(`${taskId}:${runId}`).slice(0, 24)}`;
    const episodeArtifacts = [runtimeArtifact, diffArtifact, receiptPath]
      .filter((value): value is string => value !== null);
    await this.store.transitionTask(
      taskId,
      (current) => {
        current.status = result.status;
        current.activeTurnId = null;
        current.lastAgentMessage = result.finalMessage ?? current.lastAgentMessage;
        current.lastError = result.error;
        const currentRun = this.requireRun(current, runId);
        currentRun.status = result.status;
        currentRun.completedAt = completedAt;
        currentRun.finalMessage = result.finalMessage;
        currentRun.diffArtifact = diffArtifact;
        currentRun.receiptArtifact = receiptPath;
        currentRun.usage = usage;
        currentRun.error = result.error;
      },
      "turn.completed",
      {
        runId,
        status: result.status,
        error: result.error,
        receiptArtifact: receiptPath,
        runtimeArtifact,
        diffArtifact,
        totalTokens: usage.incremental?.totalTokens ?? null,
      },
      async (current) => {
        await this.memory.recordEpisode(
          current,
          result.status,
          result.validation,
          episodeArtifacts,
          episodeId,
        );
      },
    );
  }

  private async finalizeSynthetic(
    taskId: string,
    runId: string,
    status: "failed" | "interrupted",
    result: WorkerRunResult | null,
    message: string,
  ): Promise<void> {
    const task = await this.store.getTask(taskId);
    const run = this.requireRun(task, runId);
    if (isTerminalRun(run)) return;
    const runtimeBinding = this.receiptRuntimeBinding(task, run);
    const completedAt = new Date().toISOString();
    const usage = result === null ? null : withCumulativeUsage(task, runId, result.usage);
    const receipt = {
      schemaVersion: 1,
      hostId: task.hostId,
      projectId: task.projectId,
      taskId,
      runId,
      runtimeBinding,
      permissionProfile: run.permissionProfile ?? task.permissionProfile,
      networkAccess: run.networkAccess ?? task.networkAccess,
      timeoutMs: run.timeoutMs ?? this.config.runtimeTurnTimeoutMs,
      turnId: run.turnId,
      status,
      finalMessage: result?.finalMessage ?? run.finalMessage,
      usage,
      error: message,
      completedAt,
    };
    const receiptPath = await this.store.writeArtifact(
      taskId,
      `receipt-${runId}.json`,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    const episodeId = `episode_${sha256(`${taskId}:${runId}`).slice(0, 24)}`;
    await this.store.transitionTask(
      taskId,
      (current) => {
        current.status = status;
        current.activeTurnId = null;
        current.lastError = message;
        const currentRun = this.requireRun(current, runId);
        currentRun.status = status;
        currentRun.completedAt = completedAt;
        currentRun.finalMessage = result?.finalMessage ?? currentRun.finalMessage;
        currentRun.receiptArtifact = receiptPath;
        currentRun.usage = usage;
        currentRun.error = message;
      },
      "turn.completed",
      { runId, status, error: message, receiptArtifact: receiptPath },
      async (current) => {
        await this.memory.recordEpisode(current, status, [], [receiptPath], episodeId);
      },
    );
  }

  private async markNeedsResume(taskId: string, runId: string, error: unknown): Promise<void> {
    const task = await this.store.getTask(taskId);
    const run = this.requireRun(task, runId);
    if (isTerminalRun(run)) return;
    const runtimeBinding = this.receiptRuntimeBinding(task, run);
    const message = `${errorMessage(error).slice(0, 3_500)} No model turn was replayed.`;
    const receiptPath = await this.store.writeArtifact(
      taskId,
      `receipt-${runId}.json`,
      `${JSON.stringify({
        schemaVersion: 1,
        hostId: task.hostId,
        projectId: task.projectId,
        taskId,
        runId,
        runtimeBinding,
        permissionProfile: run.permissionProfile ?? task.permissionProfile,
        networkAccess: run.networkAccess ?? task.networkAccess,
        timeoutMs: run.timeoutMs ?? this.config.runtimeTurnTimeoutMs,
        turnId: run.turnId,
        status: "needs_resume",
        replayed: false,
        error: message,
        at: new Date().toISOString(),
      }, null, 2)}\n`,
    );
    await this.store.transitionTask(
      taskId,
      (current) => {
        current.status = "needs_resume";
        current.activeTurnId = null;
        current.lastError = message;
        const currentRun = this.requireRun(current, runId);
        currentRun.status = "needs_resume";
        currentRun.completedAt = new Date().toISOString();
        currentRun.receiptArtifact = receiptPath;
        currentRun.error = message;
      },
      "task.recovery_required",
      { runId, replayed: false, error: message, receiptArtifact: receiptPath },
    );
  }

  private initialPrompt(task: TaskRecord, context: string, digest: string, fast: boolean): string {
    return [
      `<kai_context digest="${digest}">`,
      context,
      "</kai_context>",
      "",
      "<authorization>",
      `filesystem=${task.permissionProfile}`,
      `tool_network=${task.networkAccess ? "allowed" : "forbidden_by_task_policy"}`,
      "external_effects=not_authorized",
      "</authorization>",
      "",
      this.executionMode(fast),
      "",
      "<task>",
      `Goal: ${task.goal}`,
      `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n") || "- Complete and verify the requested change."}`,
      `Constraints:\n${task.constraints.map((item) => `- ${item}`).join("\n") || "- Follow project instructions and current authorization."}`,
      "</task>",
    ].join("\n");
  }

  private authorizationUpdate(permissionProfile: PermissionProfile, networkAccess: boolean): string {
    return [
      "<authorization_update>",
      `filesystem=${permissionProfile}`,
      `tool_network=${networkAccess ? "allowed" : "forbidden_by_task_policy"}`,
      "external_effects=not_authorized",
      "</authorization_update>",
    ].join("\n");
  }

  private executionMode(fast: boolean): string {
    return [
      `<execution_mode mode="${fast ? "fast" : "standard"}">`,
      fast
        ? "Execute directly from the supplied KAI context, avoid redundant rediscovery, and return concise verification evidence."
        : "Favor complete verification within the stated task while still avoiding redundant exploration.",
      "This is a KAI context and execution policy, not a provider fast tier.",
      "</execution_mode>",
    ].join("\n");
  }

  private runtimeBindingForTurn(
    task: Pick<TaskRecord, "taskId" | "runtimeBinding">,
    input: Pick<StartTaskInput, "model" | "effort" | "fast">,
  ): RuntimeBinding {
    const prior = task.runtimeBinding ?? null;
    return this.newRuntimeBinding(task.taskId, {
      model: this.effectiveWorkerModel(input.model ?? prior?.model),
      effort: this.effectiveWorkerEffort(input.effort ?? prior?.effort),
      fast: this.effectiveFast(input.fast ?? prior?.fast),
      sessionId: prior?.sessionId,
    });
  }

  private newRuntimeBinding(
    taskId: string,
    selection: { model: string; effort: RuntimeEffort; fast: boolean; sessionId?: string | undefined },
  ): RuntimeBinding {
    return {
      schemaVersion: 1,
      engine: "dsh-sdk-jsonrpc",
      provider: this.config.dshProvider,
      model: selection.model,
      effort: selection.effort,
      fast: selection.fast,
      profile: this.config.dshProfile,
      sessionId: selection.sessionId ?? `kai-${taskId}`,
    };
  }

  private effectiveWorkerModel(requested: string | undefined): string {
    const model = (requested ?? this.config.workerModel).trim();
    if (model.length === 0) throw new HostError("worker_model_invalid", "Luna model cannot be blank");
    if (!/luna/iu.test(model)) {
      throw new HostError("worker_model_not_luna", `KAI Work Host can only run Luna worker models; requested ${model}`);
    }
    return model;
  }

  private effectiveWorkerEffort(requested: RuntimeBinding["effort"] | undefined): RuntimeEffort {
    const effort = requested ?? this.config.workerEffort;
    if (EFFORT_ORDER.indexOf(effort) > EFFORT_ORDER.indexOf(this.config.workerEffort)) {
      throw new HostError(
        "worker_effort_exceeds_ceiling",
        `Requested reasoning effort ${effort} exceeds this Host ceiling ${this.config.workerEffort}`,
      );
    }
    return effort;
  }

  private effectiveFast(requested: boolean | undefined): boolean {
    return requested ?? this.defaultFast();
  }

  private defaultFast(): boolean {
    return this.config.executionProfile === "lean";
  }

  private contextCap(binding: RuntimeBinding): number {
    return effectiveContextCharacterCap(this.config.maxContextCharacters, binding.fast === true);
  }

  private receiptRuntimeBinding(task: TaskRecord, run: TaskTurnRecord): RuntimeBinding | null {
    return run.runtimeBinding ?? task.runtimeBinding ?? null;
  }

  private validateAuthorization(
    project: ProjectRecord,
    permissionProfile: PermissionProfile,
    networkAccess: boolean,
  ): void {
    if (networkAccess && !project.networkAccess) {
      throw new HostError("network_not_allowed", `Project ${project.projectId} does not allow tool network access`);
    }
    if (permissionProfile === "danger-full-access" && !networkAccess) {
      throw new HostError(
        "danger_full_access_requires_network_authorization",
        "DSH file sandbox cannot provide operating-system network isolation in danger-full-access; authorize network or use workspace-write",
      );
    }
  }

  private turnTimeout(requested: number | undefined): number {
    if (requested === undefined) return this.config.runtimeTurnTimeoutMs;
    if (!Number.isSafeInteger(requested) || requested < 1_000) {
      throw new HostError("turn_timeout_invalid", "Luna turn timeout must be an integer of at least 1000 ms");
    }
    return Math.min(requested, this.config.runtimeTurnTimeoutMs);
  }

  private pendingAction(task: TaskRecord): Record<string, unknown> | null {
    return task.status === "needs_resume"
      ? {
        kind: "recovery",
        message: task.lastError,
        replayed: false,
        action: "inspect receipt, then send an explicit follow-up",
      }
      : null;
  }

  private taskSummary(task: TaskRecord, duplicate: boolean): Record<string, unknown> {
    return {
      taskId: task.taskId,
      projectId: task.projectId,
      status: task.status,
      runtimeBinding: task.runtimeBinding ?? null,
      permissionProfile: task.permissionProfile,
      networkAccess: task.networkAccess,
      activeTurnId: task.activeTurnId,
      eventSequence: task.eventSequence,
      lastAgentMessage: task.lastAgentMessage,
      lastError: task.lastError,
      needsAction: this.pendingAction(task),
      duplicate,
    };
  }

  private currentRun(task: TaskRecord): TaskTurnRecord {
    const run = task.turns.at(-1);
    if (run === undefined) throw new HostError("task_has_no_turn", `Task ${task.taskId} has no turn`);
    return run;
  }

  private requireRun(task: TaskRecord, runId: string): TaskTurnRecord {
    const run = task.turns.find((candidate) => candidate.runId === runId);
    if (run === undefined) throw new HostError("run_not_found", `Unknown run ${runId} for task ${task.taskId}`);
    return run;
  }

  private async withOperationLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = (this.operationLocks.get(key) ?? Promise.resolve()).catch(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => gate);
    this.operationLocks.set(key, tail);
    await prior;
    try {
      return await action();
    } finally {
      release();
      if (this.operationLocks.get(key) === tail) this.operationLocks.delete(key);
    }
  }
}

function cleanList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function validateDirective(goal: string, acceptanceCriteria: string[], constraints: string[]): void {
  if (goal.length === 0) throw new HostError("task_goal_invalid", "Task goal cannot be blank");
  const characters = goal.length +
    acceptanceCriteria.reduce((total, item) => total + item.length, 0) +
    constraints.reduce((total, item) => total + item.length, 0);
  if (characters > MAX_TASK_DIRECTIVE_CHARACTERS) {
    throw new HostError(
      "task_directive_too_large",
      `Task goal, acceptance criteria, and constraints exceed ${MAX_TASK_DIRECTIVE_CHARACTERS} characters`,
    );
  }
}

function countBy(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function isTerminalRun(run: TaskTurnRecord): boolean {
  return ["completed", "failed", "interrupted", "needs_resume"].includes(run.status);
}

function isHostErrorCode(error: unknown, code: string): boolean {
  return error instanceof HostError && error.code === code;
}

function normalizeUsage(value: TokenUsageBreakdown): TokenUsageBreakdown {
  const inputTokens = value.uncachedInputTokens ?? value.inputTokens;
  return {
    ...value,
    inputTokens,
    uncachedInputTokens: inputTokens,
    totalTokens: inputTokens + value.cachedInputTokens + value.cacheWriteInputTokens + value.outputTokens,
  };
}

function withCumulativeUsage(
  task: TaskRecord,
  runId: string,
  usage: RunUsageSummary,
): RunUsageSummary {
  const incremental = usage.incremental === null ? null : normalizeUsage(usage.incremental);
  if (incremental === null) return usage;
  const total: TokenUsageBreakdown = {
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  for (const turn of task.turns) {
    const value = turn.runId === runId ? incremental : turn.usage?.incremental;
    if (value === undefined || value === null) continue;
    const normalized = normalizeUsage(value);
    total.inputTokens += normalized.inputTokens;
    total.uncachedInputTokens = total.inputTokens;
    total.cachedInputTokens += normalized.cachedInputTokens;
    total.cacheWriteInputTokens += normalized.cacheWriteInputTokens;
    total.outputTokens += normalized.outputTokens;
    total.reasoningOutputTokens += normalized.reasoningOutputTokens;
  }
  total.totalTokens = total.inputTokens + total.cachedInputTokens + total.cacheWriteInputTokens + total.outputTokens;
  return { ...usage, incremental, cumulative: total };
}

export const HOST_VERSION = VERSION;
export const HOST_PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
