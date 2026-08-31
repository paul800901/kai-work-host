import { loadConfig } from "./config.js";
import { DshRuntimeManager } from "./dsh-runtime.js";
import { DurableStore } from "./durable-store.js";
import { HostHttpServer } from "./http-server.js";
import { MemoryService } from "./memory.js";
import { ProjectRegistry } from "./project-registry.js";
import { acquireStateRootLease } from "./state-root-lease.js";
import { TaskOrchestrator } from "./task-orchestrator.js";
import { HOST_NAME, HOST_VERSION } from "./version.js";

const config = loadConfig();
const stateRootLease = await acquireStateRootLease(config.stateRoot);
const store = new DurableStore(config.stateRoot);
const projects = new ProjectRegistry(store);
const memory = new MemoryService(store, config.maxContextCharacters);
const runtime = new DshRuntimeManager(config);
const orchestrator = new TaskOrchestrator(config, store, projects, memory, runtime);
const http = new HostHttpServer(config, orchestrator);

await orchestrator.initialize();
await http.listen();

process.stdout.write(
  `${JSON.stringify({
    service: HOST_NAME,
    version: HOST_VERSION,
    mcp: `http://${config.bindHost}:${config.port}/mcp`,
    health: `http://${config.bindHost}:${config.port}/healthz`,
    stateRoot: config.stateRoot,
    runtime: "dsh-sdk-jsonrpc",
    workerModel: config.workerModel,
  })}\n`,
);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await http.close();
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
