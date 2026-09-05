import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const SAFE_ENVIRONMENT_KEYS = new Set([
  "KAI_WORK_HOST_BIND",
  "KAI_WORK_HOST_PORT",
  "KAI_WORK_HOST_HOME",
  "KAI_WORK_HOST_CODEX_HOME",
  "KAI_WORK_HOST_CODEX_CLI",
  "KAI_WORK_HOST_DSH_ROOT",
  "KAI_WORK_HOST_DSH_HOME",
  "KAI_WORK_HOST_DSH_CLI",
  "KAI_WORK_HOST_DSH_SDK_PLUGIN",
  "KAI_WORK_HOST_DSH_PROFILE",
  "KAI_WORK_HOST_DSH_PROVIDER",
  "KAI_WORK_HOST_WORKER_MODEL",
  "KAI_WORK_HOST_WORKER_EFFORT",
  "KAI_WORK_HOST_EXECUTION_PROFILE",
  "KAI_WORK_HOST_MAX_OUTPUT_TOKENS",
  "KAI_WORK_HOST_RUNTIME_STARTUP_MS",
  "KAI_WORK_HOST_RUNTIME_TURN_MS",
  "KAI_WORK_HOST_CONTEXT_CHARS",
  "KAI_WORK_HOST_EVENT_BATCH",
  "KAI_WORK_HOST_OPEN_BROWSER",
]);

export function applyDeploymentConfig(options = {}) {
  const root = path.resolve(options.projectRoot ?? projectRoot);
  const explicitPath = process.env.KAI_WORK_HOST_CONFIG?.trim();
  const configPath = path.resolve(explicitPath || path.join(root, "config", "work-host.local.json"));
  if (!existsSync(configPath)) {
    if (explicitPath) throw new Error(`KAI_WORK_HOST_CONFIG was not found: ${configPath}`);
    return { loaded: false, configPath, instanceId: null, applied: [] };
  }

  const document = JSON.parse(readFileSync(configPath, "utf8"));
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new TypeError(`Deployment config must be a JSON object: ${configPath}`);
  }
  if (document.schema_version !== 1) {
    throw new Error(`Unsupported deployment config schema_version in ${configPath}`);
  }
  if (typeof document.instance_id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(document.instance_id)) {
    throw new Error(`Deployment config instance_id must match ^[a-z][a-z0-9-]{0,31}$: ${configPath}`);
  }
  const environment = document.environment;
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError(`Deployment config environment must be an object: ${configPath}`);
  }

  const applied = [];
  for (const [name, value] of Object.entries(environment)) {
    if (!SAFE_ENVIRONMENT_KEYS.has(name)) {
      throw new Error(`Deployment config contains unsupported or secret-bearing key ${name}`);
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`Deployment config ${name} must be a non-empty string`);
    }
    if (process.env[name] === undefined) {
      process.env[name] = value;
      applied.push(name);
    }
  }
  process.env.KAI_WORK_HOST_INSTANCE_ID ??= document.instance_id;
  return { loaded: true, configPath, instanceId: document.instance_id, applied };
}

export const DEPLOYMENT_CONFIG_SAFE_KEYS = Object.freeze([...SAFE_ENVIRONMENT_KEYS].sort());
