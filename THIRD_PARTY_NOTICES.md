# Third-party notices

This source distribution does not vendor `node_modules` or the DSH checkout.
The Windows installer downloads exact dependency versions from their upstream
registries and keeps DSH as a separate pinned checkout. Binary/offline bundles
must regenerate this file and their SBOM from the exact bundled closure.

## Adapted source

- GPT Web Codex v2.2.11 — MIT — copyright 2026 codex-chatgpt-web contributors.
  The original MIT notice is preserved in [`NOTICE`](NOTICE).

## Runtime dependencies

| Package | Version | License |
|---|---:|---|
| `@modelcontextprotocol/node` | 2.0.0 | MIT |
| `@modelcontextprotocol/server` | 2.0.0 | MIT |
| `sharp` | 0.35.3 | Apache-2.0 |
| `zod` | 4.5.4 | MIT |

`sharp` can install a platform-specific prebuilt `libvips` runtime. `libvips`
is distributed under LGPL-3.0-or-later; see the exact platform package and
<https://github.com/libvips/libvips> when redistributing a binary dependency
bundle.

## Development dependencies

| Package | Version | License |
|---|---:|---|
| `@modelcontextprotocol/client` | 2.0.0 | MIT |
| `@types/node` | 24.13.3 | MIT |
| `tsx` | 4.23.13 | MIT |
| `typescript` | 6.0.3 | Apache-2.0 |

## External runtime dependency

- DeepSeek Harness 0.1.1-rc.2 at commit
  `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` — MIT — copyright 2026 DeepSeek.
  It is fetched from <https://github.com/deepseek-ai/deepseek-harness> and
  verified by version and commit before use.

Transitive dependency metadata is recorded in [`sbom.cdx.json`](sbom.cdx.json)
and `package-lock.json`. Each dependency's own license remains authoritative.
