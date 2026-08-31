[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [string]$StateRoot,
    [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'

function Get-SafeRemovalPath {
    param([string]$Path, [string]$Label)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "$Label is empty." }
    $full = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path)).TrimEnd('\')
    $driveRoot = [IO.Path]::GetPathRoot($full).TrimEnd('\')
    $userRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile).TrimEnd('\')
    if ($full -eq $driveRoot -or $full -eq $userRoot -or $full.Length -lt ($driveRoot.Length + 8)) {
        throw "$Label is too broad for recursive removal: $full"
    }
    return $full
}

$InstallRoot = Get-SafeRemovalPath -Path $InstallRoot -Label 'InstallRoot'
$configPath = Join-Path $InstallRoot 'config\work-host.local.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Refusing removal because deployment config is missing: $configPath"
}
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$configuredStateRoot = Get-SafeRemovalPath -Path ([string]$config.environment.KAI_WORK_HOST_HOME) -Label 'configured StateRoot'
if ([string]::IsNullOrWhiteSpace($StateRoot)) { $StateRoot = $configuredStateRoot }
$StateRoot = Get-SafeRemovalPath -Path $StateRoot -Label 'StateRoot'
if (-not [string]::Equals($StateRoot, $configuredStateRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'StateRoot does not match the installed deployment configuration.'
}
$receiptPath = Join-Path $StateRoot 'install-receipt.json'
if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
    throw "Refusing removal because install receipt is missing: $receiptPath"
}
$receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not [string]::Equals((Get-SafeRemovalPath -Path ([string]$receipt.install_root) -Label 'receipt install root'), $InstallRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Install receipt does not match InstallRoot.'
}
if (-not [string]::Equals((Get-SafeRemovalPath -Path ([string]$receipt.state_root) -Label 'receipt state root'), $StateRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Install receipt does not match StateRoot.'
}

Remove-Item -LiteralPath $InstallRoot -Recurse -Force
$dataRemoved = $false
if ($RemoveData) {
    Remove-Item -LiteralPath $StateRoot -Recurse -Force
    $dataRemoved = $true
}

[pscustomobject]@{
    ok = $true
    removedApplication = $InstallRoot
    preservedState = if ($dataRemoved) { $null } else { $StateRoot }
    removedState = if ($dataRemoved) { $StateRoot } else { $null }
    providerGrantRevoked = $false
} | ConvertTo-Json -Depth 4
