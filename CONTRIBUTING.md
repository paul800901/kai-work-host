# Contributing

KAI Work Host is a thin execution-management layer above a pinned DSH runtime.
Changes must preserve that ownership boundary and the 18-tool public MCP
contract.

## Local setup

1. Install Node.js 24 or newer.
2. Run `npm ci`.
3. Run `npm run check`, `npm test`, and `npm run build`.
4. For the DSH contract probe, provide the exact built checkout described in
   `config/dsh-pin.json`, then run `npm run smoke:dsh:keyless`.

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
- Do not upgrade DSH in-place. A pin change requires an isolated candidate,
  migration/readback evidence, Windows validation, and an updated threat model,
  SBOM, notices, and release manifest.
- Run `npm run validate` with an exact keyless DSH checkout before requesting
  review.

## Commit and release discipline

Use small commits with an auditable reason. A release is cut only from a clean
Git commit and tag; local packages built from an uncommitted tree must identify
that state in their manifest and are not public releases.
