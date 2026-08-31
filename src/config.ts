import os from "node:os";
import path from "node:path";

import { DSH_DIRECTORY_NAME } from "./dsh-pin.js";
import type { ExecutionProfile, HostConfig, WorkerEffort } from "./types.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const EFFORTS = new Set<WorkerEffort>(["low", "medium", "high", "xhigh", "max"]);
const EXECUTION_PROFILES = new Set<ExecutionProfile>(["lean", "standard"]);

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function defaultStateRoot(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim()
      || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "KAI", "WorkHost");
  }
  return path.join(os.homedir(), ".local", "share", "kai-work-host");
}

export function loadConfig(): HostConfig {
  const bindHost = process.env.KAI_WORK_HOST_BIND ?? "127.0.0.1";
  const bearerToken = process.env.KAI_WORK_HOST_BEARER_TOKEN?.trim() || null;
  if (!LOOPBACK_HOSTS.has(bindHost) && bearerToken === null) {
    throw new Error("A non-loopback bind requires KAI_WORK_HOST_BEARER_TOKEN");
  }

  const effortRaw = (process.env.KAI_WORK_HOST_WORKER_EFFORT ?? "high") as WorkerEffort;
  if (!EFFORTS.has(effortRaw)) {
    throw new Error("KAI_WORK_HOST_WORKER_EFFORT must be low, medium, high, xhigh, or max");
  }
  const workerModel = process.env.KAI_WORK_HOST_WORKER_MODEL ?? "gpt-5.6-luna";
  if (!/luna/iu.test(workerModel)) {
    throw new Error("KAI_WORK_HOST_WORKER_MODEL must be a Luna model; WebGPT Sol remains the high-level planner");
  }

  const executionProfile = (process.env.KAI_WORK_HOST_EXECUTION_PROFILE ?? "lean") as ExecutionProfile;
  if (!EXECUTION_PROFILES.has(executionProfile)) {
    throw new Error("KAI_WORK_HOST_EXECUTION_PROFILE must be lean or standard");
  }

  const stateRoot = path.resolve(process.env.KAI_WORK_HOST_HOME ?? defaultStateRoot());
  const dshRoot = path.resolve(
    process.env.KAI_WORK_HOST_DSH_ROOT ??
      path.join(stateRoot, "dependencies", DSH_DIRECTORY_NAME),
  );
  const provider = process.env.KAI_WORK_HOST_DSH_PROVIDER ?? "openai-codex";
  if (provider !== "openai-codex") {
    throw new Error("KAI_WORK_HOST_DSH_PROVIDER must be openai-codex");
  }
  const outputTokens = integerEnv("KAI_WORK_HOST_MAX_OUTPUT_TOKENS", 32_768, 1_024, 131_072);

  return {
    bindHost,
    port: integerEnv("KAI_WORK_HOST_PORT", 8787, 1, 65_535),
    stateRoot,
    dshRoot,
    dshHome: path.resolve(process.env.KAI_WORK_HOST_DSH_HOME ?? path.join(stateRoot, "dsh")),
    dshCliPath: path.resolve(
      process.env.KAI_WORK_HOST_DSH_CLI ?? path.join(dshRoot, "apps", "cli", "lib", "bin.js"),
    ),
    dshSdkPluginRoot: path.resolve(
      process.env.KAI_WORK_HOST_DSH_SDK_PLUGIN ?? path.join(dshRoot, "packages", "sdk", "server"),
    ),
    dshProfile: process.env.KAI_WORK_HOST_DSH_PROFILE ?? "kai-work-host",
    dshProvider: provider,
    workerModel,
    workerEffort: effortRaw,
    executionProfile,
    workerMaxOutputTokens: outputTokens,
    runtimeStartupTimeoutMs: integerEnv("KAI_WORK_HOST_RUNTIME_STARTUP_MS", 20_000, 2_000, 120_000),
    runtimeTurnTimeoutMs: integerEnv("KAI_WORK_HOST_RUNTIME_TURN_MS", 1_800_000, 10_000, 7_200_000),
    bearerToken,
    maxContextCharacters: integerEnv(
      "KAI_WORK_HOST_CONTEXT_CHARS",
      12_000,
      2_000,
      40_000,
    ),
    maxEventBatch: integerEnv("KAI_WORK_HOST_EVENT_BATCH", 40, 1, 200),
  };
}
