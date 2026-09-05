import type { HostConfig, PermissionProfile, RuntimeEffort, RunUsageSummary } from "./types.js";

export interface RuntimeEventSummary {
  type: string;
  sequence: number | null;
  at: string;
  data: Record<string, unknown>;
}

export interface WorkerRunRequest {
  taskId: string;
  sessionId: string | null;
  model: string;
  effort: RuntimeEffort;
  fast: boolean;
  cwd: string;
  permissionProfile: PermissionProfile;
  networkAccess: boolean;
  timeoutMs: number;
  prompt: string;
  onEvent: (event: RuntimeEventSummary) => Promise<void>;
}

export interface WorkerRunResult {
  messageId: string;
  status: "completed" | "failed" | "interrupted";
  reason: Record<string, unknown> | null;
  finalMessage: string | null;
  error: string | null;
  usage: RunUsageSummary;
  eventSummaries: RuntimeEventSummary[];
  validation: string[];
  diffText: string | null;
}

export const WORKER_NETWORK_ENFORCEMENT = process.platform === "win32" ? "model-policy-only" : "codex-sandbox";

export interface WorkerRuntimeStatus {
  engine: "codex-app-server-stdio";
  profile: {
    ready: boolean;
    codexVersion: string;
    profileDir: string;
    credentialConfigured: boolean;
    credentialKind: "chatgpt" | null;
  };
  provider: "openai";
  model: string;
  effort: string;
  activeTaskProcesses: number;
  codexProductRuntimeUsed: true;
  networkIsolation: "model-policy-only" | "codex-sandbox";
}

export interface WorkerRuntimeControl {
  prepare(): Promise<void>;
  status(): Promise<WorkerRuntimeStatus>;
  runTurn(request: WorkerRunRequest): Promise<WorkerRunResult>;
  interrupt(taskId: string): Promise<boolean>;
  probe(cwd?: string): Promise<Record<string, unknown>>;
  shutdown(): Promise<void>;
}

export function countActiveTaskProcesses(workers: Iterable<{ isAlive(): boolean; hasActiveRun(): boolean }>): number {
  let count = 0;
  for (const worker of workers) if (worker.isAlive() && worker.hasActiveRun()) count += 1;
  return count;
}

/** Only the child receives this environment. Neither the desktop login nor its config is reused. */
export function codexEnvironment(config: Pick<HostConfig, "codexHome">, inherited = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited };
  for (const key of Object.keys(env)) {
    if (/^(?:OPENAI_|CODEX_|DSH_|KAI_DSH_)/iu.test(key)) delete env[key];
  }
  env.CODEX_HOME = config.codexHome;
  return env;
}
