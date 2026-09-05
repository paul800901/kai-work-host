# Windows deployment

East/South are instance labels, not separate codebases. Each machine must have its own state, ChatGPT grant and tunnel credentials.

## Requirements

Windows 10/11 x64, Node.js 24+, PowerShell and outbound npm/official-service access. npm installs the pinned @openai/codex@0.153.3 package. No DSH checkout, desktop Codex login or Platform API key is required.

## Install

Verify the release ZIP checksum, extract it, then run:

```powershell
.\scripts\deploy\install-windows.ps1 -InstanceId east
# East-labelled archive also supplies Install-East.ps1
```

Default layout:

```text
%LOCALAPPDATA%\KAI\WorkHost\
  app\0.4.0\             immutable application and pinned node_modules
  instances\east\        durable state and install-receipt.json
    codex\               independent ChatGPT login and official threads
```

Use -BaseRoot for a different location. The installer refuses an occupied application directory, writes non-secret config/work-host.local.json and runs keyless validation. It never imports credentials, creates a tunnel or runs a model.

Run npm run auth:login explicitly from the installed app. The independent grant is stored in this instance's Codex home; do not copy it from another region.

## Tunnel

Configure the companion supervisor/official tunnel to run:

```text
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <install-root>\scripts\start-stdio.ps1
```

Formal alias is kai-work-host on each machine. Regions use different tunnel IDs, runtime keys, state and logins. One active owner per tunnel. Host-owned Codex workers are not extra tunnel owners.

The app should remain in the tray to supervise infrastructure; an explicit Quit stops the managed owner after terminal-state readback. Never start Standalone as fallback.

## Verification and upgrade

```powershell
.\scripts\deploy\verify-windows.ps1
```

Keyless verification checks fixed Codex version, native sandbox and process cleanup, HTTP/stdio and 18 public/19 raw MCP tools. It does not prove an authenticated Luna turn or WebGPT end-to-end connectivity.

The unelevated Windows sandbox limits writes but uses environment-level offline controls, not a firewall. Network denial remains model-policy-only, as in the prior Host. Stronger network isolation would require separately authorized Windows sandbox setup; the installer does not perform that system change.

Install a candidate separately. Do not build over an app serving the formal tunnel. Preserve old runtime state and installation until a verified profile-pointer switch. Old DSH records remain readable but cannot resume as Codex threads.

## Uninstall

```powershell
.\scripts\deploy\uninstall-windows.ps1 -InstallRoot <exact-app-path>
```

State is preserved by default. Removing it requires -RemoveData and an exact -StateRoot matching the receipt. Provider credential revocation is separate.
