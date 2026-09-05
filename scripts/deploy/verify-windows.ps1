[CmdletBinding()]
param([string]$InstallRoot)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$configPath = Join-Path $InstallRoot 'config\work-host.local.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Deployment config was not found: $configPath"
}
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$stateRoot = [string]$config.environment.KAI_WORK_HOST_HOME
$receiptPath = Join-Path $stateRoot 'install-receipt.json'
if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
    throw "Install receipt was not found: $receiptPath"
}
$receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not [string]::Equals([IO.Path]::GetFullPath([string]$receipt.install_root).TrimEnd('\'), $InstallRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Install receipt does not belong to this application root.'
}

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$priorConfig = $env:KAI_WORK_HOST_CONFIG
try {
    $env:KAI_WORK_HOST_CONFIG = $configPath
    Push-Location -LiteralPath $InstallRoot
    try {
        & $npm run validate
        if ($LASTEXITCODE -ne 0) { throw "Keyless validation failed with exit code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
} finally {
    if ($null -eq $priorConfig) { Remove-Item Env:KAI_WORK_HOST_CONFIG -ErrorAction SilentlyContinue }
    else { $env:KAI_WORK_HOST_CONFIG = $priorConfig }
}

[pscustomobject]@{
    ok = $true
    instanceId = [string]$receipt.instance_id
    version = [string]$receipt.version
    installRoot = $InstallRoot
    stateRoot = $stateRoot
    codexVersion = [string]$receipt.codex_version
    publicTools = 18
    rawTools = 19
    paidModelUsed = $false
    tunnelChanged = $false
} | ConvertTo-Json -Depth 4
