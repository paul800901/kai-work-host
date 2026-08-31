[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z][a-z0-9-]{0,31}$')]
    [string]$InstanceId,
    [string]$BaseRoot,
    [string]$InstallRoot,
    [string]$StateRoot,
    [string]$DshRoot,
    [switch]$NoDshBootstrap,
    [switch]$SkipValidation
)

$ErrorActionPreference = 'Stop'

function Get-SafeAbsolutePath {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
    $full = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path)).TrimEnd('\')
    $root = [IO.Path]::GetPathRoot($full).TrimEnd('\')
    $user = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile).TrimEnd('\')
    if ([string]::IsNullOrWhiteSpace($full) -or $full -eq $root -or $full -eq $user) {
        throw "$Label must be a specific child directory, not a drive or user-profile root: $full"
    }
    return $full
}

function Test-SamePath {
    param([string]$Left, [string]$Right)
    return [string]::Equals([IO.Path]::GetFullPath($Left).TrimEnd('\'), [IO.Path]::GetFullPath($Right).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}

function Test-PathWithin {
    param([string]$Candidate, [string]$Parent)
    $candidatePath = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
    return [string]::Equals($candidatePath, $parentPath, [StringComparison]::OrdinalIgnoreCase) -or
        $candidatePath.StartsWith($parentPath + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-OutsideSourceTree {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$SourceRoot
    )
    if (Test-PathWithin -Candidate $Path -Parent $SourceRoot) {
        throw "$Label must be outside the source or extracted release tree: $SourceRoot"
    }
}

function Get-RelativeChildPath {
    param([string]$Parent, [string]$Child)
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
    $childPath = [IO.Path]::GetFullPath($Child)
    $prefix = $parentPath + '\'
    if (-not $childPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is not a child of the expected root: $childPath"
    }
    return $childPath.Substring($prefix.Length).Replace('\', '/')
}

function Invoke-Native {
    param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory)
    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($FilePath)) failed with exit code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
}

function Assert-DshIdentity {
    param([string]$Git, [string]$DshRoot, [object]$Pin)
    if (-not (Test-Path -LiteralPath (Join-Path $DshRoot '.git') -PathType Container)) {
        throw "DSH root is not a Git checkout: $DshRoot"
    }
    $actualCommit = (& $Git -C $DshRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualCommit -ne [string]$Pin.commit) {
        throw "DSH commit mismatch: expected $($Pin.commit), found $actualCommit"
    }
    $manifest = Get-Content -LiteralPath (Join-Path $DshRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$manifest.version -ne [string]$Pin.version) {
        throw "DSH version mismatch: expected $($Pin.version), found $($manifest.version)"
    }
}

function Copy-PublicReleaseTree {
    param([string]$Source, [string]$Destination)
    $excludedDirectories = @('.git', 'node_modules', 'dist', 'coverage', '.tmp', 'credentials', 'runtime', 'state', 'state-root', 'secrets')
    foreach ($file in Get-ChildItem -LiteralPath $Source -Recurse -File -Force) {
        $relative = Get-RelativeChildPath -Parent $Source -Child $file.FullName
        $segments = $relative.Split('/')
        if ($segments[0] -eq 'release') { continue }
        if (@($segments | Where-Object { $_ -in $excludedDirectories -or $_ -like '.stage-*' -or $_ -like '.verify-*' }).Count -gt 0) { continue }
        if ($file.Name -match '^(work-host\.local\.json|\.env(\.(?!example$).+)?|\.credentials\.ya?ml|\.npmrc|handoff-.*\.ps1|LIVE_VALIDATION_.*\.md)$') { continue }
        if ($file.Name -match '\.(credentials\.json|secrets\.json|secret|token)$') { continue }
        if ($file.Name -match '\.(log|pem|key|pfx|p12)$') { continue }
        $target = Join-Path $Destination $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
    }
}

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$pin = Get-Content -LiteralPath (Join-Path $projectRoot 'config\dsh-pin.json') -Raw -Encoding UTF8 | ConvertFrom-Json

if ($null -eq $package.version -or $package.name -ne '@kai/work-host') {
    throw "The installer source is not a KAI Work Host release tree: $projectRoot"
}

$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($BaseRoot)) { $BaseRoot = Join-Path $localAppData 'KAI\WorkHost' }
$BaseRoot = Get-SafeAbsolutePath -Path $BaseRoot -Label 'BaseRoot'
if ([string]::IsNullOrWhiteSpace($InstallRoot)) { $InstallRoot = Join-Path $BaseRoot ("app\" + [string]$package.version) }
if ([string]::IsNullOrWhiteSpace($StateRoot)) { $StateRoot = Join-Path $BaseRoot ("instances\" + $InstanceId) }
$dshName = 'DeepSeekHarness-' + [string]$pin.version + '-' + ([string]$pin.commit).Substring(0, 12)
if ([string]::IsNullOrWhiteSpace($DshRoot)) { $DshRoot = Join-Path $BaseRoot ("dependencies\" + $dshName) }
$InstallRoot = Get-SafeAbsolutePath -Path $InstallRoot -Label 'InstallRoot'
$StateRoot = Get-SafeAbsolutePath -Path $StateRoot -Label 'StateRoot'
$DshRoot = Get-SafeAbsolutePath -Path $DshRoot -Label 'DshRoot'

foreach ($target in @(
    @{ Label = 'InstallRoot'; Path = $InstallRoot },
    @{ Label = 'StateRoot'; Path = $StateRoot },
    @{ Label = 'DshRoot'; Path = $DshRoot }
)) {
    Assert-OutsideSourceTree -Label $target.Label -Path $target.Path -SourceRoot $projectRoot
}
if (Test-Path -LiteralPath $InstallRoot) {
    $existing = @(Get-ChildItem -LiteralPath $InstallRoot -Force -ErrorAction Stop)
    if ($existing.Count -gt 0) {
        throw "InstallRoot is not empty; refusing to overwrite an application tree: $InstallRoot"
    }
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$git = (Get-Command git.exe -ErrorAction Stop).Source
$nodeVersion = (& $node --version).Trim().TrimStart('v').Split('.')[0]
if ([int]$nodeVersion -lt 24) { throw "Node.js 24 or newer is required; found $(& $node --version)." }

& $node (Join-Path $projectRoot 'scripts\release\scan-public-tree.mjs') $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'Public-tree safety scan failed; installation stopped.' }

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
Copy-PublicReleaseTree -Source $projectRoot -Destination $InstallRoot

Invoke-Native -FilePath $npm -Arguments @('ci') -WorkingDirectory $InstallRoot
Invoke-Native -FilePath $npm -Arguments @('run', 'build') -WorkingDirectory $InstallRoot

if (-not (Test-Path -LiteralPath $DshRoot -PathType Container)) {
    if ($NoDshBootstrap) {
        throw "The exact DSH checkout is missing and -NoDshBootstrap was supplied: $DshRoot"
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $DshRoot) -Force | Out-Null
    Invoke-Native -FilePath $git -Arguments @(
        'clone', '--depth', '1', '--branch', ('dsh-v' + [string]$pin.version),
        [string]$pin.repository, $DshRoot
    ) -WorkingDirectory (Split-Path -Parent $DshRoot)
}

Assert-DshIdentity -Git $git -DshRoot $DshRoot -Pin $pin
$requiredDshBuild = @(
    (Join-Path $DshRoot 'apps\cli\lib\bin.js'),
    (Join-Path $DshRoot 'packages\sdk\server\lib\index.js'),
    (Join-Path $DshRoot 'packages\sdk\protocol\lib\index.js')
)
if (@($requiredDshBuild | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count -gt 0) {
    Invoke-Native -FilePath $npm -Arguments @('exec', '--yes', [string]$pin.package_manager, '--', 'install', '--frozen-lockfile') -WorkingDirectory $DshRoot
    Invoke-Native -FilePath $npm -Arguments @('exec', '--yes', [string]$pin.package_manager, '--', 'run', 'build:lib:host') -WorkingDirectory $DshRoot
}
foreach ($required in $requiredDshBuild) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Pinned DSH build is incomplete: $required"
    }
}

New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
$configPath = Join-Path $InstallRoot 'config\work-host.local.json'
$deploymentConfig = [ordered]@{
    schema_version = 1
    instance_id = $InstanceId
    environment = [ordered]@{
        KAI_WORK_HOST_BIND = '127.0.0.1'
        KAI_WORK_HOST_PORT = '8787'
        KAI_WORK_HOST_HOME = $StateRoot
        KAI_WORK_HOST_DSH_ROOT = $DshRoot
        KAI_WORK_HOST_DSH_HOME = (Join-Path $StateRoot 'dsh')
        KAI_WORK_HOST_DSH_PROFILE = ('kai-work-host-' + $InstanceId)
        KAI_WORK_HOST_DSH_PROVIDER = 'openai-codex'
        KAI_WORK_HOST_WORKER_MODEL = 'gpt-5.6-luna'
        KAI_WORK_HOST_WORKER_EFFORT = 'high'
        KAI_WORK_HOST_EXECUTION_PROFILE = 'lean'
    }
}
[IO.File]::WriteAllText($configPath, (($deploymentConfig | ConvertTo-Json -Depth 6) + "`n"), [Text.UTF8Encoding]::new($false))

$priorConfig = $env:KAI_WORK_HOST_CONFIG
try {
    $env:KAI_WORK_HOST_CONFIG = $configPath
    if (-not $SkipValidation) {
        Invoke-Native -FilePath $npm -Arguments @('run', 'validate') -WorkingDirectory $InstallRoot
    }
} finally {
    if ($null -eq $priorConfig) { Remove-Item Env:KAI_WORK_HOST_CONFIG -ErrorAction SilentlyContinue }
    else { $env:KAI_WORK_HOST_CONFIG = $priorConfig }
}

$receipt = [ordered]@{
    schema_version = 1
    package = [string]$package.name
    version = [string]$package.version
    instance_id = $InstanceId
    install_root = $InstallRoot
    state_root = $StateRoot
    dsh_root = $DshRoot
    dsh_version = [string]$pin.version
    dsh_commit = [string]$pin.commit
    keyless_validation = if ($SkipValidation) { 'skipped' } else { 'passed' }
    installed_at_utc = [DateTime]::UtcNow.ToString('o')
    oauth_configured = $false
    tunnel_configured = $false
}
$receiptPath = Join-Path $StateRoot 'install-receipt.json'
[IO.File]::WriteAllText($receiptPath, (($receipt | ConvertTo-Json -Depth 5) + "`n"), [Text.UTF8Encoding]::new($false))

[pscustomobject]@{
    ok = $true
    instanceId = $InstanceId
    version = [string]$package.version
    installRoot = $InstallRoot
    stateRoot = $StateRoot
    dshRoot = $DshRoot
    configPath = $configPath
    receiptPath = $receiptPath
    keylessValidation = $receipt.keyless_validation
    oauthConfigured = $false
    tunnelConfigured = $false
    next = @('npm run auth:status', 'npm run auth:login', 'configure a unique tunnel/runtime key for this machine')
} | ConvertTo-Json -Depth 5
