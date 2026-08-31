export interface DeploymentConfigResult {
  loaded: boolean;
  configPath: string;
  instanceId: string | null;
  applied: string[];
}

export function applyDeploymentConfig(options?: { projectRoot?: string }): DeploymentConfigResult;
export const DEPLOYMENT_CONFIG_SAFE_KEYS: readonly string[];
