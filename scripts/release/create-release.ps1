[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [ValidatePattern('^[a-z][a-z0-9-]{0,31}$')][string]$InstanceId,
    [string]$ArtifactName,
    [ValidatePattern('^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$')][string]$SourceTag,
    [switch]$SkipValidation,
    [switch]$AllowUncommitted,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Invoke-Native {
    param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory)
    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($FilePath)) failed with exit code $LASTEXITCODE." }
    } finally { Pop-Location }
}

function Test-PathWithin {
    param([string]$Candidate, [string]$Parent)
    $candidatePath = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
    return [string]::Equals($candidatePath, $parentPath, [StringComparison]::OrdinalIgnoreCase) -or
        $candidatePath.StartsWith($parentPath + '\', [StringComparison]::OrdinalIgnoreCase)
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

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::OpenRead([IO.Path]::GetFullPath($Path))
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Copy-PublicTree {
    param([string]$Source, [string]$Destination)
    $excludedDirectories = @('.git', 'node_modules', 'dist', 'coverage', '.tmp', 'credentials', 'runtime', 'state', 'state-root', 'secrets')
    foreach ($file in Get-ChildItem -LiteralPath $Source -Recurse -File -Force) {
        $relative = Get-RelativeChildPath -Parent $Source -Child $file.FullName
        $segments = $relative.Split('/')
        if ($segments[0] -eq 'release') { continue }
        if (@($segments | Where-Object { $_ -in $excludedDirectories -or $_ -like '.stage-*' -or $_ -like '.verify-*' }).Count -gt 0) { continue }
        if ($file.Name -match '^(work-host\.local\.json|\.env(\.(?!example$).+)?|\.credentials\.ya?ml|\.npmrc|handoff-.*\.ps1|LIVE_VALIDATION_.*\.md)$') { continue }
        if ($file.Name -match '\.(credentials\.json|secrets\.json|secret|token)$') { continue }
        if ($file.Name -match '\.(log|pem|key|pfx|p12|zip|exe)$') { continue }
        $target = Join-Path $Destination $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
    }
}

function Write-InstanceEntrypoint {
    param([string]$ReleaseRoot, [string]$Id)
    $display = (Get-Culture).TextInfo.ToTitleCase($Id)
    $profile = [ordered]@{ schema_version = 1; instance_id = $Id; contains_secrets = $false }
    [IO.File]::WriteAllText(
        (Join-Path $ReleaseRoot 'DEPLOYMENT_PROFILE.json'),
        (($profile | ConvertTo-Json -Depth 3) + "`n"),
        [Text.UTF8Encoding]::new($false)
    )
    $wrapper = @"
[CmdletBinding()]
param(
    [string]`$BaseRoot,
    [string]`$InstallRoot,
    [string]`$StateRoot,
    [string]`$DshRoot,
    [switch]`$NoDshBootstrap,
    [switch]`$SkipValidation
)
`$arguments = @{ InstanceId = '$Id' }
foreach (`$name in @('BaseRoot','InstallRoot','StateRoot','DshRoot')) {
    if (-not [string]::IsNullOrWhiteSpace((Get-Variable -Name `$name -ValueOnly))) { `$arguments[`$name] = Get-Variable -Name `$name -ValueOnly }
}
if (`$NoDshBootstrap) { `$arguments.NoDshBootstrap = `$true }
if (`$SkipValidation) { `$arguments.SkipValidation = `$true }
& (Join-Path `$PSScriptRoot 'scripts\deploy\install-windows.ps1') @arguments
exit `$LASTEXITCODE
"@
    [IO.File]::WriteAllText((Join-Path $ReleaseRoot ("Install-" + $display + '.ps1')), $wrapper, [Text.UTF8Encoding]::new($false))
}

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$pin = Get-Content -LiteralPath (Join-Path $projectRoot 'config\dsh-pin.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not [string]::IsNullOrWhiteSpace($SourceTag) -and $SourceTag -ne ('v' + [string]$package.version)) {
    throw "SourceTag does not match package version $($package.version): $SourceTag"
}
$defaultReleaseRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $projectRoot) 'kai-work-host-release')).TrimEnd('\')
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = $defaultReleaseRoot }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-PathWithin -Candidate $OutputDirectory -Parent $projectRoot) {
    throw "OutputDirectory must be outside the source tree to avoid recursive release packaging: $projectRoot"
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
if ([string]::IsNullOrWhiteSpace($ArtifactName)) {
    $ArtifactName = if ([string]::IsNullOrWhiteSpace($InstanceId)) {
        'KAI-Work-Host-' + [string]$package.version
    } else {
        'KAI-Work-Host-' + (Get-Culture).TextInfo.ToTitleCase($InstanceId) + '-' + [string]$package.version
    }
}
if ($ArtifactName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]+$') { throw "ArtifactName is not release-safe: $ArtifactName" }

$git = (Get-Command git.exe -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$sourceCommit = $null
$sourceState = 'uncommitted-local-build'
$previousErrorAction = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $head = @(& $git -C $projectRoot rev-parse --verify HEAD 2>$null)
    $headExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorAction
}
if ($headExitCode -eq 0) {
    $sourceCommit = ($head -join '').Trim()
    $dirty = @(& $git -C $projectRoot status --porcelain --untracked-files=all)
    $sourceState = if ($dirty.Count -eq 0) { 'clean-commit' } else { 'dirty-working-tree' }
}
if ($sourceState -ne 'clean-commit' -and -not $AllowUncommitted) {
    throw "Public release packaging requires a clean Git commit; current source state is $sourceState. Use -AllowUncommitted only for a clearly labelled local deployment package."
}

& $node (Join-Path $projectRoot 'scripts\release\scan-public-tree.mjs') $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'Source public-tree scan failed.' }
if (-not $SkipValidation) {
    Invoke-Native -FilePath $npm -Arguments @('run', 'validate') -WorkingDirectory $projectRoot
}
Invoke-Native -FilePath $npm -Arguments @('run', 'release:sbom') -WorkingDirectory $projectRoot

$stageParent = Join-Path $OutputDirectory ('.stage-' + [guid]::NewGuid().ToString('N'))
$stageRoot = Join-Path $stageParent $ArtifactName
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
$zipPath = Join-Path $OutputDirectory ($ArtifactName + '.zip')
$checksumPath = $zipPath + '.sha256'
try {
    Copy-PublicTree -Source $projectRoot -Destination $stageRoot
    if (-not [string]::IsNullOrWhiteSpace($InstanceId)) { Write-InstanceEntrypoint -ReleaseRoot $stageRoot -Id $InstanceId }
    & $node (Join-Path $stageRoot 'scripts\release\scan-public-tree.mjs') $stageRoot
    if ($LASTEXITCODE -ne 0) { throw 'Staged public-tree scan failed.' }

    $files = @(Get-ChildItem -LiteralPath $stageRoot -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
        [ordered]@{
            path = Get-RelativeChildPath -Parent $stageRoot -Child $_.FullName
            bytes = [int64]$_.Length
            sha256 = Get-Sha256Hex -Path $_.FullName
        }
    })
    $manifest = [ordered]@{
        schema_version = 1
        name = $ArtifactName
        package = [string]$package.name
        version = [string]$package.version
        license = [string]$package.license
        generated_at_utc = [DateTime]::UtcNow.ToString('o')
        source = [ordered]@{ state = $sourceState; commit = $sourceCommit; tag = if ([string]::IsNullOrWhiteSpace($SourceTag)) { $null } else { $SourceTag } }
        deployment = if ([string]::IsNullOrWhiteSpace($InstanceId)) { $null } else { [ordered]@{ instance_id = $InstanceId; contains_secrets = $false } }
        dsh = [ordered]@{ repository = [string]$pin.repository; version = [string]$pin.version; commit = [string]$pin.commit }
        mcp_contract = [ordered]@{ public_tools = 18; raw_tools = 19; private_tools = @('file_image_preview_restore') }
        files = $files
    }
    [IO.File]::WriteAllText((Join-Path $stageRoot 'RELEASE-MANIFEST.json'), (($manifest | ConvertTo-Json -Depth 7) + "`n"), [Text.UTF8Encoding]::new($false))

    if (Test-Path -LiteralPath $zipPath) {
        if (-not $Force) { throw "Release ZIP already exists: $zipPath" }
        Remove-Item -LiteralPath $zipPath -Force
    }
    if (Test-Path -LiteralPath $checksumPath) {
        if (-not $Force) { throw "Release checksum already exists: $checksumPath" }
        Remove-Item -LiteralPath $checksumPath -Force
    }
    Compress-Archive -LiteralPath $stageRoot -DestinationPath $zipPath -CompressionLevel Optimal
    $zipHash = Get-Sha256Hex -Path $zipPath
    [IO.File]::WriteAllText($checksumPath, ($zipHash + '  ' + [IO.Path]::GetFileName($zipPath) + "`n"), [Text.UTF8Encoding]::new($false))
    & (Join-Path $projectRoot 'scripts\release\verify-release.ps1') -ZipPath $zipPath
    if ($LASTEXITCODE -ne 0) { throw 'Release archive verification failed.' }
    [pscustomobject]@{
        ok = $true
        artifact = $zipPath
        checksum = $checksumPath
        sha256 = $zipHash
        sourceState = $sourceState
        instanceId = if ([string]::IsNullOrWhiteSpace($InstanceId)) { $null } else { $InstanceId }
        containsSecrets = $false
    } | ConvertTo-Json -Depth 4
} finally {
    $resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
    $resolvedStage = [IO.Path]::GetFullPath($stageParent).TrimEnd('\')
    if ($resolvedStage.StartsWith($resolvedOutput + '\.stage-', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStage)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
