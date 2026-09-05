# Release process

## Public-release gates

1. Start from a clean Git commit on the intended release branch.
2. Confirm package/Host versions agree and the Codex dependency matches `src/codex-pin.ts`.
3. Run `npm ci` and `npm run validate` in an isolated tree with no live Host.
4. Run `npm run release:sbom` and review license changes.
5. Run `npm run release:scan` and inspect the release tree for local state.
6. Run a clean Windows package/install/verify smoke without OAuth, a tunnel,
   a model call, or a real project.
7. Create the package with `npm run release:package -- -OutputDirectory <dir>`.
8. Verify `RELEASE-MANIFEST.json`, the ZIP SHA-256, and extraction readback.
9. Only after review, create the signed/annotated Git tag and GitHub release.

Git push, tag publication, GitHub release creation, connector creation, OAuth,
and live Luna smoke are external actions and require separate authorization.

## Artifact classes

- `KAI-Work-Host-<version>.zip`: generic public source/deployment package.
- `KAI-Work-Host-<Instance>-<version>.zip`: the same public core plus a
  non-secret convenience installer for one instance label. It must not include
  credentials, tunnel IDs/keys, project paths, runtime state, or memory.
- Offline/binary dependency bundles are a separate release class. They require
  regenerated notices and an SBOM for every vendored binary, including
  platform `sharp/libvips` packages and the official Codex native packages.

## Reproducibility

The ZIP is accompanied by SHA-256 and a sorted per-file manifest. The file
manifest is the reproducibility contract; archive container timestamps can
vary across PowerShell/Windows versions. A public release manifest must name a
clean source commit and tag. A local uncommitted build is labelled as such and
must not be represented as an official public release.
