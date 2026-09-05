export const TASK_STATUSES = [
  "queued",
  "starting",
  "running",
  "awaiting_approval",
  "awaiting_input",
  "completed",
  "failed",
  "interrupted",
  "needs_resume",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type PermissionProfile = "read-only" | "workspace-write" | "danger-full-access";
export type ProjectTrust = "development" | "production" | "archive";
export type WorkerEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type RuntimeEffort = "none" | WorkerEffort;
export type ExecutionProfile = "lean" | "standard";

export interface RuntimeBinding {
  schemaVersion: 1;
  /** Old DSH bindings remain readable, but cannot be resumed by Codex. */
  engine: "codex-app-server-stdio" | "dsh-sdk-jsonrpc";
  provider: string;
  model: string;
  effort?: RuntimeEffort;
  fast?: boolean;
  profile: string;
  sessionId: string | null;
}

export interface TokenUsageBreakdown {
  /** Uncached input tokens. `inputTokens` is retained for receipt compatibility. */
  inputTokens: number;
  uncachedInputTokens?: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface UsageDiagnostics {
  /** Whether runtime usage was summed per event or deltaed from a provider snapshot. */
  accounting: "per-event-incremental" | "provider-cumulative-delta";
  usageEventCount: number;
  promptCharacterCount: number;
  toolCallCount: number;
  toolResultCount: number;
  providerCumulative: TokenUsageBreakdown | null;
  contextWindow: number | null;
  contextTokens: number | null;
  sessionHistoryTokens: number | null;
  toolSchemaTokens: number | null;
  overheadNote: string;
}

export interface RunUsageSummary {
  source: "runtime";
  /** Host cumulative across this task's completed turns, never a per-event sum. */
  cumulative: TokenUsageBreakdown | null;
  /** Incremental usage attributable to this run/turn. */
  incremental: TokenUsageBreakdown | null;
  /** Provider/runtime cumulative snapshot, when the protocol explicitly supplies one. */
  providerCumulative?: TokenUsageBreakdown | null;
  diagnostics?: UsageDiagnostics;
  modelContextWindow: number | null;
}

export interface HostIdentity {
  schemaVersion: 1;
  hostId: string;
  createdAt: string;
}

export interface ProjectRecord {
  schemaVersion: 1;
  projectId: string;
  name: string;
  rootPath: string;
  trust: ProjectTrust;
  allowedPermissionProfiles: PermissionProfile[];
  defaultPermissionProfile: PermissionProfile;
  networkAccess: boolean;
  instructions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskRequestLedgerEntry {
  operation: string;
  requestId: string;
  state: "reserved" | "completed" | "failed";
  result: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TaskTurnRecord {
  runId: string;
  requestId: string;
  /** Effective filesystem permission selected by WebGPT for this turn. */
  permissionProfile?: PermissionProfile;
  /** Effective tool-network policy selected for this turn. */
  networkAccess?: boolean;
  /** Effective wall-clock deadline selected for this Luna turn. */
  timeoutMs?: number;
  turnId: string | null;
  status: "starting" | "inProgress" | "completed" | "failed" | "interrupted" | "needs_resume";
  startedAt: string;
  completedAt: string | null;
  promptDigest: string | null;
  finalMessage: string | null;
  diffArtifact: string | null;
  receiptArtifact: string | null;
  runtimeBinding: RuntimeBinding | null;
  usage: RunUsageSummary | null;
  /** Error owned by this exact turn; task.lastError is only the latest mirror. */
  error?: string | null;
}

export interface PendingInteraction {
  interactionId: string;
  wireRequestId: string | number;
  method: string;
  kind: "approval" | "user_input" | "unsupported";
  supported: boolean;
  params: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
  resolution: Record<string, unknown> | null;
}

export interface TaskRecord {
  schemaVersion: 1;
  taskId: string;
  hostId: string;
  projectId: string;
  requestedBy: "webgpt_sol";
  goal: string;
  acceptanceCriteria: string[];
  constraints: string[];
  permissionProfile: PermissionProfile;
  networkAccess: boolean;
  status: TaskStatus;
  runtimeBinding?: RuntimeBinding | null;
  /** @deprecated Compatibility mirror for durable tasks created before runtimeBinding. */
  codexThreadId: string | null;
  activeTurnId: string | null;
  eventSequence: number;
  lastAgentMessage: string | null;
  lastError: string | null;
  contextSources: string[];
  turns: TaskTurnRecord[];
  pendingInteractions: PendingInteraction[];
  requestLedger: Record<string, TaskRequestLedgerEntry>;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  schemaVersion: 1;
  taskId: string;
  sequence: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export interface EpisodicMemory {
  schemaVersion: 1;
  episodeId: string;
  projectId: string;
  taskId: string;
  eventRange: { from: number; to: number };
  outcome: "completed" | "failed" | "interrupted";
  summary: string;
  validation: string[];
  artifactPaths: string[];
  createdAt: string;
}

export interface SemanticFact {
  schemaVersion: 1;
  factId: string;
  projectId: string;
  kind: "decision" | "constraint" | "environment" | "architecture";
  statement: string;
  evidenceRefs: string[];
  status: "active" | "superseded";
  createdAt: string;
  updatedAt: string;
}

export interface ContextCapsule {
  text: string;
  digest: string;
  sourceRefs: string[];
  characterCount: number;
}

export interface HostConfig {
  bindHost: string;
  port: number;
  stateRoot: string;
  codexHome: string;
  codexCliPath: string;
  workerModel: string;
  workerEffort: WorkerEffort;
  executionProfile: ExecutionProfile;
  runtimeStartupTimeoutMs: number;
  runtimeTurnTimeoutMs: number;
  bearerToken: string | null;
  maxContextCharacters: number;
  maxEventBatch: number;
}
