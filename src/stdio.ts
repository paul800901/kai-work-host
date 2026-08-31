import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadConfig } from "./config.js";
import { DshRuntimeManager } from "./dsh-runtime.js";
import { DurableStore } from "./durable-store.js";
import { MemoryService } from "./memory.js";
import { buildMcpServer } from "./mcp-server.js";
import { HostMcpRuntime } from "./mcp-runtime.js";
import { ProjectRegistry } from "./project-registry.js";
import { acquireStateRootLease } from "./state-root-lease.js";
import { TaskOrchestrator } from "./task-orchestrator.js";

const config = loadConfig();
const stateRootLease = await acquireStateRootLease(config.stateRoot);
const store = new DurableStore(config.stateRoot);
const projects = new ProjectRegistry(store);
const memory = new MemoryService(store, config.maxContextCharacters);
const runtime = new DshRuntimeManager(config);
const orchestrator = new TaskOrchestrator(config, store, projects, memory, runtime);
const mcpRuntime = new HostMcpRuntime(orchestrator, config);

await orchestrator.initialize();
const stdio = serveStdio(() => buildMcpServer(orchestrator, config, mcpRuntime), {
  onerror: (error) => process.stderr.write(`[kai-work-host] ${error.message}\n`),
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await stdio.close();
    mcpRuntime.shutdown();
    await orchestrator.shutdown();
  } finally {
    await stateRootLease.close();
  }
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
process.stdin.once("end", () => {
  void shutdown().finally(() => process.exit(0));
});
process.stdin.once("close", () => {
  void shutdown().finally(() => process.exit(0));
});
