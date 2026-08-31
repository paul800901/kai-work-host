$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$entrypoint = Join-Path $projectRoot "scripts\launch.mjs"
if (-not (Test-Path -LiteralPath $entrypoint)) {
    throw "KAI Work Host launcher is missing: $entrypoint"
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "dist\stdio.js"))) {
    throw "KAI Work Host is not built. Run npm run build first."
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node $entrypoint stdio
exit $LASTEXITCODE
