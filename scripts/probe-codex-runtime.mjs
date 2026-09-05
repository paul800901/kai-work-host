import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { CodexRuntimeManager } from "../dist/codex-runtime.js";

// Never load deployment config, credentials, or a real project for routine validation.
const root = await mkdtemp(path.join(tmpdir(), "kai-codex-keyless-"));
const config = { ...loadConfig(), stateRoot: root, codexHome: path.join(root, "codex") };
const runtime = new CodexRuntimeManager(config);
try {
  const result = await runtime.probe(path.join(root, "workspace"));
  console.log(JSON.stringify(result, null, 2));
} finally { await runtime.shutdown(); }
