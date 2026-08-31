[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ZipPath)

$ErrorActionPreference = 'Stop'

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

$ZipPath = [IO.Path]::GetFullPath($ZipPath)
if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) { throw "Release ZIP not found: $ZipPath" }
$parent = Split-Path -Parent $ZipPath
$verifyRoot = Join-Path $parent ('.verify-' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $verifyRoot) { throw "Unexpected verification path collision: $verifyRoot" }
New-Item -ItemType Directory -Path $verifyRoot | Out-Null

try {
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $verifyRoot
    $roots = @(Get-ChildItem -LiteralPath $verifyRoot -Directory -Force)
    if ($roots.Count -ne 1) { throw 'Release ZIP must contain exactly one top-level directory.' }
    $releaseRoot = $roots[0].FullName
    $manifestPath = Join-Path $releaseRoot 'RELEASE-MANIFEST.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'RELEASE-MANIFEST.json is missing.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $declared = @{}
    foreach ($entry in @($manifest.files)) {
        $relative = ([string]$entry.path).Replace('/', '\')
        $candidate = [IO.Path]::GetFullPath((Join-Path $releaseRoot $relative))
        if (-not $candidate.StartsWith($releaseRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Manifest path escapes release root: $($entry.path)"
        }
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Manifest file is missing: $($entry.path)" }
        $file = Get-Item -LiteralPath $candidate
        if ([int64]$file.Length -ne [int64]$entry.bytes) { throw "Size mismatch for $($entry.path)" }
        $hash = Get-Sha256Hex -Path $candidate
        if ($hash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "SHA-256 mismatch for $($entry.path)" }
        $declared[[string]$entry.path] = $true
    }
    foreach ($file in Get-ChildItem -LiteralPath $releaseRoot -Recurse -File -Force) {
        $relative = Get-RelativeChildPath -Parent $releaseRoot -Child $file.FullName
        if ($relative -eq 'RELEASE-MANIFEST.json') { continue }
        if (-not $declared.ContainsKey($relative)) { throw "Undeclared file in release ZIP: $relative" }
    }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    & $node (Join-Path $releaseRoot 'scripts\release\scan-public-tree.mjs') $releaseRoot
    if ($LASTEXITCODE -ne 0) { throw 'Extracted release safety scan failed.' }
    [pscustomobject]@{
        ok = $true
        zipPath = $ZipPath
        name = [string]$manifest.name
        version = [string]$manifest.version
        sourceState = [string]$manifest.source.state
        files = @($manifest.files).Count
        sha256 = (Get-Sha256Hex -Path $ZipPath).ToUpperInvariant()
    } | ConvertTo-Json -Depth 4
} finally {
    $resolvedParent = [IO.Path]::GetFullPath($parent).TrimEnd('\')
    $resolvedVerify = [IO.Path]::GetFullPath($verifyRoot).TrimEnd('\')
    if ($resolvedVerify.StartsWith($resolvedParent + '\.verify-', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedVerify)) {
        Remove-Item -LiteralPath $resolvedVerify -Recurse -Force
    }
}
