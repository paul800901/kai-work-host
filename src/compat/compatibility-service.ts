import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type { TaskOrchestrator } from "../task-orchestrator.js";
import type { HostConfig, PermissionProfile, ProjectRecord, TaskTurnRecord } from "../types.js";
import {
  CompatibilityStateStore,
  type CompatibilityBinding,
  type CompatibilityInitialization,
  type CompatibilityJob,
  type CompatibilityStartReservation,
} from "./bridge-state.js";
import type { LunaReasoning, LunaSandbox } from "./types.js";

export const KAI_SESSION_POLICY_VERSION = 2 as const;
export const KAI_SESSION_POLICY = Object.freeze({
  version: KAI_SESSION_POLICY_VERSION,
  scope: "current_web_session_plus_registered_project_memory" as const,
  allow_chatgpt_account_memory_write: false,
  allow_cross_chat_session_binding_reuse: false,
  allow_same_session_persistence: true,
  kai_l0_runtime_memory: true,
  kai_l1_episodic_memory: true,
  kai_l2_evidence_memory: true,
  requires_acknowledgement: false,
});
export const KAI_COMPACT_SESSION_POLICY =
  "current-web-session binding; registered-project KAI L0/L1/L2 memory; no ChatGPT account-memory write; no cross-chat session reuse";
export const KAI_SESSION_BOUNDARY_NOTICE =
  "KAI Work Host keeps this WebGPT conversation binding private to this conversation. Project-scoped L0 runtime state, L1 verified execution episodes, and evidence-backed L2 facts may persist locally for the registered project; ChatGPT account Memory is not modified.";

interface InitializeInput {
  workspacePath: string;
  permissionMode: LunaSandbox;
  model: string;
  reasoningEffort: LunaReasoning;
  fast: boolean;
  timeoutMs: number;
  networkAccess: boolean;
  requestId: string;
}

interface StartInput {
  webSessionId: string;
  prompt: string;
  workspacePath?: string;
  permissionMode?: LunaSandbox;
  networkAccess?: boolean;
  model?: string;
  reasoningEffort?: LunaReasoning;
  fast?: boolean;
  timeoutMs?: number;
  requestId: string;
}

interface CompatibilityStatus {
  binding: CompatibilityBinding;
  job: CompatibilityJob;
  task: Record<string, unknown>;
  turn: TaskTurnRecord;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "needs_resume";
}

interface InitializationFingerprintInput {
  workspacePath: string;
  permissionMode: LunaSandbox;
  networkAccess: boolean;
  model: string;
  reasoningEffort: LunaReasoning;
  fast: boolean;
  timeoutMs: number;
}

const ACTIVE_TASK_STATUSES = new Set(["queued", "starting", "running", "awaiting_approval", "awaiting_input"]);

function initializationFingerprint(input: InitializationFingerprintInput): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

export class CompatibilityService {
  readonly state: CompatibilityStateStore;
  private readonly operationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly orchestrator: TaskOrchestrator,
    private readonly config: HostConfig,
  ) {
    this.state = new CompatibilityStateStore(config.stateRoot, {
      model: config.workerModel,
      reasoningEffort: config.workerEffort,
      fast: config.executionProfile === "lean",
      timeoutMs: config.runtimeTurnTimeoutMs,
    });
  }

  static conversationSessionId(
    explicit: string | undefined,
    meta: Record<string, unknown> | undefined,
    allowCreate: boolean,
  ): string {
    if (explicit?.trim()) return explicit.trim();
    const chatSession = meta?.["openai/session"];
    if (typeof chatSession === "string" && chatSession.trim()) {
      const digest = createHash("sha256").update(chatSession.trim(), "utf8").digest("hex");
      return `chatgpt:${digest}`;
    }
    if (allowCreate) return `webgpt:${randomUUID()}`;
    throw new Error("web_session_id is required because ChatGPT did not provide openai/session metadata");
  }

  async initialize(webSessionId: string, input: InitializeInput): Promise<CompatibilityInitialization> {
    return this.withOperationLock(`session:${webSessionId}`, () => this.initializeLocked(webSessionId, input));
  }

  private async initializeLocked(webSessionId: string, input: InitializeInput): Promise<CompatibilityInitialization> {
    await this.orchestrator.initialize();
    this.assertWorkerSelection(input.model, input.reasoningEffort);
    const workspacePath = await this.orchestrator.store.canonicalDirectory(input.workspacePath);
    const timeoutMs = Math.min(input.timeoutMs, this.config.runtimeTurnTimeoutMs);
    const requestFingerprint = initializationFingerprint({
      workspacePath,
      permissionMode: input.permissionMode,
      networkAccess: input.networkAccess,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      fast: input.fast,
      timeoutMs,
    });
    const priorInitialization = this.state.initializationByRequest(webSessionId, input.requestId);
    if (priorInitialization !== undefined) {
      if (priorInitialization.requestFingerprint !== requestFingerprint) {
        throw new Error(`request_id ${input.requestId} was already used with different initialization settings`);
      }
      return priorInitialization;
    }
    const existing = this.state.binding(webSessionId);
    if (existing !== undefined) {
      const currentFingerprint = initializationFingerprint({
        workspacePath: existing.workspacePath,
        permissionMode: existing.permissionMode,
        networkAccess: existing.networkAccess,
        model: existing.model,
        reasoningEffort: existing.reasoningEffort,
        fast: existing.fast,
        timeoutMs: existing.timeoutMs,
      });
      if (requestFingerprint !== currentFingerprint) {
        throw new Error(
          "This WebGPT conversation is already initialized with different settings; "
          + "use codexluna_start for per-turn model, reasoning, fast, permission, network, and timeout decisions",
        );
      }
      const now = new Date().toISOString();
      return this.state.putInitialization({
        schemaVersion: 1,
        initializationId: randomUUID(),
        webSessionId,
        requestId: input.requestId,
        requestFingerprint,
        binding: existing,
        createdAt: now,
      });
    }
    const project = await this.ensureProject(
      workspacePath,
      input.permissionMode,
      input.networkAccess,
    );
    const now = new Date().toISOString();
    const binding: CompatibilityBinding = {
      schemaVersion: 1,
      webSessionId,
      projectId: project.projectId,
      taskId: null,
      workspacePath: project.rootPath,
      permissionMode: input.permissionMode,
      networkAccess: input.networkAccess,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      fast: input.fast,
      timeoutMs,
      lastJobId: null,
      createdAt: now,
      updatedAt: now,
    };
    return this.state.putInitialization({
      schemaVersion: 1,
      initializationId: randomUUID(),
      webSessionId,
      requestId: input.requestId,
      requestFingerprint,
      binding,
      createdAt: now,
    });
  }

  binding(webSessionId: string): CompatibilityBinding | undefined {
    return this.state.binding(webSessionId);
  }

  async start(input: StartInput): Promise<{ binding: CompatibilityBinding; job: CompatibilityJob; status: string }> {
    return this.withOperationLock(`session:${input.webSessionId}`, () => this.startLocked(input));
  }

  private async startLocked(input: StartInput): Promise<{
    binding: CompatibilityBinding;
    job: CompatibilityJob;
    status: string;
  }> {
    let binding = this.requireBinding(input.webSessionId);
    if (input.workspacePath !== undefined) {
      const canonical = await this.orchestrator.store.canonicalDirectory(input.workspacePath);
      if (!samePath(canonical, binding.workspacePath)) {
        throw new Error(`This conversation is bound to ${binding.workspacePath}; codexluna_start cannot switch it to ${canonical}`);
      }
    }
    const permissionMode = input.permissionMode ?? binding.permissionMode;
    const networkAccess = input.networkAccess ?? binding.networkAccess;
    const model = input.model ?? binding.model;
    const reasoningEffort = input.reasoningEffort ?? binding.reasoningEffort;
    const fast = input.fast ?? binding.fast;
    this.assertWorkerSelection(model, reasoningEffort);
    const timeoutMs = Math.min(input.timeoutMs ?? binding.timeoutMs, this.config.runtimeTurnTimeoutMs);
    const project = await this.assertWorkspace(binding.workspacePath, permissionMode);
    if (networkAccess && !project.networkAccess) {
      throw new Error(`Workspace ${binding.workspacePath} is not registered for network access`);
    }
    if (permissionMode === "danger-full-access" && !networkAccess) {
      throw new Error("danger-full-access requires network_access=true because this Host has no OS-level network sandbox");
    }
    const requestId = input.requestId;
    const existingReservation = this.state.startReservationByRequest(input.webSessionId, requestId);
    const route: CompatibilityStartReservation["route"] = existingReservation?.route
      ?? (binding.taskId === null ? "start_task" : "followup");
    const baseTaskId = existingReservation === undefined ? binding.taskId : existingReservation.baseTaskId;
    const requestFingerprint = createHash("sha256").update(JSON.stringify({
      prompt: input.prompt,
      projectId: binding.projectId,
      workspacePath: binding.workspacePath,
      route,
      baseTaskId,
      permissionMode,
      networkAccess,
      model,
      reasoningEffort,
      fast,
      timeoutMs,
    }), "utf8").digest("hex");
    const legacyRequestFingerprint = createHash("sha256").update(JSON.stringify({
      prompt: input.prompt,
      workspacePath: binding.workspacePath,
      permissionMode,
      networkAccess,
      fast,
      timeoutMs,
    }), "utf8").digest("hex");
    const existingJob = this.state.jobByRequest(input.webSessionId, requestId);
    if (existingJob !== undefined) {
      if (existingJob.requestFingerprint === "legacy") {
        throw new Error(`request_id ${requestId} predates durable instruction fingerprints and cannot be safely retried`);
      }
      if (![requestFingerprint, legacyRequestFingerprint].includes(existingJob.requestFingerprint)) {
        throw new Error(`request_id ${requestId} was already used with different Luna instructions`);
      }
      const current = await this.status(existingJob.jobId, input.webSessionId);
      return { binding: current.binding, job: existingJob, status: current.status };
    }
    if (existingReservation !== undefined && existingReservation.requestFingerprint !== requestFingerprint) {
      throw new Error(`request_id ${requestId} was already used with different Luna instructions`);
    }
    if (route === "followup" && existingReservation === undefined) {
      const followupTaskId = requiredString(baseTaskId, "KAI follow-up task id");
      const receipt = await this.orchestrator.receipt(followupTaskId);
      const status = requiredString(receipt.status, "KAI task status");
      if (ACTIVE_TASK_STATUSES.has(status)) {
        throw new Error("This WebGPT conversation already has an active Luna turn; poll codexluna_status before starting another");
      }
    }
    const now = new Date().toISOString();
    const reservation = existingReservation ?? this.state.reserveStart({
      schemaVersion: 1,
      reservationId: randomUUID(),
      webSessionId: input.webSessionId,
      requestId,
      requestFingerprint,
      jobId: randomUUID(),
      route,
      baseTaskId,
      taskId: null,
      runId: null,
      state: "reserved",
      createdAt: now,
      updatedAt: now,
    });
    let taskId: string;
    let runId: string;
    if (reservation.route === "start_task") {
      const started = await this.orchestrator.startTask({
        requestId,
        projectId: binding.projectId,
        goal: input.prompt,
        acceptanceCriteria: ["Complete the requested work and report concise verification evidence."],
        constraints: [
          "WebGPT Sol is the high-level planner; execute the stated strategy without inventing a replacement plan.",
          "Do not perform browser, publishing, deployment, Git push, or other external effects unless separately authorized.",
        ],
        permissionProfile: permissionMode,
        networkAccess,
        model,
        effort: reasoningEffort,
        fast,
        timeoutMs,
      });
      taskId = requiredString(started.taskId, "KAI task id");
      runId = typeof started.runId === "string"
        ? started.runId
        : requiredString(started.activeTurnId, "KAI run id");
    } else {
      const followupTaskId = requiredString(reservation.baseTaskId, "KAI follow-up task id");
      const followed = await this.orchestrator.followup({
        requestId,
        taskId: followupTaskId,
        message: input.prompt,
        mode: "auto",
        permissionProfile: permissionMode,
        networkAccess,
        model,
        effort: reasoningEffort,
        fast,
        timeoutMs,
      });
      taskId = followupTaskId;
      runId = requiredString(followed.runId, "KAI run id");
    }

    binding = this.state.updateBinding(input.webSessionId, {
      permissionMode,
      networkAccess,
      model,
      reasoningEffort,
      fast,
      timeoutMs,
    });

    const job: CompatibilityJob = {
      schemaVersion: 1,
      jobId: reservation.jobId,
      webSessionId: input.webSessionId,
      taskId,
      runId,
      requestId,
      requestFingerprint,
      createdAt: new Date().toISOString(),
    };
    this.state.attachStart(reservation.reservationId, job);
    const updated = this.requireBinding(input.webSessionId);
    return { binding: updated, job, status: "queued" };
  }

  async status(jobId: string, expectedWebSessionId?: string): Promise<CompatibilityStatus> {
    const job = this.requireJob(jobId);
    if (expectedWebSessionId !== undefined && job.webSessionId !== expectedWebSessionId) {
      throw new Error(`Luna job ${jobId} belongs to a different WebGPT conversation`);
    }
    const binding = this.requireBinding(job.webSessionId);
    const task = await this.orchestrator.receipt(job.taskId);
    const turns = task.turns;
    if (!Array.isArray(turns)) throw new Error(`KAI task ${job.taskId} has no turns`);
    const turn = turns.find(candidate => isTurn(candidate) && candidate.runId === job.runId);
    if (!isTurn(turn)) throw new Error(`KAI run ${job.runId} is missing from task ${job.taskId}`);
    return { binding, job, task, turn, status: compatibilityStatus(turn.status) };
  }

  async cancel(jobId: string, expectedWebSessionId?: string): Promise<CompatibilityStatus> {
    const current = await this.status(jobId, expectedWebSessionId);
    if (["queued", "running"].includes(current.status)) {
      const turns = current.task.turns as TaskTurnRecord[];
      const latest = turns.at(-1);
      if (latest?.runId === current.job.runId) {
        await this.orchestrator.interrupt({
          requestId: `webgpt-cancel:${current.job.jobId}`,
          taskId: current.job.taskId,
          reason: "Cancelled through codexluna_cancel.",
        });
      }
    }
    return this.status(jobId, expectedWebSessionId);
  }

  async authorizeDirectTool(
    webSessionId: string,
    workspacePath: string,
    requestedPermission?: LunaSandbox,
  ): Promise<{
    binding: CompatibilityBinding;
    project: ProjectRecord;
    workspacePath: string;
    permissionMode: LunaSandbox;
  }> {
    const binding = this.requireBinding(webSessionId);
    const canonical = await this.orchestrator.store.canonicalDirectory(workspacePath);
    if (!samePath(canonical, binding.workspacePath)) {
      throw new Error(`This conversation is bound to ${binding.workspacePath}, not ${canonical}`);
    }
    const permissionMode = requestedPermission ?? binding.permissionMode;
    if (permissionRank(permissionMode) > permissionRank(binding.permissionMode)) {
      throw new Error(`Direct tool requested ${permissionMode}, above this conversation's ${binding.permissionMode} authorization`);
    }
    const project = await this.assertWorkspace(canonical, permissionMode);
    return { binding, project, workspacePath: canonical, permissionMode };
  }

  async assertWorkspace(workspacePath: string, permissionMode: LunaSandbox): Promise<ProjectRecord> {
    const canonical = await this.orchestrator.store.canonicalDirectory(workspacePath);
    const projects = await this.orchestrator.store.listProjects();
    const project = projects.find(candidate => samePath(candidate.rootPath, canonical));
    if (project === undefined) {
      throw new Error(`Workspace is not registered. Call codexluna_init first: ${canonical}`);
    }
    if (!project.allowedPermissionProfiles.includes(permissionMode as PermissionProfile)) {
      throw new Error(`Workspace ${canonical} is not registered for ${permissionMode}`);
    }
    return project;
  }

  private async ensureProject(
    workspacePath: string,
    permissionMode: LunaSandbox,
    networkAccess: boolean,
  ): Promise<ProjectRecord> {
    const canonical = await this.orchestrator.store.canonicalDirectory(workspacePath);
    const projects = await this.orchestrator.store.listProjects();
    const existing = projects.find(candidate => samePath(candidate.rootPath, canonical));
    const allowed = permissionSet(permissionMode);
    if (existing !== undefined) {
      if (!existing.allowedPermissionProfiles.includes(permissionMode)) {
        throw new Error(`Workspace ${canonical} was pre-authorized only for ${existing.allowedPermissionProfiles.join(", ")}; KAI Work Host will not expand it from WebGPT`);
      }
      if (networkAccess && !existing.networkAccess) {
        throw new Error(`Workspace ${canonical} was pre-authorized without network access; KAI Work Host will not expand it from WebGPT`);
      }
      return existing;
    }
    const projectId = `webgpt-${createHash("sha256").update(canonical.toLowerCase(), "utf8").digest("hex").slice(0, 24)}`;
    return this.orchestrator.projects.register({
      projectId,
      name: path.basename(canonical) || projectId,
      rootPath: canonical,
      trust: "development",
      allowedPermissionProfiles: allowed,
      defaultPermissionProfile: permissionMode,
      networkAccess,
      instructions: [
        "WebGPT Sol is the high-level planner for this project.",
        "Use KAI L0/L1/L2 memory and concise receipts to avoid repeated exploration.",
      ],
    });
  }

  private requireBinding(webSessionId: string): CompatibilityBinding {
    const binding = this.state.binding(webSessionId);
    if (binding === undefined) throw new Error("codexluna_init must initialize this ChatGPT conversation first");
    return binding;
  }

  private assertWorkerSelection(model: string, reasoningEffort: LunaReasoning): void {
    if (!/luna/iu.test(model)) {
      throw new Error(`KAI Work Host accepts only Luna worker models; requested ${model}`);
    }
    const ranks: Record<LunaReasoning, number> = {
      none: 0,
      low: 1,
      medium: 2,
      high: 3,
      xhigh: 4,
      max: 5,
    };
    if (ranks[reasoningEffort] > ranks[this.config.workerEffort]) {
      throw new Error(
        `reasoning_effort=${reasoningEffort} exceeds this Host maximum of ${this.config.workerEffort}`,
      );
    }
  }

  private requireJob(jobId: string): CompatibilityJob {
    const job = this.state.job(jobId);
    if (job === undefined) throw new Error(`Unknown Luna job: ${jobId}`);
    return job;
  }

  private async withOperationLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = (this.operationLocks.get(key) ?? Promise.resolve()).catch(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
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

function permissionSet(mode: LunaSandbox): PermissionProfile[] {
  if (mode === "read-only") return ["read-only"];
  if (mode === "workspace-write") return ["read-only", "workspace-write"];
  return ["read-only", "workspace-write", "danger-full-access"];
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
    : left === right;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function isTurn(value: unknown): value is TaskTurnRecord {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { runId?: unknown }).runId === "string";
}

function compatibilityStatus(status: TaskTurnRecord["status"]): CompatibilityStatus["status"] {
  if (status === "starting") return "queued";
  if (status === "inProgress") return "running";
  if (status === "completed") return "completed";
  if (status === "interrupted") return "cancelled";
  if (status === "needs_resume") return "needs_resume";
  return "failed";
}

function permissionRank(mode: LunaSandbox): number {
  if (mode === "read-only") return 0;
  if (mode === "workspace-write") return 1;
  return 2;
}
