# Contributing

KAI Work Host is a thin MCP bridge above the pinned official Codex App Server.
Changes must preserve that ownership boundary and the 18-tool public MCP
contract.

## Local setup

1. Install Node.js 24 or newer.
2. Run `npm ci`.
3. Run `npm run check`, `npm test`, and `npm run build`.
4. Run `npm run smoke:codex:keyless` against the installed pinned Codex package.
   It initializes the real protocol and checks sandbox cancellation without a model call.

Routine tests must not sign in, consume model allowance, create a tunnel,
modify a real project, or read a maintainer's runtime state. Paid Luna smoke
tests and connector tests are explicit operator actions outside CI.

## Pull requests

- Keep source, runtime state, formal project truth, and deployment staging
  separate.
- Never commit `.credentials.yaml`, deployment-local config, tunnel profiles,
  runtime keys, bearer tokens, logs, sessions, Task state, or project memory.
- Add or update tests for permission, workspace, request-id, recovery, and tool
  contract changes.
- Do not upgrade Codex in-place. A pin change requires an isolated candidate,
  migration/readback evidence, Windows validation, and an updated threat model,
  SBOM, notices, and release manifest.
- Run `npm run validate` before requesting review. Never build or validate in a
  development tree that is serving a live Host; use an isolated installation.

## Commit and release discipline

Use small commits with an auditable reason. A release is cut only from a clean
Git commit and tag; local packages built from an uncommitted tree must identify
that state in their manifest and are not public releases.
