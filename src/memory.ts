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
  ): Promise<EpisodicMemory> {
    const episode: EpisodicMemory = {
      schemaVersion: 1,
      episodeId: newId("episode"),
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

  async compile(project: ProjectRecord, task: TaskRecord, maxCharacters?: number): Promise<ContextCapsule> {
    const maxContextCharacters = maxCharacters ?? this.maxContextCharacters;
    const [episodes, facts] = await Promise.all([
      this.store.listEpisodes(project.projectId, 16),
      this.store.listFacts(project.projectId),
    ]);
    const query = [task.goal, ...task.acceptanceCriteria, ...task.constraints].join("\n");
    const queryKeywords = keywords(query);
    const activeFacts = dedupeByStatement(facts.filter((fact) => fact.status === "active"))
      .sort((left, right) =>
        relevance(right.statement, queryKeywords) - relevance(left.statement, queryKeywords) ||
        right.updatedAt.localeCompare(left.updatedAt),
      )
      .slice(0, 8);
    const relevantEpisodes = [...episodes]
      .sort((left, right) =>
        relevance(right.summary, queryKeywords) - relevance(left.summary, queryKeywords) ||
        right.createdAt.localeCompare(left.createdAt),
      )
      .slice(0, 4);
    const sections: Array<{ ref: string; text: string }> = [
      {
        ref: `project:${project.projectId}`,
        text: [
          "[PROJECT]",
          `id=${project.projectId}`,
          `name=${project.name}`,
          `root=${project.rootPath}`,
          `trust=${project.trust}`,
          ...project.instructions.map((instruction) => `instruction=${instruction}`),
        ].join("\n"),
      },
      {
        ref: `l0:${task.taskId}`,
        text: [
          "[L0 CURRENT TASK]",
          `task=${task.taskId}`,
          `status=${task.status}`,
          `permission=${task.permissionProfile}`,
          `network=${String(task.networkAccess)}`,
          ...(task.lastAgentMessage === null ? [] : [`last_result=${task.lastAgentMessage.slice(0, 1_200)}`]),
        ].join("\n"),
      },
      ...activeFacts.map((fact) => ({
        ref: `l2:${fact.factId}`,
        text: [
          `[L2 ${fact.kind.toUpperCase()} ${fact.factId}]`,
          fact.statement,
          `evidence=${fact.evidenceRefs.join(",")}`,
        ].join("\n"),
      })),
      ...relevantEpisodes.map((episode) => ({
        ref: `l1:${episode.episodeId}`,
        text: [
          `[L1 EPISODE ${episode.taskId} ${episode.outcome}]`,
          episode.summary,
          `events=${episode.eventRange.from}-${episode.eventRange.to}`,
          `validation=${episode.validation.join(" | ") || "none recorded"}`,
        ].join("\n"),
      })),
    ];

    const selected: string[] = [];
    const sourceRefs: string[] = [];
    let used = 0;
    for (const [index, section] of sections.entries()) {
      const separatorCost = selected.length === 0 ? 0 : 2;
      const remaining = maxContextCharacters - used - separatorCost;
      if (remaining <= 0) break;
      const preferredCap = index === 0
        ? Math.max(800, Math.floor(maxContextCharacters * 0.28))
        : index === 1
          ? Math.max(500, Math.floor(maxContextCharacters * 0.14))
          : Math.max(400, Math.floor(maxContextCharacters * 0.12));
      const text = clipSection(section.text, Math.min(remaining, preferredCap));
      if (text.length === 0) continue;
      selected.push(text);
      sourceRefs.push(section.ref);
      used += text.length + separatorCost;
    }
    const text = selected.join("\n\n");
    return {
      text,
      digest: sha256(text),
      sourceRefs,
      characterCount: text.length,
    };
  }
}

function dedupeByStatement(facts: SemanticFact[]): SemanticFact[] {
  const seen = new Set<string>();
  const result: SemanticFact[] = [];
  for (const fact of [...facts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    const key = fact.statement.trim().toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
  }
  return result;
}

function keywords(text: string): Set<string> {
  const lowered = text.toLocaleLowerCase();
  const result = new Set(
    lowered.split(/[^\p{L}\p{N}_-]+/u).map((value) => value.trim()).filter((value) => value.length >= 2),
  );
  const cjk = [...lowered].filter((character) => /\p{Script=Han}/u.test(character));
  for (let index = 0; index + 1 < cjk.length; index += 1) {
    result.add(`${cjk[index]}${cjk[index + 1]}`);
  }
  return result;
}

function relevance(text: string, query: Set<string>): number {
  if (query.size === 0) return 0;
  const candidate = keywords(text);
  let score = 0;
  for (const value of candidate) if (query.has(value)) score += 1;
  return score;
}

function clipSection(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = "\n[TRUNCATED]";
  if (limit <= marker.length) return text.slice(0, limit);
  return `${text.slice(0, limit - marker.length)}${marker}`;
}
