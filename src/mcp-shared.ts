import {
  type CallToolResult,
  type JSONObject,
} from "@modelcontextprotocol/server";
import { createHash, randomUUID } from "node:crypto";
import * as z from "zod/v4";

import { DirectToolService } from "./compat/direct-tools.js";
import { ImagePreviewCache, type CachedImagePreview } from "./compat/image-preview-cache.js";
import { errorMessage, HostError } from "./errors.js";

export const sessionId = z.string().min(8).max(256);
export const sandbox = z.enum(["read-only", "workspace-write", "danger-full-access"]);
export const reasoning = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);
export const jobStatus = z.enum(["queued", "running", "completed", "failed", "timed_out", "cancelled", "needs_resume"]);
export const noAuth = [{ type: "noauth" as const }];

export const terminalOutputSchema = z.object({
  job_id: z.string().uuid(),
  request_id: z.string(),
  command: z.string(),
  cwd: z.string(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  pid: z.number().int().nullable(),
  exit_code: z.number().int().nullable(),
  output: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  output_truncated: z.boolean(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});

export function result(value: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: isError ? "Tool failed; read the error text." : "Tool completed; read structuredContent." }],
    structuredContent: jsonObject(value),
    ...(isError ? { isError: true } : {}),
  };
}

export function safe<T>(
  operation: (input: T, context: unknown) => Promise<CallToolResult>,
): (input: T, context: unknown) => Promise<CallToolResult> {
  return async (input, context) => {
    try {
      return await operation(input, context);
    } catch (error) {
      const code = error instanceof HostError ? error.code : "tool_error";
      return { content: [{ type: "text", text: `${code}: ${errorMessage(error)}` }], isError: true };
    }
  };
}

export function requestMeta(context: unknown): Record<string, unknown> | undefined {
  if (context === null || typeof context !== "object") return undefined;
  const mcpReq = (context as { mcpReq?: unknown }).mcpReq;
  if (mcpReq === null || typeof mcpReq !== "object") return undefined;
  const record = mcpReq as { _meta?: unknown; envelope?: unknown };
  const meta = record._meta ?? record.envelope;
  return meta !== null && typeof meta === "object" && !Array.isArray(meta)
    ? meta as Record<string, unknown>
    : undefined;
}

export function requestIdentity(context: unknown, explicit: string | undefined, scope: string): string {
  const supplied = explicit?.trim();
  if (supplied) return supplied;
  if (context !== null && typeof context === "object") {
    const mcpReq = (context as { mcpReq?: unknown }).mcpReq;
    if (mcpReq !== null && typeof mcpReq === "object") {
      const id = (mcpReq as { id?: unknown }).id;
      if (typeof id === "string" || typeof id === "number") {
        const digest = createHash("sha256").update(`${scope}\0${String(id)}`, "utf8").digest("hex");
        return `mcp:${digest}`;
      }
    }
  }
  return `generated:${scope}:${randomUUID()}`;
}

export function fileReadResult(
  value: Awaited<ReturnType<DirectToolService["readForTransfer"]>>,
): CallToolResult {
  if (!("data" in value)) return result({ ...value });
  const metadata = imageMetadata(value);
  return {
    content: [
      { type: "text", text: "Image metadata is in structuredContent; the image follows as native MCP content." },
      { type: "image", data: value.data, mimeType: value.mimeType },
    ],
    structuredContent: jsonObject(metadata),
  };
}

export function fileImagePreviewResult(
  value: Awaited<ReturnType<DirectToolService["readForTransfer"]>>,
  cache: ImagePreviewCache,
): CallToolResult {
  if (!("data" in value)) throw new Error(`Local file is not a supported image: ${value.path}`);
  const cached = cache.put(value);
  const metadata = { ...imageMetadata(value), preview_id: cached.previewId };
  return {
    content: [{ type: "text", text: `Displaying local image preview: ${cached.name}` }],
    structuredContent: jsonObject(metadata),
    _meta: {
      webgpt_image_preview: {
        ...cachedImageMetadata(cached),
        data_url: `data:${cached.mimeType};base64,${cached.data}`,
      },
    },
  };
}

export function cachedImageResult(preview: CachedImagePreview): CallToolResult {
  const metadata = cachedImageMetadata(preview);
  return {
    content: [{ type: "text", text: "The cached local image preview was restored." }],
    structuredContent: jsonObject(metadata),
    _meta: {
      webgpt_image_preview: {
        ...metadata,
        data_url: `data:${preview.mimeType};base64,${preview.data}`,
      },
    },
  };
}

export function publicTerminal(job: {
  id: string;
  requestId: string;
  command: string;
  cwd: string;
  status: string;
  pid?: number;
  exitCode?: number | null;
  output: string;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  startedAt: string;
  finishedAt?: string;
}) {
  return {
    job_id: job.id,
    request_id: job.requestId,
    command: job.command,
    cwd: job.cwd,
    status: job.status,
    pid: job.pid ?? null,
    exit_code: job.exitCode ?? null,
    output: job.output,
    stdout: job.stdout,
    stderr: job.stderr,
    output_truncated: job.outputTruncated,
    started_at: job.startedAt,
    finished_at: job.finishedAt ?? null,
  };
}

export function jsonObject(value: Record<string, unknown>): JSONObject {
  return JSON.parse(JSON.stringify(value)) as JSONObject;
}

export function readAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  } as const;
}

export function writeAnnotations(
  idempotentHint: boolean,
  destructiveHint: boolean,
  openWorldHint = false,
) {
  return { readOnlyHint: false, destructiveHint, openWorldHint, idempotentHint } as const;
}

function imageMetadata(
  value: Extract<Awaited<ReturnType<DirectToolService["readForTransfer"]>>, { data: string }>,
) {
  return {
    path: value.path,
    mime_type: value.mimeType,
    bytes: value.bytes,
    ...(value.optimized === undefined ? {} : { optimized: value.optimized }),
    ...(value.sourceBytes === undefined ? {} : { source_bytes: value.sourceBytes }),
    ...(value.sourceMimeType === undefined ? {} : { source_mime_type: value.sourceMimeType }),
    ...(value.width === undefined ? {} : { width: value.width }),
    ...(value.height === undefined ? {} : { height: value.height }),
  };
}

function cachedImageMetadata(preview: CachedImagePreview) {
  return {
    preview_id: preview.previewId,
    name: preview.name,
    mime_type: preview.mimeType,
    bytes: preview.bytes,
    ...(preview.optimized === undefined ? {} : { optimized: preview.optimized }),
    ...(preview.sourceBytes === undefined ? {} : { source_bytes: preview.sourceBytes }),
    ...(preview.sourceMimeType === undefined ? {} : { source_mime_type: preview.sourceMimeType }),
    ...(preview.width === undefined ? {} : { width: preview.width }),
    ...(preview.height === undefined ? {} : { height: preview.height }),
  };
}
