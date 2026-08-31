import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicWriteFile } from "./atomic-file.js";
import type { LunaReasoning, LunaSandbox } from "./types.js";

export interface CompatibilityBinding {
  schemaVersion: 1;
  webSessionId: string;
  projectId: string;
  taskId: string | null;
  workspacePath: string;
  permissionMode: LunaSandbox;
  networkAccess: boolean;
  model: string;
  reasoningEffort: LunaReasoning;
  fast: boolean;
  timeoutMs: number;
  lastJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompatibilityBindingDefaults {
  model: string;
  reasoningEffort: LunaReasoning;
  fast: boolean;
  timeoutMs: number;
}

export interface CompatibilityJob {
  schemaVersion: 1;
  jobId: string;
  webSessionId: string;
  taskId: string;
  runId: string;
  requestId: string;
  requestFingerprint: string;
  createdAt: string;
}

export interface CompatibilityInitialization {
  schemaVersion: 1;
  initializationId: string;
  webSessionId: string;
  requestId: string;
  requestFingerprint: string;
  binding: CompatibilityBinding;
  createdAt: string;
}

export interface CompatibilityStartReservation {
  schemaVersion: 1;
  reservationId: string;
  webSessionId: string;
  requestId: string;
  requestFingerprint: string;
  jobId: string;
  route: "start_task" | "followup";
  baseTaskId: string | null;
  taskId: string | null;
  runId: string | null;
  state: "reserved" | "attached";
  createdAt: string;
  updatedAt: string;
}

interface CompatibilityState {
  schemaVersion: 1;
  sessions: Record<string, CompatibilityBinding>;
  jobs: Record<string, CompatibilityJob>;
  initializations: Record<string, CompatibilityInitialization>;
  startReservations: Record<string, CompatibilityStartReservation>;
}

function emptyState(): CompatibilityState {
  return { schemaVersion: 1, sessions: {}, jobs: {}, initializations: {}, startReservations: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class CompatibilityStateStore {
  readonly path: string;
  private readonly state: CompatibilityState;

  constructor(
    stateRoot: string,
    private readonly bindingDefaults: CompatibilityBindingDefaults,
  ) {
    this.path = path.join(path.resolve(stateRoot), "compatibility", "state.json");
    this.state = this.load();
  }

  binding(webSessionId: string): CompatibilityBinding | undefined {
    const value = this.state.sessions[webSessionId];
    return value === undefined ? undefined : structuredClone(value);
  }

  initializationByRequest(webSessionId: string, requestId: string): CompatibilityInitialization | undefined {
    const value = Object.values(this.state.initializations).find(initialization =>
      initialization.webSessionId === webSessionId && initialization.requestId === requestId);
    return value === undefined ? undefined : structuredClone(value);
  }

  putInitialization(initialization: CompatibilityInitialization): CompatibilityInitialization {
    const current = this.state.sessions[initialization.webSessionId];
    if (current === undefined) {
      this.state.sessions[initialization.webSessionId] = structuredClone(initialization.binding);
    } else if (JSON.stringify(current) !== JSON.stringify(initialization.binding)) {
      throw new Error(`Initialization cannot overwrite active WebGPT session ${initialization.webSessionId}`);
    }
    this.state.initializations[initialization.initializationId] = structuredClone(initialization);
    this.save();
    return structuredClone(initialization);
  }

  updateBinding(webSessionId: string, patch: Partial<CompatibilityBinding>): CompatibilityBinding {
    const current = this.state.sessions[webSessionId];
    if (current === undefined) throw new Error(`Unknown WebGPT session: ${webSessionId}`);
    const updated = { ...current, ...patch, webSessionId, updatedAt: new Date().toISOString() };
    this.state.sessions[webSessionId] = updated;
    this.save();
    return structuredClone(updated);
  }

  job(jobId: string): CompatibilityJob | undefined {
    const value = this.state.jobs[jobId];
    return value === undefined ? undefined : structuredClone(value);
  }

  jobByRequest(webSessionId: string, requestId: string): CompatibilityJob | undefined {
    const value = Object.values(this.state.jobs).find(job =>
      job.webSessionId === webSessionId && job.requestId === requestId);
    return value === undefined ? undefined : structuredClone(value);
  }

  startReservationByRequest(
    webSessionId: string,
    requestId: string,
  ): CompatibilityStartReservation | undefined {
    const value = Object.values(this.state.startReservations).find(reservation =>
      reservation.webSessionId === webSessionId && reservation.requestId === requestId);
    return value === undefined ? undefined : structuredClone(value);
  }

  reserveStart(reservation: CompatibilityStartReservation): CompatibilityStartReservation {
    const existing = this.startReservationByRequest(reservation.webSessionId, reservation.requestId);
    if (existing !== undefined) return existing;
    const pending = Object.values(this.state.startReservations).find(candidate =>
      candidate.webSessionId === reservation.webSessionId && candidate.state === "reserved");
    if (pending !== undefined) {
      throw new Error(
        `WebGPT session ${reservation.webSessionId} has an unfinished request_id ${pending.requestId}; retry it before starting another Luna turn`,
      );
    }
    this.state.startReservations[reservation.reservationId] = structuredClone(reservation);
    this.save();
    return structuredClone(reservation);
  }

  attachStart(reservationId: string, job: CompatibilityJob): CompatibilityJob {
    const reservation = this.state.startReservations[reservationId];
    if (reservation === undefined) throw new Error(`Unknown Luna start reservation: ${reservationId}`);
    if (reservation.webSessionId !== job.webSessionId
      || reservation.requestId !== job.requestId
      || reservation.requestFingerprint !== job.requestFingerprint
      || reservation.jobId !== job.jobId) {
      throw new Error(`Luna start reservation ${reservationId} does not match the completed job`);
    }
    reservation.taskId = job.taskId;
    reservation.runId = job.runId;
    reservation.state = "attached";
    reservation.updatedAt = new Date().toISOString();
    this.state.jobs[job.jobId] = structuredClone(job);
    const binding = this.state.sessions[job.webSessionId];
    if (binding !== undefined) {
      binding.taskId = job.taskId;
      binding.lastJobId = job.jobId;
      binding.updatedAt = reservation.updatedAt;
    }
    this.save();
    return structuredClone(job);
  }

  putJob(job: CompatibilityJob): CompatibilityJob {
    this.state.jobs[job.jobId] = structuredClone(job);
    const binding = this.state.sessions[job.webSessionId];
    if (binding !== undefined) {
      binding.taskId = job.taskId;
      binding.lastJobId = job.jobId;
      binding.updatedAt = new Date().toISOString();
    }
    this.save();
    return structuredClone(job);
  }

  private load(): CompatibilityState {
    if (!existsSync(this.path)) return emptyState();
    const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8").replace(/^\uFEFF/u, ""));
    if (!isRecord(parsed)
      || parsed.schemaVersion !== 1
      || !isRecord(parsed.sessions)
      || !isRecord(parsed.jobs)
      || ("initializations" in parsed && !isRecord(parsed.initializations))
      || ("startReservations" in parsed && !isRecord(parsed.startReservations))) {
      throw new Error(`Invalid KAI compatibility state: ${this.path}`);
    }
    const state = parsed as unknown as CompatibilityState;
    if (!isRecord(state.initializations)) state.initializations = {};
    if (!isRecord(state.startReservations)) state.startReservations = {};
    for (const binding of Object.values(state.sessions)) this.normalizeBinding(binding);
    for (const initialization of Object.values(state.initializations)) {
      this.normalizeBinding(initialization.binding);
    }
    for (const job of Object.values(state.jobs)) {
      if (typeof job.requestId !== "string") job.requestId = `legacy:${job.jobId}`;
      if (typeof job.requestFingerprint !== "string") job.requestFingerprint = "legacy";
    }
    return state;
  }

  private normalizeBinding(binding: CompatibilityBinding): void {
    if (typeof binding.networkAccess !== "boolean") binding.networkAccess = false;
    if (typeof binding.model !== "string" || binding.model.length === 0) {
      binding.model = this.bindingDefaults.model;
    }
    if (!isLunaReasoning(binding.reasoningEffort)) {
      binding.reasoningEffort = this.bindingDefaults.reasoningEffort;
    }
    if (typeof binding.fast !== "boolean") binding.fast = this.bindingDefaults.fast;
    if (!Number.isSafeInteger(binding.timeoutMs) || binding.timeoutMs < 1_000) {
      binding.timeoutMs = this.bindingDefaults.timeoutMs;
    }
  }

  private save(): void {
    atomicWriteFile(this.path, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}

function isLunaReasoning(value: unknown): value is LunaReasoning {
  return ["none", "low", "medium", "high", "xhigh", "max"].includes(String(value));
}
