import { HostError } from "./errors.js";
import { newId, sha256 } from "./ids.js";
import type { DurableStore } from "./durable-store.js";
import type {
  ContextCapsule,
  EpisodicMemory,
  ProjectRecord,
  SemanticFact,
  TaskRecord,
} from "./types.js";

export interface RecordFactInput {
  projectId: string;
  factId?: string | undefined;
  kind: SemanticFact["kind"];
  statement: string;
  evidenceRefs: string[];
  status: SemanticFact["status"];
}

export class MemoryService {
  constructor(
    private readonly store: DurableStore,
    private readonly maxContextCharacters: number,
  ) {}

  async recordFact(input: RecordFactInput): Promise<SemanticFact> {
    if (input.evidenceRefs.length === 0) {
      throw new HostError("memory_evidence_required", "L2 facts require at least one evidence reference");
    }
    await this.store.getProject(input.projectId);
    const factId = input.factId ?? newId("fact");
    const prior = (await this.store.listFacts(input.projectId)).find((fact) => fact.factId === factId);
    const now = new Date().toISOString();
    return this.store.putFact({
      schemaVersion: 1,
      factId,
      projectId: input.projectId,
      kind: input.kind,
      statement: input.statement.trim(),
      evidenceRefs: [...new Set(input.evidenceRefs)],
      status: input.status,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async recordEpisode(
    task: TaskRecord,
    outcome: EpisodicMemory["outcome"],
    validation: string[],
    artifactPaths: string[],
    episodeId = newId("episode"),
  ): Promise<EpisodicMemory> {
    const episode: EpisodicMemory = {
      schemaVersion: 1,
      episodeId,
      projectId: task.projectId,
      taskId: task.taskId,
      eventRange: { from: 1, to: task.eventSequence },
      outcome,
      summary: task.lastAgentMessage ?? task.lastError ?? `${task.goal}: ${outcome}`,
      validation,
      artifactPaths,
      createdAt: new Date().toISOString(),
    };
    await this.store.appendEpisode(episode);
    return episode;
  }

  async compile(project: ProjectRecord, _task: TaskRecord, maxCharacters?: number): Promise<ContextCapsule> {
    // Only explicit project instructions. No L1/L2 query, ranking, promotion or automatic injection.
    // Task goal and authorization are supplied once by TaskOrchestrator.initialPrompt.
    const text = [
      "[PROJECT]",
      `root=${project.rootPath}`,
      ...project.instructions.map((instruction) => `instruction=${instruction}`),
    ].join("\n");
    if (text.length > (maxCharacters ?? this.maxContextCharacters)) {
      throw new HostError("project_context_too_large", "Explicit project instructions exceed the context limit; do not silently truncate authorization or constraints");
    }
    return { text, digest: sha256(text), sourceRefs: [`project:${project.projectId}`], characterCount: text.length };
  }
}
