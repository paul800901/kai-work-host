import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

import {
  IMAGE_PREVIEW_HTML,
  IMAGE_PREVIEW_MIME_TYPE,
  IMAGE_PREVIEW_RESOURCE_URI,
  LEGACY_IMAGE_PREVIEW_RESOURCE_URIS,
} from "./compat/image-preview.js";
import { registerDirectTools } from "./mcp-tools-direct.js";
import { registerLunaTools } from "./mcp-tools-luna.js";
import { HostMcpRuntime } from "./mcp-runtime.js";
import type { TaskOrchestrator } from "./task-orchestrator.js";
import type { HostConfig } from "./types.js";
import { HOST_NAME, HOST_VERSION } from "./version.js";

export function buildMcpServer(
  orchestrator: TaskOrchestrator,
  config: HostConfig,
  runtime = new HostMcpRuntime(orchestrator, config),
): McpServer {
  const server = new McpServer(
    { name: HOST_NAME, version: HOST_VERSION },
    {
      instructions: [
        "Use codexluna_init before the first codexluna_start in each ChatGPT conversation.",
        "WebGPT Sol is the only high-level planner. KAI Work Host runs local Luna through the official Codex App Server with task-only context; no automatic cross-task memory is injected.",
        "Use terminal_exec for ordinary commands; continue a running job with terminal_status instead of rerunning it.",
        "Use file_image_preview when the user asks to visibly display a local image.",
        "The public model-visible contract is exactly 18 tools. file_image_preview_restore is app-only and private.",
        "Browser, computer-use, deployment, publishing, and Git push remain outside this Host unless separately authorized.",
      ].join(" "),
    },
  );
  registerImagePreviewResources(server);
  registerLunaTools(server, runtime, config);
  registerDirectTools(server, runtime);
  return server;
}

export function createHostMcpHandler(orchestrator: TaskOrchestrator, config: HostConfig) {
  const runtime = new HostMcpRuntime(orchestrator, config);
  const handler = createMcpHandler(() => buildMcpServer(orchestrator, config, runtime));
  return { handler, runtime };
}

function registerImagePreviewResources(server: McpServer): void {
  const register = (name: string, uri: string) => {
    server.registerResource(
      name,
      uri,
      {
        title: "KAI Work Host local image preview",
        description: "Inline preview card for a verified local image returned by KAI Work Host.",
        mimeType: IMAGE_PREVIEW_MIME_TYPE,
        _meta: {
          ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
          "openai/widgetDescription": "Displays a verified local image returned by KAI Work Host.",
          "openai/widgetPrefersBorder": true,
          "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
        },
      },
      async resourceUri => ({
        contents: [{
          uri: resourceUri.href,
          mimeType: IMAGE_PREVIEW_MIME_TYPE,
          text: IMAGE_PREVIEW_HTML.replaceAll("__WEBGPT_PREVIEW_NAMESPACE__", uri),
          _meta: {
            ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
            "openai/widgetDescription": "Displays a verified local image returned by KAI Work Host.",
            "openai/widgetPrefersBorder": true,
            "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
          },
        }],
      }),
    );
  };
  register("kai-image-preview", IMAGE_PREVIEW_RESOURCE_URI);
  LEGACY_IMAGE_PREVIEW_RESOURCE_URIS.forEach((uri, index) => {
    register(`kai-image-preview-legacy-${index + 1}`, uri);
  });
}
