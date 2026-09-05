# 0.4.0 validation record

Validation date: 2026-09-05. Windows x64, Node.js 24.14.1, official Codex 0.153.3. Companion supervisor: GPT Web Codex 2.2.18.

## Keyless results

- Clean Windows installation and complete `npm run validate`: passed, 35 tests.
- Native Codex stdio initialization, read-only command execution and workspace-write command cancellation: passed without model use.
- HTTP and stdio entrypoints, one-state-root lease, 18 public / 19 raw MCP tools: passed.
- Exact process arguments, absent Host without PID 0 cleanup, worker/sidecar distinction and observe-only guards: passed.
- Companion `bun run verify`: 257 core tests passed; 104 launcher tests passed; typechecks, renderer/runtime build and relocatable runtime smoke passed. Platform-specific skipped tests are not native cross-platform validation.

## Explicitly authorized Luna/high runs

Exactly four turns were dispatched, under separate authorization for the initial three and one cancellation retest. No routine check dispatches inference.

1. Execution: created a scratch proof file and verified its exact content.
2. Resume: shut down/reconstructed the candidate Host/runtime, resumed the same official thread and appended the requested line. Retrying the same MCP request did not dispatch an extra turn.
3. Cancellation initially failed the physical-effect test: the turn reported interrupted, but its native delayed command later wrote a file. The original failed receipt and file are retained. The harness also incorrectly waited for `interrupted` instead of the public MCP `cancelled` status; that assertion was corrected, not used to dismiss the real orphan-process failure.
4. After stopping the still-owned worker tree before its wrapper exits: observed the native command's start marker, cancelled through MCP, waited past its delayed-write deadline, and verified no post-cancel file. Host health and direct MCP reads still worked.

## Important limits

- Early paid receipts labelled network enforcement `codex-sandbox`. A later keyless native check showed that Windows unelevated offline controls do not block arbitrary Node network calls, including public HTTPS. The current implementation and metadata correct this to `model-policy-only`, preserving the prior Host's network contract. Those original receipts are not rewritten. Stronger firewall isolation would require separately authorized Windows setup.
- Read-only online execution uses the explicit per-turn sandbox policy; thread/start's legacy read-only mode remains offline. Native protocol/readback and fixture coverage confirm the mapping; no fifth model turn was run.
- Official history/tool overhead still consumes tokens. No A/B cost-saving claim is supported. Per-turn usage after some process restarts is unknown; any missing historical usage keeps cumulative usage unknown.
- Old DSH records/grants remain retained and are not migrated into resumable Codex threads or automatically replayed.
- A candidate pass is not by itself a production promotion or refreshed WebGPT connector. Deployment/readback must be recorded separately.

## Formal South deployment readback

- Installed KAI 0.4.0 into a versioned application directory, independent of the development checkout. Preserved the original state root, DSH records/grant and the newly authorized independent Codex login.
- Switched only the formal profile's stdio command. The tunnel ID and runtime-key reference remained unchanged; the prior profile is retained for rollback.
- Installed GPT Web Codex 2.2.18, verified its packaged runtime and desktop shortcut, and started it hidden in the system tray.
- With no active task/worker, stopped the exact formal Host process: the supervisor restored a new Host/tunnel and ready state in approximately 30 seconds.
- Then stopped the exact tunnel process: the supervisor restored the formal topology in approximately 38 seconds.
- Read back one tunnel, one KAI Host and zero extra sidecars after recovery. The existing remote MCP `codexluna_session` call successfully returned the new no-automatic-cross-task-memory policy. This call did not invoke Luna.
- The log-derived functional-health field remained unknown; it was not changed to true to manufacture a pass. The successful remote MCP response is separate functional evidence.
- No fifth model turn was dispatched. No Windows accounts/firewall rules were changed. Connector catalog descriptions may remain cached until refreshed, independently of the live server policy.

## Official interface references

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex memories](https://learn.chatgpt.com/docs/customization/memories)
- [Windows sandbox modes and limits](https://learn.chatgpt.com/docs/windows/windows-sandbox)
