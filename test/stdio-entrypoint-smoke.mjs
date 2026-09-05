import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { applyDeploymentConfig } from "../scripts/load-deployment-config.mjs";

applyDeploymentConfig();

const stateRoot = await mkdtemp(path.join(tmpdir(), "kai-work-host-stdio-"));
const command = process.platform === "win32" ? "powershell.exe" : process.execPath;
const args = process.platform === "win32"
  ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.resolve("scripts/start-stdio.ps1")]
  : [path.resolve("dist/stdio.js")];
const transport = new StdioClientTransport({
  command,
  args,
  env: {
    ...process.env,
    KAI_WORK_HOST_HOME: stateRoot,
    KAI_WORK_HOST_CODEX_HOME: path.join(stateRoot, "codex"),
  },
  stderr: "pipe",
});
const client = new Client({ name: "kai-work-host-stdio-smoke", version: "0.3.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 19);
  const privateTools = tools.tools.filter((tool) => tool._meta?.["openai/visibility"] === "private");
  assert.deepEqual(privateTools.map((tool) => tool.name), ["file_image_preview_restore"]);
  assert.equal(tools.tools.length - privateTools.length, 18);
} finally {
  await client.close();
}

process.stdout.write("KAI Work Host stdio entrypoint is ready.\n");
