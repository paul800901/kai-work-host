import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/connect-managed-tunnel.ps1", import.meta.url));

test("PowerShell process cleanup rejects null chains and PID zero before any stop", { skip: process.platform !== "win32" }, () => {
  // Load only the real helper definitions, never the script's operational body.
  const command = String.raw`
    $source = '${script.replaceAll("'", "''")}'
    $parseErrors = $null; $tokens = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw 'Invalid PowerShell script' }
    $names = @('Get-ProcessFromSnapshot','Get-ProcessIdentity','Get-ChainIdentities','Get-TunnelFunctionalHealth')
    foreach ($f in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $false)) {
      if ($f.Name -in $names) { . ([scriptblock]::Create($f.Extent.Text)) }
    }
    $zero = [pscustomobject]@{ProcessId=0;ParentProcessId=0;Name='Idle'}
    if ($null -ne (Get-ProcessFromSnapshot -Processes @($zero) -ProcessId 0)) { throw 'PID 0 accepted' }
    foreach ($probe in @({Get-ProcessIdentity -Process $null}, {Get-ProcessIdentity -Process $zero}, {Get-ChainIdentities -Chain $null -Processes @($zero)})) {
      $rejected = $false
      try { & $probe } catch { $rejected = $true }
      if (-not $rejected) { throw 'Missing process identity accepted' }
    }
    $health = Get-TunnelFunctionalHealth -Status ([pscustomobject]@{})
    if ($null -ne $health.healthy) { throw 'Missing logs claimed healthy' }
    'guarded'
  `;
  assert.equal(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true }).trim(), "guarded");
});

test("read-only observation exits before managed cleanup or profile mutation", () => {
  const source = readFileSync(script, "utf8");
  const start = source.indexOf("if ($ObserveOnly) {");
  const end = source.indexOf("\n$staleIdentities =", start);
  assert.ok(start > 0 && end > start);
  const observation = source.slice(start, end);
  assert.match(observation, /exit 0/u);
  assert.doesNotMatch(observation, /Stop-Process|Stop-Recorded|Set-McpConnection|Invoke-Stale|SetEnvironmentVariable/u);
});
