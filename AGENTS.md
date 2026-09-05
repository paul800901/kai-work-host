# KAI Work Host rules

- This repository is the independent WebGPT-to-local-Luna host. Do not place its source or runtime data inside another KAI product repository.
- WebGPT Sol is the only high-level planner. The local Luna worker may execute, verify, report, and ask for a decision, but must not silently replace the task strategy.
- The pinned official Codex App Server over local stdio is the execution/session/tool/sandbox substrate. KAI Work Host is a thin MCP, Project, durable Task, authorization-boundary, recovery and receipt bridge, not another planner or AgentLoop. There is no DSH or Standalone fallback.
- Use Codex-managed ChatGPT sign-in in the instance-specific Codex home. Never inherit API keys, desktop credentials/configuration or provider overrides. Never substitute a model, account or billing route.
- Runtime state lives under an instance-specific data root and is never committed. Source, runtime state, formal project truth, and bridge staging remain separate.
- The Codex package must match `src/codex-pin.ts`; validate its actual stdio protocol before upgrading. Do not modify an old DSH checkout or delete its retained sessions/grant during migration.
- Project roots must be explicitly registered. A task may use only a permission profile allowed by its registered project.
- Mutating MCP tools require stable request ids and must be retry-safe. Never replay an uncertain model turn automatically after a crash.
- Keep durable task records and original evidence. Do not automatically inject cross-task L1/L2 memories or generate model-backed memories. Codex memory generation and use are disabled. Old DSH sessions are readable records, not resumable Codex threads; require a new explicitly scoped task instead of replaying history.
- Browser, computer-use, visual annotation, deployment, publishing, Git push, and other external effects are not emulated or pre-authorized.
- Routine validation must be keyless. One-time ChatGPT login and a paid Luna smoke are explicit operations, never part of `npm run validate`. Tunnel owner stays `kai-work-host`; Codex workers are its execution children, not additional tunnel owners.
