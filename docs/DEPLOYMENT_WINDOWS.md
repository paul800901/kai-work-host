# Windows deployment

The public source is generic. `East`, `South`, or any other label is only an
instance identifier used to derive separate state, DSH profile, OAuth, and
tunnel ownership. Never copy another machine's runtime directory.

## Requirements

- Windows 10/11 x64.
- Node.js 24 or newer.
- Git.
- Outbound HTTPS for npm, GitHub, the selected model provider, and (when used)
  OpenAI Secure MCP Tunnel.
- Enough disk space for the Host plus a pinned DSH source/build checkout.

No Codex desktop app, Codex CLI process, `CODEX_HOME`, or OpenAI API key is
required by the Host. The optional Luna route uses an isolated provider grant
inside the instance's DSH home.

## Install a release package

Extract the verified ZIP, compare its SHA-256 with the adjacent checksum, then
run from PowerShell:

```powershell
.\scripts\deploy\install-windows.ps1 -InstanceId east
```

An East-labelled package also contains a convenience entrypoint:

```powershell
.\Install-East.ps1
```

The default non-admin layout is:

```text
%LOCALAPPDATA%\KAI\WorkHost\
├─ app\0.3.0\                         immutable application copy
├─ dependencies\DeepSeekHarness-...\ exact read-only DSH checkout
└─ instances\east\                   writable state for this instance only
   ├─ dsh\                            DSH profile, Session, OAuth grant
   └─ install-receipt.json
```

Use `-BaseRoot` to place all three roots elsewhere. The installer refuses an
occupied application directory and never imports credentials or tunnel state.
It installs exact npm dependencies, obtains/builds the exact DSH pin when
needed, writes a non-secret `config/work-host.local.json`, and runs keyless
validation.

## Authentication and connector

After keyless validation, explicitly start the one-time account flow from the
installed application directory:

```powershell
npm run auth:status
npm run auth:login
```

This stores the grant only in the current instance's DSH home. Do not copy a
grant from another computer or instance.

For private WebGPT access, create a separate tunnel/runtime key and connector
for this machine. Configure the official tunnel client or the companion Bridge
launcher to execute:

```text
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <install-root>\scripts\start-stdio.ps1
```

The tunnel is an outbound transport. It does not replace Host project and
permission checks. One active tunnel ID must have exactly one local runtime
owner. East and South should use different tunnel IDs, runtime keys, profiles,
aliases, state roots, and OAuth grants.

## Validate and diagnose

```powershell
.\scripts\deploy\verify-windows.ps1
```

This is keyless. It verifies release identity, local config, DSH pin/build,
HTTP/stdio entrypoints, and the 18 public/19 raw MCP tool contract. It does not
create a connector or consume a Luna turn.

## Uninstall

```powershell
.\scripts\deploy\uninstall-windows.ps1 -InstallRoot <exact-app-path>
```

Application removal preserves instance data by default. Removing state needs
both `-RemoveData` and the exact `-StateRoot`; the script verifies its install
receipt before deleting. OAuth revocation at the provider is a separate
operator action.
