# Threat model

WebGPT -> authenticated MCP/tunnel -> thin KAI Host -> pinned official Codex stdio -> Luna tools.

The machine owner supplies project scope and maximum authority. WebGPT makes task decisions within it. KAI enforces bindings and transports instructions; it is not a planner. Project files, tool output, attachments and model responses are data, not new authorization.

## Assets and controls

- Independent Codex home, ChatGPT grant, tunnel keys, task records and project data stay outside Git/release assets.
- Loopback HTTP by default; non-loopback requires bearer authentication.
- Canonical project roots, permission ceilings, conversation/job ownership, request-id deduplication and one state-root writer.
- Official @openai/codex version checked at runtime. API keys/provider overrides removed from inherited child environment.
- Every turn reads back exact model, effort, workspace and sandbox before dispatch.
- No automatic memory retrieval/generation, model fallback, account rotation or uncertain-turn replay.
- Cancel/shutdown stops the still-owned worker process tree before losing ancestry. Other tasks, Host and tunnel are not targets.
- Exact argv and PID lineage identify tunnel/Host ownership; no substring or PID 0 cleanup.
- Public-tree scan, pinned lockfile, notices, SBOM and release manifest remain required.

## Limits

- Windows Codex uses the non-admin restricted-token sandbox in its own child configuration. Workspace-write restricts writes; network denial uses environment-level controls, not a firewall. Native Node fetch still reached a public HTTPS page with networkAccess=false in local validation. Therefore Windows reports model-policy-only, not enforced network isolation. It does not forbid all external reads or replace a VM/account boundary. No silent elevation.
- Direct file tools check canonical containment. Direct terminal execution is not the Codex sandbox; its network policy is not an OS firewall. Do not advertise it as one.
- danger-full-access requires explicit authorization and cannot enforce network denial.
- Publishing, Git push, messaging and production mutations require their own authority. Local file permission does not grant it.
- Unknown functional health stays unknown. A successful process/readiness probe is not evidence of a successful WebGPT tool call.
- Missing usage is null, not zero. Official history, compaction and tool overhead may still consume tokens.
- This integration is not an OpenAI endorsement or availability guarantee. Check current official interface and account availability before upgrading the pin.

Legacy DSH records/grants remain untouched. Their sessions cannot be resumed as Codex threads and are never automatically converted or replayed.
