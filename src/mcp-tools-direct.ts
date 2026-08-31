import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { importChatGptAttachment } from "./compat/attachment-import.js";
import { CompatibilityService } from "./compat/compatibility-service.js";
import { IMAGE_PREVIEW_RESOURCE_URI } from "./compat/image-preview.js";
import type { HostMcpRuntime } from "./mcp-runtime.js";
import {
  cachedImageResult,
  fileImagePreviewResult,
  fileReadResult,
  noAuth,
  publicTerminal,
  readAnnotations,
  requestIdentity,
  requestMeta,
  result,
  safe,
  sandbox,
  sessionId,
  terminalOutputSchema,
  writeAnnotations,
} from "./mcp-shared.js";

export function registerDirectTools(server: McpServer, runtime: HostMcpRuntime): void {
  registerFileTools(server, runtime);
  registerTerminalTools(server, runtime);
}

function registerFileTools(server: McpServer, runtime: HostMcpRuntime): void {
  const direct = runtime.direct;
  const compatibility = runtime.compatibility;
  const imagePreviews = runtime.imagePreviews;

  server.registerTool(
    "file_read",
    {
      title: "Read a local text file or image",
      description: "Read text or transfer a PNG, JPEG, GIF, or WebP image as native MCP image content. The workspace must first be registered by codexluna_init; workspace-write remains bounded to that root.",
      inputSchema: z.object({
        web_session_id: sessionId.optional(),
        path: z.string().min(1),
        workspace_path: z.string().min(1),
        permission_mode: sandbox.optional(),
        max_chars: z.number().int().min(1).max(1_000_000).default(200_000),
        max_image_bytes: z.number().int().min(50_000).max(20_000_000).default(1_500_000),
      }),
      outputSchema: z.object({
        path: z.string(),
        mime_type: z.string().optional(),
        bytes: z.number().int().nonnegative().optional(),
        optimized: z.boolean().optional(),
        source_bytes: z.number().int().nonnegative().optional(),
        source_mime_type: z.string().optional(),
        width: z.number().int().nonnegative().optional(),
        height: z.number().int().nonnegative().optional(),
        text: z.string().optional(),
        truncated: z.boolean().optional(),
      }),
      annotations: readAnnotations(),
      _meta: { securitySchemes: noAuth },
    },
    safe(async (input, context) => {
      const authorization = await directAuthorization(compatibility, input, context);
      return fileReadResult(await direct.readForTransfer(
        input.path,
        authorization.workspacePath,
        authorization.permissionMode,
        input.max_chars,
        input.max_image_bytes,
      ));
    }),
  );

  server.registerTool(
    "file_import_attachment",
    {
      title: "Import a ChatGPT attachment",
      description: "Save a ChatGPT conversation attachment into its initialized local workspace. This dedicated, origin-checked ChatGPT attachment ingress is separate from general tool network_access; downloads are size-limited, hashed, never executed, and do not overwrite by default.",
      inputSchema: z.object({
        web_session_id: sessionId.optional(),
        file: z.object({
          download_url: z.string().min(1),
          file_id: z.string().min(1),
          mime_type: z.string().min(1).optional(),
          file_name: z.string().min(1).optional(),
        }),
        destination: z.string().min(1),
        workspace_path: z.string().min(1),
        permission_mode: sandbox.optional(),
        overwrite: z.boolean().default(false),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/iu).optional(),
        max_bytes: z.number().int().min(1).max(100_000_000).default(20_000_000),
      }),
      outputSchema: z.object({
        path: z.string(),
        bytes: z.number().int().nonnegative(),
        declared_mime_type: z.string().nullable(),
        detected_mime_type: z.string().nullable(),
        mime_type_status: z.enum(["matched", "mismatched", "unknown"]),
        sha256: z.string(),
        verified: z.boolean(),
        file_id: z.string(),
        file_name: z.string().nullable(),
        overwritten: z.boolean(),
        warning: z.string().nullable(),
        network_scope: z.literal("chatgpt-attachment-ingress"),
      }),
      annotations: writeAnnotations(false, true, true),
      _meta: {
        securitySchemes: noAuth,
        "openai/fileParams": ["file"],
        "openai/toolInvocation/invoking": "正在匯入附件",
        "openai/toolInvocation/invoked": "附件已匯入",
      },
    },
    safe(async (input, context) => {
      const authorization = await directAuthorization(compatibility, input, context);
      const imported = await importChatGptAttachment({
        file: input.file,
        destination: input.destination,
        workspacePath: authorization.workspacePath,
        permissionMode: authorization.permissionMode,
        overwrite: input.overwrite,
        ...(input.expected_sha256 === undefined ? {} : { expectedSha256: input.expected_sha256 }),
        maxBytes: input.max_bytes,
      });
      return result({ ...imported, network_scope: "chatgpt-attachment-ingress" });
    }),
  );

  server.registerTool(
    "file_image_preview",
    {
      title: "Display a local image inline",
      description: "Render a local PNG, JPEG, GIF, or WebP as an inline ChatGPT image card. Large images are compacted without modifying the source file.",
      inputSchema: z.object({
        web_session_id: sessionId.optional(),
        path: z.string().min(1),
        workspace_path: z.string().min(1),
        permission_mode: sandbox.optional(),
        max_image_bytes: z.number().int().min(50_000).max(20_000_000).default(1_500_000),
      }),
      outputSchema: z.object({
        path: z.string(),
        mime_type: z.string(),
        bytes: z.number().int().nonnegative(),
        optimized: z.boolean().optional(),
        source_bytes: z.number().int().nonnegative().optional(),
        source_mime_type: z.string().optional(),
        width: z.number().int().nonnegative().optional(),
        height: z.number().int().nonnegative().optional(),
        preview_id: z.string().uuid(),
      }),
      annotations: readAnnotations(),
      _meta: {
        securitySchemes: noAuth,
        ui: { resourceUri: IMAGE_PREVIEW_RESOURCE_URI, visibility: ["model", "app"] },
        "ui/resourceUri": IMAGE_PREVIEW_RESOURCE_URI,
        "openai/outputTemplate": IMAGE_PREVIEW_RESOURCE_URI,
        "openai/toolInvocation/invoking": "正在準備圖片預覽",
        "openai/toolInvocation/invoked": "圖片預覽已就緒",
      },
    },
    safe(async (input, context) => {
      const authorization = await directAuthorization(compatibility, input, context);
      const value = await direct.readForTransfer(
        input.path,
        authorization.workspacePath,
        authorization.permissionMode,
        1,
        input.max_image_bytes,
      );
      return fileImagePreviewResult(value, imagePreviews);
    }),
  );

  server.registerTool(
    "file_image_preview_restore",
    {
      title: "Restore a local image preview",
      description: "App-only restoration of an opaque cached image preview. This private tool is not part of the 18 model-visible tools.",
      inputSchema: z.object({ preview_id: z.string().uuid() }),
      outputSchema: z.object({
        preview_id: z.string().uuid(),
        name: z.string(),
        mime_type: z.string(),
        bytes: z.number().int().nonnegative(),
        optimized: z.boolean().optional(),
        source_bytes: z.number().int().nonnegative().optional(),
        source_mime_type: z.string().optional(),
        width: z.number().int().nonnegative().optional(),
        height: z.number().int().nonnegative().optional(),
      }),
      annotations: readAnnotations(),
      _meta: {
        securitySchemes: noAuth,
        ui: { visibility: ["app"] },
        "openai/widgetAccessible": true,
        "openai/visibility": "private",
      },
    },
    safe(async ({ preview_id }) => cachedImageResult(imagePreviews.get(preview_id))),
  );

  server.registerTool(
    "file_list",
    {
      title: "List a local directory",
      description: "List direct children of a directory in an initialized workspace.",
      inputSchema: z.object({
        web_session_id: sessionId.optional(),
        path: z.string().default("."),
        workspace_path: z.string().min(1),
        permission_mode: sandbox.optional(),
      }),
      outputSchema: z.object({
        path: z.string(),
        entries: z.array(z.object({
          name: z.string(),
          kind: z.enum(["directory", "file", "other"]),
          size: z.number().int().nonnegative().optional(),
          modified_at: z.string(),
        })),
      }),
      annotations: readAnnotations(),
      _meta: { securitySchemes: noAuth },
    },
    safe(async (input, context) => {
      const authorization = await directAuthorization(compatibility, input, context);
      return result(direct.list(input.path, authorization.workspacePath, authorization.permissionMode));
    }),
  );

  server.registerTool(
    "file_search",
    {
      title: "Search local text files",
      description: "Search text recursively under an initialized workspace; common dependency and runtime directories are skipped.",
      inputSchema: z.object({
        web_session_id: sessionId.optional(),
        query: z.string().min(1).max(10_000),
        path: z.string().default("."),
        workspace_path: z.string().min(1),
        permission_mode: sandbox.optional(),
        max_results: z.number().int().min(1).max(2_000).default(200),
      }),
      outputSchema: z.object({
        path: z.string(),
        matches: z.array(z.object({ path: z.string(), line: z.number().int().positive(), text: z.string() })),
        truncated: z.boolean(),
      }),
      annotations: readAnnotations(),
      _meta: { securitySchemes: noAuth },
    },
    safe(async (input, context) => {
      const authorization = await directAuthorization(compatibility, input, context);
      return result(direct.search(
        input.query,
        input.path,
        authorization.workspacePath,
        authorization.permissionMode,
        input.max_results,
      ));
    }),
  );

  server.registerTool(
    "file_write",
    {
      title: "Write a local text file",
      description: "Write a complete text file inside an initialized workspace. Disabled in read-only mode.",
      inputSchema: z.object({
        web_session_id: sessionId.optional(),
        path: z.string().min(1),
        content: z.string().max(5_000_000),
        workspace_path: z.string().min(1),
        permission_mode: sandbox.optional(),
      }),
      outputSchema: z.object({ path: z.string(), bytes: z.number().int().nonnegative() }),
      annotations: writeAnnotations(false, true),
      _meta: { securitySchemes: noAuth },
    },
    safe(async (input, context) => {
      const authorization = await directAuthorization(compatibility, input, context);
      return result(direct.write(input.path, input.content, authorization.workspacePath, authorization.permissionMode));
    }),
  );

  server.registerTool(
    "file_create_directory",
    {
      title: "Create a local directory",
      description: "Create a directory inside an initialized workspace. Disabled in read-only mode.",
      inputSchema: z.object({
        web_session_id: sessionId.optional(),
        path: z.string().min(1),
        workspace_path: z.string().min(1),
        permission_mode: sandbox.optional(),
        recursive: z.boolean().default(true),
      }),
      outputSchema: z.object({ path: z.string(), created: z.boolean(), recursive: z.boolean() }),
      annotations: writeAnnotations(true, false),
      _meta: { securitySchemes: noAuth },
    },
    safe(async (input, context) => {
      const authorization = await directAuthorization(compatibility, input, context);
      return result(direct.createDirectory(
        input.path,
        authorization.workspacePath,
        authorization.permissionMode,
        input.recursive,
      ));
    }),
  );

  server.registerTool(
    "file_delete_directory",
    {
      title: "Delete a local directory",
      description: "Delete a directory inside an initialized workspace. Recursive deletion must be explicit; workspace roots and link targets are refused.",
      inputSchema: z.object({
        web_session_id: sessionId.optional(),
        path: z.string().min(1),
        workspace_path: z.string().min(1),
        permission_mode: sandbox.optional(),
        recursive: z.boolean().default(false),
      }),
      outputSchema: z.object({ path: z.string(), deleted: z.literal(true), recursive: z.boolean() }),
      annotations: writeAnnotations(false, true),
      _meta: { securitySchemes: noAuth },
    },
    safe(async (input, context) => {
      const authorization = await directAuthorization(compatibility, input, context);
      return result(direct.deleteDirectory(
        input.path,
        authorization.workspacePath,
        authorization.permissionMode,
        input.recursive,
      ));
    }),
  );
}

function registerTerminalTools(server: McpServer, runtime: HostMcpRuntime): void {
  const direct = runtime.direct;
  const compatibility = runtime.compatibility;

  server.registerTool(
    "terminal_start",
    {
      title: "Start a local terminal command",
      description: "Start an asynchronous PowerShell command on Windows or sh on Linux inside an initialized workspace. Disabled in read-only mode.",
      inputSchema: z.object({
        web_session_id: sessionId.optional(),
        command: z.string().min(1).max(100_000),
        cwd: z.string().default("."),
        workspace_path: z.string().min(1),
        permission_mode: sandbox.optional(),
        request_id: z.string().min(8).max(256).optional(),
      }),
      outputSchema: terminalOutputSchema,
      annotations: writeAnnotations(false, true, true),
      _meta: { securitySchemes: noAuth },
    },
    safe(async (input, context) => {
      const authorization = await directAuthorization(compatibility, input, context);
      return result(publicTerminal(direct.startTerminal(
        input.command,
        input.cwd,
        authorization.workspacePath,
        authorization.permissionMode,
        authorization.webSessionId,
        requestIdentity(context, input.request_id, `${authorization.webSessionId}:terminal_start`),
      )));
    }),
  );

  server.registerTool(
    "terminal_exec",
    {
      title: "Run a local terminal command and read its output",
      description: "Run a workspace-bounded PowerShell or sh command, wait up to wait_timeout_ms, and return bounded output. Continue a running job with terminal_status instead of rerunning it.",
      inputSchema: z.object({
        web_session_id: sessionId.optional(),
        command: z.string().min(1).max(100_000),
        cwd: z.string().default("."),
        workspace_path: z.string().min(1),
        permission_mode: sandbox.optional(),
        request_id: z.string().min(8).max(256).optional(),
        wait_timeout_ms: z.number().int().min(0).max(300_000).default(60_000),
      }),
      outputSchema: terminalOutputSchema,
      annotations: writeAnnotations(false, true, true),
      _meta: { securitySchemes: noAuth },
    },
    safe(async (input, context) => {
      const authorization = await directAuthorization(compatibility, input, context);
      const started = direct.startTerminal(
        input.command,
        input.cwd,
        authorization.workspacePath,
        authorization.permissionMode,
        authorization.webSessionId,
        requestIdentity(context, input.request_id, `${authorization.webSessionId}:terminal_exec`),
      );
      return result(publicTerminal(await direct.waitTerminal(
        started.id,
        input.wait_timeout_ms,
        authorization.webSessionId,
      )));
    }),
  );

  server.registerTool(
    "terminal_status",
    {
      title: "Get terminal command status",
      description: "Poll an owned asynchronous terminal command. Output is bounded to the most recent 1,000,000 characters.",
      inputSchema: z.object({ job_id: z.string().uuid(), web_session_id: sessionId.optional() }),
      outputSchema: terminalOutputSchema,
      annotations: readAnnotations(),
      _meta: { securitySchemes: noAuth },
    },
    safe(async ({ job_id, web_session_id }, context) => {
      const owner = directSessionId(compatibility, web_session_id, context);
      return result(publicTerminal(direct.terminal(job_id, owner)));
    }),
  );

  server.registerTool(
    "terminal_write_stdin",
    {
      title: "Write to a running terminal command",
      description: "Send UTF-8 input to an owned running terminal job. Optionally close stdin, then continue with terminal_status.",
      inputSchema: z.object({
        job_id: z.string().uuid(),
        web_session_id: sessionId.optional(),
        input: z.string().max(100_000).default(""),
        close: z.boolean().default(false),
      }),
      outputSchema: terminalOutputSchema,
      annotations: writeAnnotations(false, true),
      _meta: { securitySchemes: noAuth },
    },
    safe(async ({ job_id, web_session_id, input, close }, context) => {
      const owner = directSessionId(compatibility, web_session_id, context);
      const authorization = direct.terminalAuthorization(job_id, owner);
      await compatibility.authorizeDirectTool(
        owner,
        authorization.workspacePath,
        authorization.permissionMode,
      );
      return result(publicTerminal(direct.writeTerminalStdin(job_id, input, close, owner)));
    }),
  );

  server.registerTool(
    "terminal_cancel",
    {
      title: "Cancel terminal command",
      description: "Cancel an owned direct terminal process without affecting the KAI/DSH Luna session.",
      inputSchema: z.object({ job_id: z.string().uuid(), web_session_id: sessionId.optional() }),
      outputSchema: terminalOutputSchema,
      annotations: writeAnnotations(true, true),
      _meta: { securitySchemes: noAuth },
    },
    safe(async ({ job_id, web_session_id }, context) => {
      const owner = directSessionId(compatibility, web_session_id, context);
      return result(publicTerminal(direct.cancelTerminal(job_id, owner)));
    }),
  );
}

async function directAuthorization(
  compatibility: CompatibilityService,
  input: { web_session_id?: string | undefined; workspace_path: string; permission_mode?: "read-only" | "workspace-write" | "danger-full-access" | undefined },
  context: unknown,
): Promise<{
  webSessionId: string;
  workspacePath: string;
  permissionMode: "read-only" | "workspace-write" | "danger-full-access";
}> {
  const webSessionId = directSessionId(compatibility, input.web_session_id, context);
  const authorization = await compatibility.authorizeDirectTool(
    webSessionId,
    input.workspace_path,
    input.permission_mode,
  );
  return {
    webSessionId,
    workspacePath: authorization.workspacePath,
    permissionMode: authorization.permissionMode,
  };
}

function directSessionId(
  _compatibility: CompatibilityService,
  explicit: string | undefined,
  context: unknown,
): string {
  return CompatibilityService.conversationSessionId(explicit, requestMeta(context), false);
}
