import { CompatibilityService } from "./compat/compatibility-service.js";
import { DirectToolService } from "./compat/direct-tools.js";
import { ImagePreviewCache } from "./compat/image-preview-cache.js";
import type { TaskOrchestrator } from "./task-orchestrator.js";
import type { HostConfig } from "./types.js";

export class HostMcpRuntime {
  readonly compatibility: CompatibilityService;
  readonly direct = new DirectToolService();
  readonly imagePreviews: ImagePreviewCache;

  constructor(orchestrator: TaskOrchestrator, config: HostConfig) {
    this.compatibility = new CompatibilityService(orchestrator, config);
    this.imagePreviews = new ImagePreviewCache(this.compatibility.state.path);
  }

  shutdown(): void {
    this.direct.shutdown();
  }
}
