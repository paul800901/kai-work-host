# Security policy

## Supported version

Security fixes are prepared for the current `0.4.x` line. Older local builds
are unsupported unless a maintainer explicitly says otherwise.

## Report a vulnerability

Use GitHub's private **Report a vulnerability** flow for this repository. Do
not open a public issue containing credentials, tunnel identifiers, tokens,
private project paths, exploit details, or user data. If private reporting is
not enabled yet, contact the repository owner through an already-established
private channel and disclose only the minimum information needed to arrange a
secure handoff.

Include the affected version, operating system, permission profile, a minimal
reproduction, and whether the issue can escape the registered workspace or
cross a WebGPT conversation/Host instance boundary. Redact all secrets.

## Security boundaries

- Loopback HTTP is the default. Non-loopback binding requires a bearer token.
- Runtime state, OAuth grants, tunnel profiles, logs, project data, and local
  deployment configuration are excluded from source and release artifacts.
- Project registration is the authorization ceiling. A WebGPT turn can select
  only permissions already allowed for that exact project.
- Luna commands use the official Codex sandbox. Windows uses its unelevated
  backend in the worker process; no global firewall or administrator setup is
  changed. Its network controls are environment-level only and native programs
  can bypass them. Windows therefore retains the model-policy-only network
  contract, not a claim of network isolation. Full access cannot enforce denial.
- Direct MCP terminal execution is separate: its network setting is policy-only,
  not an operating-system firewall. Do not describe it as network isolation.
- Official Codex is version-pinned with an independent ChatGPT login home.
  Automatic cross-task memory injection and Codex memory generation/use are off.
- Provider limits and authorization failures fail closed; the Host must not
  rotate accounts, switch providers, or fall back to an API key to evade them.

See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) for the complete trust model.
