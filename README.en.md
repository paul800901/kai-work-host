# KAI Work Host

English | [正體中文](README.md)

KAI Work Host 0.4 is a thin WebGPT-to-local MCP and durable-task bridge. WebGPT owns requirements, decisions, authorization judgments and result review. The pinned official Codex App Server executes Luna turns over local stdio. DSH is no longer a runtime dependency.

## Runtime contract

- Exactly one tunnel owner: kai-work-host. One tunnel, one KAI Host, no tunnel-created Codex sidecar. Host-owned Codex execution children are allowed.
- Exact package: @openai/codex@0.153.3, also checked against the running CLI.
- Independent Codex-managed ChatGPT sign-in under the instance Codex home. No desktop/DSH credential copying, API-key billing, account rotation or provider/model fallback.
- One official thread per durable Task. Bind before inference; resume across worker/Host restarts. Never replay an uncertain turn automatically.
- Explicit task and project instructions only. No automatic KAI L1/L2 retrieval or episode generation; Codex memory generation/use disabled.
- Every turn reads back its model, effort, workspace and effective sandbox. Approval requests are declined and returned as requiring a WebGPT decision.
- Cancellation stops only the owned task process tree; thread and records survive. Job failure does not shut down the Host/tunnel.
- The 18 public MCP tools remain; the nineteenth image-restore tool is App-private.
- Token history/tool overhead still exists. Unknown usage remains null; partial usage is not labelled a complete cumulative total. KAI fast mode is not a paid provider fast tier.

## Install

Requires Windows, Node.js 24+, PowerShell and npm access.

```powershell
git clone https://github.com/paul800901/kai-work-host.git
cd kai-work-host
npm ci
npm run validate
.\scripts\deploy\install-windows.ps1 -InstanceId east
```

Validation is keyless and does not sign in, invoke a model, create a tunnel, or modify a real project. Build in a candidate directory if the live Host runs from the source checkout.

From the installed app, run npm run auth:login and npm run auth:status explicitly. HTTP starts with npm run start; stdio with npm run start:stdio. Default HTTP endpoints are 127.0.0.1:8787/mcp and /healthz.

## Migration and safety

Existing DSH sessions remain readable but cannot resume as Codex threads. Start a new explicitly scoped task; do not auto-import history. Never copy South credentials or runtime state into East packages.

Codex sandboxing bounds worker writes, not all file reads. The Windows unelevated backend only uses environment-level offline controls; native programs can still reach the network. Windows therefore retains the model-policy-only network contract, not firewall isolation. Direct terminal tools are not sandboxed by Codex either. Full-access and external side effects require explicit authority. Browser/computer-use capabilities are not emulated.

See [deployment](docs/DEPLOYMENT_WINDOWS.md), [operations](docs/OPERATIONS.md), [architecture](docs/ARCHITECTURE.md), [threat model](docs/THREAT_MODEL.md), and [release policy](docs/RELEASE.md).

KAI is MIT-licensed; the pinned official Codex package is Apache-2.0. This community integration is not an OpenAI endorsement or availability guarantee.
