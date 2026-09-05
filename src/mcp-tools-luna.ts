import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  CompatibilityService,
  KAI_COMPACT_SESSION_POLICY,
  KAI_SESSION_BOUNDARY_NOTICE,
  KAI_SESSION_POLICY,
} from "./compat/compatibility-service.js";
import { IMAGE_PREVIEW_RESOURCE_URI } from "./compat/image-preview.js";
import type { HostMcpRuntime } from "./mcp-runtime.js";
import {
  jobStatus,
  noAuth,
  readAnnotations,
  reasoning,
  requestMeta,
  result,
  safe,
  sandbox,
  sessionId,
  writeAnnotations,
} from "./mcp-shared.js";
import type { HostConfig, TaskTurnRecord } from "./types.js";
import { WORKER_NETWORK_ENFORCEMENT } from "./worker-runtime.js";

export function registerLunaTools(
  server: McpServer,
  runtime: HostMcpRuntime,
  config: HostConfig,
): void {
  const compatibility = runtime.compatibility;

  server.registerTool(
    "codexluna_init",
    {
      title: "Initialize this ChatGPT conversation",
      description: "Initialize or restore this WebGPT conversation on KAI Work Host. The exact workspace is registered locally, and KAI L0 runtime state, L1 verified episodes, and evidence-backed L2 project memory become available to Luna without exposing separate KAI management tools.",
      inputSchema: z.object({
        web_session_id: sessionId.optional(),
        workspace_path: z.string().min(1).max(16_384).describe("Exact local project root selected by the user."),
        model: z.string().min(1).max(200).default(config.workerModel)
          .describe("Luna-family worker model selected by WebGPT; the Host value is only the default."),
        reasoning_effort: reasoning.default(config.workerEffort)
          .describe(`Worker effort selected by WebGPT; this Host allows up to ${config.workerEffort}.`),
        fast: z.boolean().default(config.executionProfile === "lean")
          .describe("KAI compact-context/direct-execution mode; this is not a provider fast tier."),
        permission_mode: sandbox.describe("Required filesystem authorization for this conversation and the initial Project ceiling."),
        network_access: z.boolean().default(false).describe("Requested tool-network policy; existing Projects cannot be expanded here."),
        timeout_ms: z.number().int().min(1_000).max(86_400_000).default(config.runtimeTurnTimeoutMs)
          .describe("Turn timeout in milliseconds, clamped to the Host maximum."),
        request_id: z.string().min(8).max(256).describe("Stable unique identity; reuse only when retrying this exact initialization."),
      }),
      outputSchema: z.object({
        initialized: z.boolean(),
        web_session_id: sessionId,
        workspace_path: z.string(),
        permission_mode: sandbox,
        network_access: z.boolean(),
        network_enforcement: z.enum(["model-policy-only", "codex-sandbox"]),
        model: z.string(),
        reasoning_effort: reasoning,
        fast: z.boolean(),
        timeout_ms: z.number().int(),
        request_id: z.string(),
        luna_session_id: z.string().nullable(),
        session_policy: z.record(z.string(), z.unknown()),
        session_boundary_notice: z.string(),
        kai_memory: z.object({ l0: z.boolean(), l1: z.boolean(), l2: z.boolean(), project_id: z.string() }),
      }),
      annotations: writeAnnotations(false, false),
      _meta: { securitySchemes: noAuth },
    },
    safe(async (input, context) => {
      assertLunaModel(input.model);
      assertReasoningWithinHostLimit(input.reasoning_effort, config.workerEffort);
      const webSessionId = CompatibilityService.conversationSessionId(
        input.web_session_id,
        requestMeta(context),
        true,
      );
      const initialized = await compatibility.initialize(webSessionId, {
        workspacePath: input.workspace_path,
        permissionMode: input.permission_mode,
        model: input.model,
        reasoningEffort: input.reasoning_effort,
        fast: input.fast,
        timeoutMs: input.timeout_ms,
        networkAccess: input.network_access,
        requestId: input.request_id,
      });
      const binding = initialized.binding;
      return result({
        initialized: true,
        web_session_id: binding.webSessionId,
        workspace_path: binding.workspacePath,
        permission_mode: binding.permissionMode,
        network_access: binding.networkAccess,
        network_enforcement: WORKER_NETWORK_ENFORCEMENT,
        model: binding.model,
        reasoning_effort: binding.reasoningEffort,
        fast: binding.fast,
        timeout_ms: binding.timeoutMs,
        request_id: initialized.requestId,
        luna_session_id: await compatibilitySessionId(compatibility, binding.lastJobId),
        session_policy: KAI_SESSION_POLICY,
        session_boundary_notice: KAI_SESSION_BOUNDARY_NOTICE,
        kai_memory: { l0: true, l1: false, l2: false, project_id: binding.projectId },
      });
    }),
  );

  server.registerTool(
    "codexluna_start",
    {
      title: "Start Luna execution",
      description: "Start one asynchronous local Luna turn through KAI Work Host after codexluna_init. Later starts in the same conversation resume the same official Codex thread with incremental instructions and no automatic cross-task memory.",
      inputSchema: z.object({
        web_session_id: sessionId.optional(),
        prompt: z.string().min(1).max(12_000),
        workspace_path: z.string().min(1).max(16_384).optional(),
        model: z.string().min(1).max(200).optional().describe("Optional Luna-family model for this turn."),
        reasoning_effort: reasoning.optional().describe(`Optional effort for this turn; maximum ${config.workerEffort}.`),
        fast: z.boolean().optional().describe("Optional KAI compact/direct mode for this turn; not a provider fast tier."),
        permission_mode: sandbox.optional().describe("Optional per-turn filesystem mode within the registered Project ceiling."),
        timeout_ms: z.number().int().min(1_000).max(86_400_000).optional().describe("Optional per-turn timeout in milliseconds."),
        network_access: z.boolean().optional().describe("Optional per-turn network policy within the registered Project ceiling."),
        request_id: z.string().min(8).max(256).describe("Stable unique identity; reuse only when retrying this exact Luna instruction."),
      }),
      outputSchema: z.object({
        web_session_id: sessionId,
        job_id: z.string().uuid(),
        status: jobStatus,
        workspace_path: z.string(),
        permission_mode: sandbox,
        network_access: z.boolean(),
        network_enforcement: z.enum(["model-policy-only", "codex-sandbox"]),
        model: z.string(),
        reasoning_effort: reasoning,
        fast: z.boolean(),
        timeout_ms: z.number().int(),
        request_id: z.string(),
        session_policy: z.string(),
      }),
      annotations: writeAnnotations(false, true, true),
      _meta: { securitySchemes: noAuth },
    },
    safe(async (input, context) => {
      if (input.model !== undefined) assertLunaModel(input.model);
      if (input.reasoning_effort !== undefined) {
        assertReasoningWithinHostLimit(input.reasoning_effort, config.workerEffort);
      }
      const webSessionId = CompatibilityService.conversationSessionId(
        input.web_session_id,
        requestMeta(context),
        false,
      );
      const started = await compatibility.start({
        webSessionId,
        prompt: input.prompt,
        requestId: input.request_id,
        ...(input.workspace_path === undefined ? {} : { workspacePath: input.workspace_path }),
        ...(input.permission_mode === undefined ? {} : { permissionMode: input.permission_mode }),
        ...(input.network_access === undefined ? {} : { networkAccess: input.network_access }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.reasoning_effort === undefined ? {} : { reasoningEffort: input.reasoning_effort }),
        ...(input.fast === undefined ? {} : { fast: input.fast }),
        ...(input.timeout_ms === undefined ? {} : { timeoutMs: input.timeout_ms }),
      });
      return result({
        web_session_id: webSessionId,
        job_id: started.job.jobId,
        status: started.status,
        workspace_path: started.binding.workspacePath,
        permission_mode: started.binding.permissionMode,
        network_access: started.binding.networkAccess,
        network_enforcement: WORKER_NETWORK_ENFORCEMENT,
        model: started.binding.model,
        reasoning_effort: started.binding.reasoningEffort,
        fast: started.binding.fast,
        timeout_ms: started.binding.timeoutMs,
        request_id: started.job.requestId,
        session_policy: KAI_COMPACT_SESSION_POLICY,
      });
    }),
  );

  server.registerTool(
    "codexluna_status",
    {
      title: "Get Luna execution status",
      description: "Poll an asynchronous KAI-hosted Luna turn. Completed results are concise; durable events, memory provenance, diff artifacts, and receipts remain local.",
      inputSchema: z.object({ job_id: z.string().uuid(), web_session_id: sessionId.optional() }),
      outputSchema: z.object({
        web_session_id: sessionId,
        job_id: z.string().uuid(),
        status: jobStatus,
        luna_session_id: z.string().nullable(),
        workspace_path: z.string(),
        permission_mode: sandbox,
        network_access: z.boolean(),
        network_enforcement: z.enum(["model-policy-only", "codex-sandbox"]),
        model: z.string(),
        reasoning_effort: reasoning,
        fast: z.boolean(),
        timeout_ms: z.number().int(),
        request_id: z.string(),
        terminal_event: z.string().nullable(),
        final_message: z.string().nullable(),
        error: z.string().nullable(),
        mutation_seen: z.boolean(),
        mutation_observation: z.enum(["diff_artifact", "not_observed"]),
        event_count: z.number().int().nonnegative(),
        image_artifacts: z.array(z.string()),
        image_preview_rendered: z.boolean(),
        image_preview_error: z.string().nullable(),
        image_preview_id: z.string().uuid().nullable(),
        session_policy: z.string(),
      }),
      annotations: readAnnotations(),
      _meta: {
        securitySchemes: noAuth,
        ui: { resourceUri: IMAGE_PREVIEW_RESOURCE_URI, visibility: ["model", "app"] },
        "ui/resourceUri": IMAGE_PREVIEW_RESOURCE_URI,
        "openai/outputTemplate": IMAGE_PREVIEW_RESOURCE_URI,
        "openai/toolInvocation/invoking": "正在檢查 Luna 任務",
        "openai/toolInvocation/invoked": "Luna 任務狀態已更新",
      },
    },
    safe(async ({ job_id, web_session_id }, context) => {
      const resolved = CompatibilityService.conversationSessionId(
        web_session_id,
        requestMeta(context),
        false,
      );
      return result(statusPayload(await compatibility.status(job_id, resolved)));
    }),
  );

  server.registerTool(
    "codexluna_cancel",
    {
      title: "Cancel Luna execution",
      description: "Cancel only the active KAI-owned Luna turn for this job; its WebGPT binding, Codex thread, receipts, and original records are preserved.",
      inputSchema: z.object({ job_id: z.string().uuid(), web_session_id: sessionId.optional() }),
      outputSchema: z.object({
        web_session_id: sessionId,
        job_id: z.string().uuid(),
        status: jobStatus,
        luna_session_id: z.string().nullable(),
        session_policy: z.string(),
      }),
      annotations: writeAnnotations(true, true),
      _meta: { securitySchemes: noAuth },
    },
    safe(async ({ job_id, web_session_id }, context) => {
      const resolved = CompatibilityService.conversationSessionId(
        web_session_id,
        requestMeta(context),
        false,
      );
      const current = await compatibility.cancel(job_id, resolved);
      return result({
        web_session_id: current.binding.webSessionId,
        job_id,
        status: current.status,
        luna_session_id: runtimeSessionId(current.turn),
        session_policy: KAI_COMPACT_SESSION_POLICY,
      });
    }),
  );

  server.registerTool(
    "codexluna_session",
    {
      title: "Inspect Luna session binding",
      description: "Inspect the durable KAI/Codex Luna binding for this ChatGPT conversation without creating or running a turn.",
      inputSchema: z.object({ web_session_id: sessionId.optional() }),
      outputSchema: z.object({
        binding: z.object({
          web_session_id: sessionId,
          luna_session_id: z.string().nullable(),
          workspace_path: z.string(),
          permission_mode: sandbox,
          network_access: z.boolean(),
          network_enforcement: z.enum(["model-policy-only", "codex-sandbox"]),
          model: z.string(),
          reasoning_effort: reasoning,
          fast: z.boolean(),
          timeout_ms: z.number().int(),
          last_job_id: z.string().uuid().nullable(),
          created_at: z.string(),
          updated_at: z.string(),
          kai_project_id: z.string(),
        }).nullable(),
        session_policy: z.string(),
      }),
      annotations: readAnnotations(),
      _meta: { securitySchemes: noAuth },
    },
    safe(async ({ web_session_id }, context) => {
      const resolved = CompatibilityService.conversationSessionId(
        web_session_id,
        requestMeta(context),
        false,
      );
      const binding = compatibility.binding(resolved);
      if (binding === undefined) return result({ binding: null, session_policy: KAI_COMPACT_SESSION_POLICY });
      return result({
        binding: {
          web_session_id: binding.webSessionId,
          luna_session_id: await compatibilitySessionId(compatibility, binding.lastJobId),
          workspace_path: binding.workspacePath,
          permission_mode: binding.permissionMode,
          network_access: binding.networkAccess,
          network_enforcement: WORKER_NETWORK_ENFORCEMENT,
          model: binding.model,
          reasoning_effort: binding.reasoningEffort,
          fast: binding.fast,
          timeout_ms: binding.timeoutMs,
          last_job_id: binding.lastJobId,
          created_at: binding.createdAt,
          updated_at: binding.updatedAt,
          kai_project_id: binding.projectId,
        },
        session_policy: KAI_COMPACT_SESSION_POLICY,
      });
    }),
  );
}

const REASONING_RANK: Record<string, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

function assertLunaModel(model: string): void {
  if (!/luna/iu.test(model)) {
    throw new Error(`KAI Work Host accepts only Luna worker models; requested ${model}`);
  }
}

function assertReasoningWithinHostLimit(requested: string, maximum: string): void {
  if ((REASONING_RANK[requested] ?? Number.POSITIVE_INFINITY) > (REASONING_RANK[maximum] ?? -1)) {
    throw new Error(`reasoning_effort=${requested} exceeds this Host maximum of ${maximum}`);
  }
}

function statusPayload(
  current: Awaited<ReturnType<CompatibilityService["status"]>>,
): Record<string, unknown> {
  const runtimeBinding = current.turn.runtimeBinding;
  const events = Array.isArray(current.task.recentEvents) ? current.task.recentEvents : [];
  const eventCount = events.filter(event => {
    if (event === null || typeof event !== "object") return false;
    const data = (event as { data?: unknown }).data;
    return data !== null
      && typeof data === "object"
      && (data as { runId?: unknown }).runId === current.job.runId;
  }).length;
  return {
    web_session_id: current.binding.webSessionId,
    job_id: current.job.jobId,
    status: current.status,
    luna_session_id: runtimeSessionId(current.turn),
    workspace_path: current.binding.workspacePath,
    permission_mode: current.turn.permissionProfile ?? current.binding.permissionMode,
    network_access: current.turn.networkAccess ?? current.binding.networkAccess,
    network_enforcement: WORKER_NETWORK_ENFORCEMENT,
    model: runtimeBinding?.model ?? current.binding.model,
    reasoning_effort: runtimeBinding?.effort ?? current.binding.reasoningEffort,
    fast: runtimeBinding?.fast ?? current.binding.fast,
    timeout_ms: current.turn.timeoutMs ?? current.binding.timeoutMs,
    request_id: current.job.requestId,
    terminal_event: current.turn.status,
    final_message: current.turn.finalMessage,
    error: ["failed", "needs_resume"].includes(current.status)
      ? String(current.turn.error ?? current.task.lastError ?? "Luna turn failed")
      : null,
    mutation_seen: current.turn.diffArtifact !== null,
    mutation_observation: current.turn.diffArtifact !== null ? "diff_artifact" : "not_observed",
    event_count: eventCount,
    image_artifacts: [],
    image_preview_rendered: false,
    image_preview_error: null,
    image_preview_id: null,
    session_policy: KAI_COMPACT_SESSION_POLICY,
  };
}

async function compatibilitySessionId(
  compatibility: CompatibilityService,
  lastJobId: string | null,
): Promise<string | null> {
  if (lastJobId === null) return null;
  try {
    return runtimeSessionId((await compatibility.status(lastJobId)).turn);
  } catch {
    return null;
  }
}

function runtimeSessionId(turn: TaskTurnRecord): string | null {
  return turn.runtimeBinding?.sessionId ?? null;
}
