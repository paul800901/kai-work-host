# KAI Work Host

English | [正體中文](README.md)

KAI Work Host is an independent MCP work host that lets a WebGPT conversation direct a local Luna worker. WebGPT is the only high-level planner. KAI Work Host provides durable host, project, task, memory, permission, recovery, and receipt services, while DeepSeek Harness (DSH) remains the sole AgentLoop, session, event, and tool-runtime substrate.

Public repository: <https://github.com/paul800901/kai-work-host>. CI status is tracked by the GitHub Actions `CI` and `Pinned DSH contract` workflows: <https://github.com/paul800901/kai-work-host/actions>.

```text
Machine owner / operator
  <-> WebGPT (high-level planner)
  <-> MCP
KAI Work Host (host, project, task, memory, recovery, receipts)
  <-> DSH SDK JSON-RPC
DSH remote-worker profile (session, AgentLoop, tools, sandbox, events)
  <-> openai-codex OAuth
Luna (local worker)
  <-> registered local workspaces
```

## Scope and trust boundary

- The Host does not start, call, or read Codex App, Codex CLI, Codex App Server, `CODEX_HOME`, or an OpenAI API key.
- Only Luna authentication and model requests use the pinned DSH `openai-codex` OAuth route. The project does not increase, reset, or bypass provider usage limits.
- Every deployment instance has its own state root, DSH home, OAuth grant, tunnel profile, runtime key, project registry, sessions, memories, and receipts.
- OAuth credentials, tunnel identifiers and keys, logs, sessions, project paths, memories, and local deployment configuration are excluded from release archives.
- The machine owner defines each project's maximum authority. WebGPT selects the effective permission, network policy, model, effort, fast mode, and timeout for each turn within that ceiling. The Host enforces the ceiling; it does not replace the planner.
- Browser control, computer use, web search, subagents, deployment, publishing, Git push, and external messaging are intentionally outside this Host.

This is an independent community integration, not an OpenAI product or endorsement. Provider terms, privacy rules, and usage limits still apply. OpenAI's Secure MCP Tunnel is a private outbound transport; it is not a public ChatGPT App distribution mechanism.

## Requirements

- Windows 10 or later
- Node.js 24 or later
- Git
- PowerShell 5.1 or later

The deployment scripts bootstrap and verify the exact DSH dependency pinned in [`config/dsh-pin.json`](config/dsh-pin.json). The current pin is `dsh-v0.1.1-rc.2` at commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

## Keyless source validation

```powershell
git clone https://github.com/paul800901/kai-work-host.git
cd kai-work-host
npm ci
npm run validate
```

Validation performs type checking, unit tests, a production build, project and public-tree checks, a real keyless DSH startup probe, and HTTP/stdio MCP smoke tests. It does not open OAuth, call Luna, publish a connector, start a managed tunnel, or modify a registered project.

The public MCP contract contains 18 tools. A nineteenth image-preview restore tool is App-private and must not appear in WebGPT's callable tool list.

## Windows deployment

```powershell
.\scripts\deploy\install-windows.ps1 -InstanceId east
```

The installer uses separate application, state, and DSH dependency directories. It does not copy or create OAuth grants, tunnel keys, or project bindings. After keyless validation, the operator performs authentication and tunnel setup explicitly.

For an instance-labelled archive, the release pipeline adds a non-secret `DEPLOYMENT_PROFILE.json` and a convenience installer such as `Install-East.ps1`. The source remains the same generic KAI Work Host core.

See [Windows deployment](docs/DEPLOYMENT_WINDOWS.md), [operations](docs/OPERATIONS.md), [architecture](docs/ARCHITECTURE.md), and the [threat model](docs/THREAT_MODEL.md).

## Reproducible release

Public releases must be built from a clean Git commit/tag. Local, explicitly uncommitted packages may be generated for deployment testing, but their manifest is labelled accordingly.

```powershell
npm run release:package -- -ArtifactName KAI-Work-Host-0.3.0
npm run release:package -- -InstanceId east
```

The release process runs validation and secret/path scans, generates a CycloneDX SBOM, creates a per-file SHA-256 manifest, writes a ZIP checksum, extracts the ZIP, and verifies every declared file before success.

The `v0.3.0` GitHub Release can contain both the generic and East instance assets:

- `KAI-Work-Host-0.3.0.zip` and `KAI-Work-Host-0.3.0.zip.sha256` are the generic public package.
- `KAI-Work-Host-East-0.3.0.zip` and `KAI-Work-Host-East-0.3.0.zip.sha256` are East convenience installer assets in the same release. They add only non-secret `DEPLOYMENT_PROFILE.json` and `Install-East.ps1`; East is not a third repository or a separate release line.

See [release policy](docs/RELEASE.md), [third-party notices](THIRD_PARTY_NOTICES.md), [security policy](SECURITY.md), and [contributing](CONTRIBUTING.md).

## License

KAI Work Host is licensed under the [MIT License](LICENSE). `private: true` in `package.json` prevents accidental npm publication; it does not restrict the rights granted by the MIT license.

References: [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan), and the [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
