import { applyDeploymentConfig } from "./load-deployment-config.mjs";

const mode = process.argv[2] ?? "http";
if (mode !== "http" && mode !== "stdio") {
  throw new Error("KAI Work Host launch mode must be http or stdio");
}

applyDeploymentConfig();
await import(mode === "stdio" ? "../dist/stdio.js" : "../dist/index.js");
