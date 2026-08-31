# KAI Work Host rules

- This repository is the independent WebGPT-to-local-Luna host. Do not place its source or runtime data inside another KAI product repository.
- WebGPT Sol is the only high-level planner. The local Luna worker may execute, verify, report, and ask for a decision, but must not silently replace the task strategy.
- DSH is the only local AgentLoop, named Session, event, tool, sandbox, and model-adapter substrate. KAI Work Host owns Host, Project, durable Task, routing, memory projections, recovery, and receipts above it.
- Only Luna model authentication and inference may use the `openai-codex` subscription OAuth route. Do not add a Codex App, Codex CLI, App Server, `CODEX_HOME`, inherited OpenAI API key, or Codex task/thread dependency.
- Runtime state lives under an instance-specific data root and is never committed. Source, runtime state, formal project truth, and bridge staging remain separate.
- The DSH checkout must match the version and commit in `src/dsh-pin.ts` and remain read-only. Put managed profile overlays under the isolated Work Host DSH home; do not edit or upgrade that checkout from this repository.
- Project roots must be explicitly registered. A task may use only a permission profile allowed by its registered project.
- Mutating MCP tools require stable request ids and must be retry-safe. Never replay an uncertain model turn automatically after a crash.
- L0 is derived from durable task events. L1 entries cite a task and event range. L2 facts require explicit evidence references and are never promoted automatically.
- Browser, computer-use, visual annotation, deployment, publishing, Git push, and other external effects are not emulated or pre-authorized.
- Routine validation must be keyless. The one-time OAuth command and a paid Luna smoke are explicit operations, never part of `npm run validate` except for the keyless DSH startup probe.
