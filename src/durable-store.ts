import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { HostError } from "./errors.js";
import { newId } from "./ids.js";
import type {
  EpisodicMemory,
  HostIdentity,
  ProjectRecord,
  SemanticFact,
  TaskEvent,
  TaskRecord,
  TaskRequestLedgerEntry,
} from "./types.js";

const ACTIVE_STATUSES = new Set(["queued", "starting", "running", "awaiting_approval", "awaiting_input"]);

interface TaskTransaction {
  schemaVersion: 1;
  task: TaskRecord;
  event: TaskEvent;
}

export class DurableStore extends EventEmitter {
  readonly root: string;
  private readonly locks = new Map<string, Promise<void>>();
  private hostIdentity: HostIdentity | null = null;

  constructor(root: string) {
    super();
    this.root = path.resolve(root);
  }

  async initialize(): Promise<HostIdentity> {
    await Promise.all([
      mkdir(this.root, { recursive: true }),
      mkdir(path.join(this.root, "tasks"), { recursive: true }),
      mkdir(path.join(this.root, "memory"), { recursive: true }),
    ]);
    await this.recoverPendingTaskTransactions();

    const hostPath = path.join(this.root, "host.json");
    const existing = await this.readJson<HostIdentity | null>(hostPath, null);
    if (existing !== null) {
      this.hostIdentity = existing;
    } else {
      this.hostIdentity = {
        schemaVersion: 1,
        hostId: newId("host"),
        createdAt: new Date().toISOString(),
      };
      await this.writeJsonAtomic(hostPath, this.hostIdentity);
    }

    await this.markUncertainTasksForRecovery();
    return this.hostIdentity;
  }

  getHostIdentity(): HostIdentity {
    if (this.hostIdentity === null) {
      throw new HostError("host_not_initialized", "The durable store has not been initialized");
    }
    return this.hostIdentity;
  }

  async canonicalDirectory(candidate: string): Promise<string> {
    const resolved = path.resolve(candidate);
    const metadata = await stat(resolved).catch(() => null);
    if (metadata === null || !metadata.isDirectory()) {
      throw new HostError("project_root_invalid", `Project root is not an existing directory: ${resolved}`);
    }
    await access(resolved, fsConstants.R_OK);
    return realpath(resolved);
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return this.readJson<ProjectRecord[]>(path.join(this.root, "projects.json"), []);
  }

  async getProject(projectId: string): Promise<ProjectRecord> {
    const project = (await this.listProjects()).find((candidate) => candidate.projectId === projectId);
    if (project === undefined) {
      throw new HostError("project_not_found", `Unknown project: ${projectId}`);
    }
    return project;
  }

  async upsertProject(project: ProjectRecord): Promise<ProjectRecord> {
    return this.withLock("projects", async () => {
      const projects = await this.listProjects();
      const rootCollision = projects.find(
        (candidate) =>
          candidate.projectId !== project.projectId &&
          candidate.rootPath.localeCompare(project.rootPath, undefined, { sensitivity: "accent" }) === 0,
      );
      if (rootCollision !== undefined) {
        throw new HostError(
          "project_root_registered",
          `Project root is already registered as ${rootCollision.projectId}`,
        );
      }
      const index = projects.findIndex((candidate) => candidate.projectId === project.projectId);
      if (index === -1) projects.push(project);
      else projects[index] = project;
      projects.sort((left, right) => left.projectId.localeCompare(right.projectId));
      await this.writeJsonAtomic(path.join(this.root, "projects.json"), projects);
      return project;
    });
  }

  async createTask(task: TaskRecord): Promise<TaskRecord> {
    return this.withLock(`task:${task.taskId}`, async () => {
      const directory = this.taskDirectory(task.taskId);
      await mkdir(directory, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") {
          throw new HostError("task_exists", `Task already exists: ${task.taskId}`);
        }
        throw error;
      });
      const event: TaskEvent = {
        schemaVersion: 1,
        taskId: task.taskId,
        sequence: 1,
        type: "task.created",
        at: task.createdAt,
        data: { projectId: task.projectId, status: task.status },
      };
      task.eventSequence = event.sequence;
      await this.commitTaskTransition(task, event);
      this.emit("taskEvent", event);
      return task;
    });
  }

  async getTask(taskId: string): Promise<TaskRecord> {
    const task = await this.readJson<TaskRecord | null>(this.taskPath(taskId), null);
    if (task === null) throw new HostError("task_not_found", `Unknown task: ${taskId}`);
    return task;
  }

  async listTasks(): Promise<TaskRecord[]> {
    const directory = path.join(this.root, "tasks");
    const entries = await readdir(directory, { withFileTypes: true });
    const tasks = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readJson<TaskRecord | null>(this.taskPath(entry.name), null)),
    );
    return tasks
      .filter((task): task is TaskRecord => task !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async transitionTask(
    taskId: string,
    mutate: (task: TaskRecord) => void,
    eventType: string,
    data: Record<string, unknown>,
    beforeCommit?: ((task: TaskRecord, event: TaskEvent) => Promise<void>) | undefined,
  ): Promise<{ task: TaskRecord; event: TaskEvent }> {
    return this.withLock(`task:${taskId}`, async () => {
      await this.recoverTaskTransaction(taskId);
      const task = await this.getTask(taskId);
      mutate(task);
      task.updatedAt = new Date().toISOString();
      const event: TaskEvent = {
        schemaVersion: 1,
        taskId,
        sequence: task.eventSequence + 1,
        type: eventType,
        at: task.updatedAt,
        data,
      };
      task.eventSequence = event.sequence;
      await beforeCommit?.(task, event);
      await this.commitTaskTransition(task, event);
      this.emit("taskEvent", event);
      return { task, event };
    });
  }

  async reserveTaskRequest(
    taskId: string,
    operation: string,
    requestId: string,
    provisionalResult: Record<string, unknown>,
  ): Promise<{ entry: TaskRequestLedgerEntry; isNew: boolean }> {
    let reserved: TaskRequestLedgerEntry | null = null;
    let isNew = false;
    await this.transitionTask(
      taskId,
      (task) => {
        const key = `${operation}:${requestId}`;
        const existing = task.requestLedger[key];
        if (existing !== undefined) {
          reserved = existing;
          return;
        }
        const now = new Date().toISOString();
        reserved = {
          operation,
          requestId,
          state: "reserved",
          result: provisionalResult,
          createdAt: now,
          updatedAt: now,
        };
        task.requestLedger[key] = reserved;
        isNew = true;
      },
      "request.reserved",
      { operation, requestId },
    );
    if (reserved === null) throw new HostError("request_reservation_failed", "Request reservation failed");
    return { entry: reserved, isNew };
  }

  async completeTaskRequest(
    taskId: string,
    operation: string,
    requestId: string,
    result: Record<string, unknown>,
    failed = false,
  ): Promise<TaskRequestLedgerEntry> {
    let completed: TaskRequestLedgerEntry | null = null;
    await this.transitionTask(
      taskId,
      (task) => {
        const key = `${operation}:${requestId}`;
        const existing = task.requestLedger[key];
        if (existing === undefined) {
          throw new HostError("request_not_reserved", `Request was not reserved: ${key}`);
        }
        existing.state = failed ? "failed" : "completed";
        existing.result = result;
        existing.updatedAt = new Date().toISOString();
        completed = existing;
      },
      failed ? "request.failed" : "request.completed",
      { operation, requestId },
    );
    if (completed === null) throw new HostError("request_completion_failed", "Request completion failed");
    return completed;
  }

  async readEvents(taskId: string, afterSequence = 0, limit = 40): Promise<TaskEvent[]> {
    await this.getTask(taskId);
    const raw = await readFile(this.eventsPath(taskId), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return raw
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TaskEvent)
      .filter((event) => event.sequence > afterSequence)
      .slice(0, limit);
  }

  async waitForEvents(taskId: string, afterSequence: number, timeoutMs: number, limit: number): Promise<TaskEvent[]> {
    const existing = await this.readEvents(taskId, afterSequence, limit);
    if (existing.length > 0 || timeoutMs === 0) return existing;

    return new Promise<TaskEvent[]>((resolve, reject) => {
      let settled = false;
      const finish = (events: TaskEvent[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off("taskEvent", listener);
        resolve(events);
      };
      const listener = (event: TaskEvent): void => {
        if (event.taskId !== taskId || event.sequence <= afterSequence) return;
        void this.readEvents(taskId, afterSequence, limit).then(finish, reject);
      };
      const timer = setTimeout(() => finish([]), timeoutMs);
      this.on("taskEvent", listener);
    });
  }

  async writeArtifact(taskId: string, name: string, content: string): Promise<string> {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(name)) {
      throw new HostError("artifact_name_invalid", `Invalid artifact name: ${name}`);
    }
    await this.getTask(taskId);
    const directory = path.join(this.taskDirectory(taskId), "artifacts");
    await mkdir(directory, { recursive: true });
    const artifactPath = path.join(directory, name);
    await writeFile(artifactPath, content, "utf8");
    return artifactPath;
  }

  async writeContextSnapshot(taskId: string, runId: string, value: Record<string, unknown>): Promise<string> {
    const fileName = `context-${runId}.json`;
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    return this.writeArtifact(taskId, fileName, serialized);
  }

  async appendEpisode(episode: EpisodicMemory): Promise<void> {
    const directory = this.projectMemoryDirectory(episode.projectId);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "l1.jsonl");
    await this.withLock(`memory:${episode.projectId}:l1`, async () => {
      const raw = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      const duplicate = raw
        .split(/\r?\n/u)
        .filter(Boolean)
        .some((line) => (JSON.parse(line) as EpisodicMemory).episodeId === episode.episodeId);
      if (duplicate) return;
      await appendFile(file, `${JSON.stringify(episode)}\n`, "utf8");
    });
  }

  async listEpisodes(projectId: string, limit = 8): Promise<EpisodicMemory[]> {
    const file = path.join(this.projectMemoryDirectory(projectId), "l1.jsonl");
    const raw = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return raw
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EpisodicMemory)
      .slice(-limit)
      .reverse();
  }

  async putFact(fact: SemanticFact): Promise<SemanticFact> {
    const directory = this.projectMemoryDirectory(fact.projectId);
    await mkdir(directory, { recursive: true });
    return this.withLock(`memory:${fact.projectId}:l2`, async () => {
      const file = path.join(directory, "l2.json");
      const facts = await this.readJson<SemanticFact[]>(file, []);
      const index = facts.findIndex((candidate) => candidate.factId === fact.factId);
      if (index === -1) facts.push(fact);
      else facts[index] = fact;
      facts.sort((left, right) => left.factId.localeCompare(right.factId));
      await this.writeJsonAtomic(file, facts);
      return fact;
    });
  }

  async listFacts(projectId: string): Promise<SemanticFact[]> {
    return this.readJson<SemanticFact[]>(path.join(this.projectMemoryDirectory(projectId), "l2.json"), []);
  }

  private async markUncertainTasksForRecovery(): Promise<void> {
    const tasks = await this.listTasks();
    for (const task of tasks) {
      if (!ACTIVE_STATUSES.has(task.status)) continue;
      await this.transitionTask(
        task.taskId,
        (current) => {
          current.status = "needs_resume";
          current.lastError = "Host restarted while the task was non-terminal; no model turn was replayed.";
          current.activeTurnId = null;
          const active = [...current.turns].reverse().find(turn =>
            ["starting", "inProgress"].includes(turn.status));
          if (active !== undefined) {
            active.status = "needs_resume";
            active.completedAt = new Date().toISOString();
            active.error = current.lastError;
          }
        },
        "task.recovery_required",
        { previousStatus: task.status, replayed: false },
      );
    }
  }

  private taskDirectory(taskId: string): string {
    return path.join(this.root, "tasks", taskId);
  }

  private taskPath(taskId: string): string {
    return path.join(this.taskDirectory(taskId), "task.json");
  }

  private eventsPath(taskId: string): string {
    return path.join(this.taskDirectory(taskId), "events.jsonl");
  }

  private transactionPath(taskId: string): string {
    return path.join(this.taskDirectory(taskId), "transaction.json");
  }

  private projectMemoryDirectory(projectId: string): string {
    return path.join(this.root, "memory", projectId);
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    const raw = await this.readPrimaryOrBackup(file);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw new HostError("durable_json_invalid", `Invalid durable JSON: ${file}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async writeJsonAtomic(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${newId("tmp")}`;
    const backup = `${file}.bak`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      await rename(temporary, file);
      await this.unlinkIfPresent(backup);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!new Set(["EACCES", "EEXIST", "EPERM"]).has(code ?? "")) throw error;
    }

    await this.unlinkIfPresent(backup);
    let originalMoved = false;
    try {
      await rename(file, backup);
      originalMoved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(temporary, file);
    } catch (error) {
      if (originalMoved) await rename(backup, file).catch(() => undefined);
      throw error;
    }
    if (originalMoved) await this.unlinkIfPresent(backup);
  }

  private async readPrimaryOrBackup(file: string): Promise<string | null> {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      return await readFile(`${file}.bak`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async commitTaskTransition(task: TaskRecord, event: TaskEvent): Promise<void> {
    const transaction: TaskTransaction = { schemaVersion: 1, task, event };
    await this.writeJsonAtomic(this.transactionPath(task.taskId), transaction);
    try {
      await this.appendEventIfMissing(event);
      await this.writeJsonAtomic(this.taskPath(task.taskId), task);
      await this.unlinkIfPresent(this.transactionPath(task.taskId));
    } catch (error) {
      try {
        await this.recoverTaskTransaction(task.taskId);
      } catch {
        throw error;
      }
    }
  }

  private async appendEventIfMissing(event: TaskEvent): Promise<void> {
    const file = this.eventsPath(event.taskId);
    const raw = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const events = raw
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TaskEvent);
    const existing = events.find((candidate) => candidate.sequence === event.sequence);
    if (existing !== undefined) {
      if (existing.type !== event.type || existing.taskId !== event.taskId) {
        throw new HostError("event_sequence_conflict", `Conflicting event sequence ${event.sequence} for ${event.taskId}`);
      }
      return;
    }
    const lastSequence = events.at(-1)?.sequence ?? 0;
    if (event.sequence !== lastSequence + 1) {
      throw new HostError(
        "event_sequence_gap",
        `Expected event sequence ${lastSequence + 1} for ${event.taskId}, got ${event.sequence}`,
      );
    }
    await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
  }

  private async recoverPendingTaskTransactions(): Promise<void> {
    const directory = path.join(this.root, "tasks");
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) await this.recoverTaskTransaction(entry.name);
    }
  }

  private async recoverTaskTransaction(taskId: string): Promise<void> {
    const transaction = await this.readJson<TaskTransaction | null>(this.transactionPath(taskId), null);
    if (transaction === null) return;
    if (transaction.task.taskId !== taskId || transaction.event.taskId !== taskId) {
      throw new HostError("task_transaction_invalid", `Task transaction does not belong to ${taskId}`);
    }
    await this.appendEventIfMissing(transaction.event);
    await this.writeJsonAtomic(this.taskPath(taskId), transaction.task);
    await this.unlinkIfPresent(this.transactionPath(taskId));
  }

  private async unlinkIfPresent(file: string): Promise<void> {
    await unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => gate);
    this.locks.set(key, tail);
    await prior;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}
