[CmdletBinding()]
param(
    [string]$Alias = "kai-work-host",
    [string]$ProfileName = "kai-work-host",
    [string]$ProfileDir,
    [string]$TunnelClient,
    [switch]$Restart
)

$ErrorActionPreference = "Stop"

$userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$bridgeRoot = if ($env:CODEX_CHATGPT_WEB_HOME) {
    [Environment]::ExpandEnvironmentVariables($env:CODEX_CHATGPT_WEB_HOME)
} else {
    Join-Path $userProfile ".codex-chatgpt-web"
}
if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
    $ProfileDir = Join-Path $bridgeRoot "tunnel\profiles"
}
if ([string]::IsNullOrWhiteSpace($TunnelClient)) {
    $TunnelClient = Join-Path $bridgeRoot "bin\tunnel-client.exe"
}

function Invoke-TunnelJson {
    param([string[]]$Arguments)

    $text = (& $TunnelClient @Arguments 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        throw "tunnel-client failed for: $($Arguments[0..1] -join ' ')"
    }
    return $text | ConvertFrom-Json
}

function Normalize-PathEntry {
    param([string]$Value)

    $trimmed = [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"'))
    try {
        return [IO.Path]::GetFullPath($trimmed).TrimEnd('\')
    } catch {
        return $trimmed.TrimEnd('\')
    }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$plannerPath = Join-Path $PSScriptRoot "..\dist\tunnel-process.js"

function Get-ProcessSnapshot { return @(Get-CimInstance Win32_Process) }
function Get-ProcessFromSnapshot { param([object[]]$Processes,[int]$ProcessId) return (@($Processes | Where-Object { [int]$_.ProcessId -eq $ProcessId }) | Select-Object -First 1) }
function Get-ProcessIdentity { param([object]$Process,[string]$Kind) return [pscustomobject]@{ Kind=$Kind; ProcessId=[int]$Process.ProcessId; ParentProcessId=[int]$Process.ParentProcessId; CreationDate=[string]$Process.CreationDate; Name=[string]$Process.Name; CommandLine=[string]$Process.CommandLine } }
function Test-ProcessIdentityMatches { param([object]$Identity,[object]$Process) if($null -eq $Process){return $false}; return ([int]$Process.ProcessId -eq [int]$Identity.ProcessId -and [int]$Process.ParentProcessId -eq [int]$Identity.ParentProcessId -and [string]$Process.CreationDate -eq [string]$Identity.CreationDate -and [string]$Process.Name -eq [string]$Identity.Name -and [string]$Process.CommandLine -eq [string]$Identity.CommandLine) }
function Get-RecordedProcessIfStillPresent { param([object]$Identity,[object[]]$Processes) $current=Get-ProcessFromSnapshot -Processes $Processes -ProcessId ([int]$Identity.ProcessId); if($null -eq $current){return $null}; if(-not (Test-ProcessIdentityMatches -Identity $Identity -Process $current)){throw "Process identity changed for recorded PID $($Identity.ProcessId); refusing managed cleanup."}; return $current }
function Get-DescendantProcesses { param([object[]]$Processes,[int]$RootProcessId) $pending=@($RootProcessId); $seen=@{}; $seen[$RootProcessId]=$true; $result=@(); while($pending.Count -gt 0){$parentProcessId=[int]$pending[0]; if($pending.Count -gt 1){$pending=@($pending[1..($pending.Count-1)])}else{$pending=@()}; foreach($child in @($Processes | Where-Object { [int]$_.ParentProcessId -eq $parentProcessId })){ $childProcessId=[int]$child.ProcessId; if(-not $seen.ContainsKey($childProcessId)){ $seen[$childProcessId]=$true; $result += $child; $pending += $childProcessId } } }; return @($result) }
function Get-ProcessPlan {
    param([object[]]$Processes,[Nullable[int]]$CurrentTunnelPid,[bool]$IncludeDecision=$false,[bool]$ManagedReady=$false)
    if(-not (Test-Path -LiteralPath $plannerPath -PathType Leaf)){ throw "The tunnel process planner was not built: $plannerPath" }
    $payload = [pscustomobject]@{
        processes = @($Processes | ForEach-Object { [pscustomobject]@{ processId=[int]$_.ProcessId; parentProcessId=[int]$_.ParentProcessId; creationDate=[string]$_.CreationDate; name=[string]$_.Name; commandLine=if($null -eq $_.CommandLine){$null}else{[string]$_.CommandLine} } })
        currentTunnelPid = $CurrentTunnelPid
        options = [pscustomobject]@{ profileName=$ProfileName; profileDir=$ProfileDir; projectRoot=$projectRoot }
        restart = if($IncludeDecision){[bool]$Restart}else{$null}
        managedReady = if($IncludeDecision){[bool]$ManagedReady}else{$null}
    } | ConvertTo-Json -Depth 8 -Compress
    $output = ($payload | & node.exe $plannerPath --plan 2>&1) -join "`n"
    if($LASTEXITCODE -ne 0){ throw "The tunnel process planner failed." }
    return $output | ConvertFrom-Json
}
function Get-ChainIdentities {
    param([object]$Chain,[object[]]$Processes)
    $launcher = Get-ProcessFromSnapshot -Processes $Processes -ProcessId ([int]$Chain.launcherPid)
    $node = Get-ProcessFromSnapshot -Processes $Processes -ProcessId ([int]$Chain.nodePid)
    if($null -eq $launcher -or $null -eq $node){ throw "A planned KAI stdio chain disappeared before cleanup; refusing managed cleanup." }
    return @(
        (Get-ProcessIdentity -Process $node -Kind 'host-node')
        (Get-ProcessIdentity -Process $launcher -Kind 'stdio-launcher')
    )
}
function Get-RemainingRecordedIdentities { param([object[]]$Identities,[object[]]$Processes) $remaining=@(); foreach($i in $Identities){if($null -ne (Get-RecordedProcessIfStillPresent -Identity $i -Processes $Processes)){$remaining += $i}}; return @($remaining) }
function Stop-RecordedIdentities {
    param([object[]]$Identities)
    foreach($identity in $Identities){
        $current = Get-RecordedProcessIfStillPresent -Identity $identity -Processes (Get-ProcessSnapshot)
        if($null -ne $current){ Stop-Process -Id ([int]$identity.ProcessId) -Force -ErrorAction Stop }
    }
}
function Invoke-StaleChainCleanup {
    param([object[]]$Chains,[object[]]$Processes)
    $identities=@()
    foreach($chain in $Chains){ $identities += @(Get-ChainIdentities -Chain $chain -Processes $Processes) }
    if($identities.Count -eq 0){ return }
    Stop-RecordedIdentities -Identities $identities
    $deadline=[DateTime]::UtcNow.AddSeconds(5)
    do {
        $remaining=@(Get-RemainingRecordedIdentities -Identities $identities -Processes (Get-ProcessSnapshot))
        if($remaining.Count -eq 0){break}
        if([DateTime]::UtcNow -ge $deadline){throw 'Proven stale/orphan KAI stdio chains did not exit; refusing to reconnect.'}
        Start-Sleep -Milliseconds 250
    } while($true)
}
function Get-TunnelFunctionalHealth {
    param([object]$Status)
    $logPath = $null
    if ($Status.process -and $Status.process.log_path) { $logPath = [string]$Status.process.log_path }
    elseif ($Status.local -and $Status.local.log -and $Status.local.log.path) { $logPath = [string]$Status.local.log.path }
    if (-not $logPath -or -not (Test-Path -LiteralPath $logPath -PathType Leaf)) {
        return [pscustomobject]@{ poisoned=$false; deadlineFailures=0; upstreamNoResponse=0; inspected=0; logPath=$logPath }
    }
    $startedAt = $null
    if ($Status.process -and $Status.process.started_at) {
        try { $startedAt = [DateTimeOffset]::Parse([string]$Status.process.started_at).UtcDateTime } catch { $startedAt = $null }
    }
    $clientInstanceId = $null
    if ($Status.local -and $Status.local.live_admin_ui -and $Status.local.live_admin_ui.status -and $Status.local.live_admin_ui.status.client_instance_id) {
        $clientInstanceId = [string]$Status.local.live_admin_ui.status.client_instance_id
    }
    $deadlineFailures = 0
    $upstreamNoResponse = 0
    $inspected = 0
    foreach ($line in @(Get-Content -LiteralPath $logPath -Tail 700 -ErrorAction SilentlyContinue)) {
        if (-not $line.Trim()) { continue }
        try { $event = $line | ConvertFrom-Json } catch { continue }
        if ($clientInstanceId -and $event.client_instance_id -and [string]$event.client_instance_id -ne $clientInstanceId) { continue }
        if ($null -ne $startedAt -and $event.time) {
            try {
                $eventTime = [DateTimeOffset]::Parse([string]$event.time).UtcDateTime
                if ($eventTime -lt $startedAt) { continue }
            } catch {}
        }
        $inspected += 1
        $message = if ($event.msg) { [string]$event.msg } else { "" }
        if ($message -match '(?i)command response deadline reached') { $deadlineFailures += 1 }
        if ([string]$event.failure_source -eq 'client_internal' -and $event.upstream_response_received -eq $false) { $upstreamNoResponse += 1 }
    }
    return [pscustomobject]@{
        poisoned = [bool]($deadlineFailures -gt 0 -or $upstreamNoResponse -ge 3)
        deadlineFailures = $deadlineFailures
        upstreamNoResponse = $upstreamNoResponse
        inspected = $inspected
        logPath = $logPath
    }
}
function Format-FunctionalHealthIssue {
    param([object]$Health)
    if (-not $Health.poisoned) { return "" }
    return "functional MCP unhealthy: deadline_failures=$($Health.deadlineFailures); upstream_no_response=$($Health.upstreamNoResponse); inspected_log_events=$($Health.inspected); log=$($Health.logPath)"
}

if (-not (Test-Path -LiteralPath $TunnelClient -PathType Leaf)) {
    throw "tunnel-client was not found at the configured path."
}

$profilePath = Join-Path $ProfileDir ($ProfileName + ".yaml")
if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) {
    throw "The managed tunnel profile was not found: $profilePath"
}

$profile = Get-Content -LiteralPath $profilePath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $profile.control_plane.tunnel_id -or -not $profile.control_plane.api_key) {
    throw "The managed tunnel profile is missing its tunnel id or runtime-key reference."
}

$sameTunnelProfiles = @(Get-ChildItem -LiteralPath $ProfileDir -File -Filter "*.yaml" | Where-Object {
    $_.FullName -ne $profilePath
} | ForEach-Object {
    try {
        $candidate = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($candidate.control_plane.tunnel_id -eq $profile.control_plane.tunnel_id) {
            [IO.Path]::GetFileNameWithoutExtension($_.Name)
        }
    } catch {
        throw "Unable to inspect managed tunnel profile $($_.FullName): $($_.Exception.Message)"
    }
})
foreach ($conflictingAlias in $sameTunnelProfiles) {
    $conflictingStatus = Invoke-TunnelJson -Arguments @("runtimes", "status", $conflictingAlias, "--json")
    if ($conflictingStatus.process_running) {
        throw "Runtime alias $conflictingAlias is already polling the same tunnel. Stop that exact alias before starting $Alias."
    }
}

$status = Invoke-TunnelJson -Arguments @("runtimes", "status", $Alias, "--json")
$allProcesses = Get-ProcessSnapshot
$currentTunnelPid = if($status.process_running -and $status.process.pid){ [int]$status.process.pid } else { $null }
$plan = Get-ProcessPlan -Processes $allProcesses -CurrentTunnelPid $currentTunnelPid
if(@($plan.ambiguousReasons).Count -gt 0){
    throw "Refusing managed tunnel change because process identity is ambiguous: $($plan.ambiguousReasons -join '; ')"
}

$staleIdentities = @()
if(@($plan.staleChains).Count -gt 0){
    if(-not $Restart){ throw "Proven stale/orphan KAI stdio chains exist; rerun with explicit -Restart to clean them." }
    foreach($chain in @($plan.staleChains)){ $staleIdentities += @(Get-ChainIdentities -Chain $chain -Processes $allProcesses) }
    Stop-RecordedIdentities -Identities $staleIdentities
    $staleDeadline=[DateTime]::UtcNow.AddSeconds(5)
    do {
        $remaining=@(Get-RemainingRecordedIdentities -Identities $staleIdentities -Processes (Get-ProcessSnapshot))
        if($remaining.Count -eq 0){break}
        if([DateTime]::UtcNow -ge $staleDeadline){throw 'Proven stale/orphan KAI stdio chains did not exit; refusing to reconnect.'}
        Start-Sleep -Milliseconds 250
    } while($true)
}

if($status.process_running){
    $tunnelProcessId = [int]$status.process.pid
    $tunnelProcess = Get-ProcessFromSnapshot -Processes $allProcesses -ProcessId $tunnelProcessId
    if ($null -eq $tunnelProcess) {
        throw "The managed tunnel reported PID $tunnelProcessId, but that process was not found; refusing managed cleanup."
    }
    $tunnelDescendants = @(Get-DescendantProcesses -Processes $allProcesses -RootProcessId $tunnelProcessId)
    $codexSidecars = @($tunnelDescendants | Where-Object {
        $_.Name -match '(?i)^codex(\.exe)?$' -and
        $_.CommandLine -match '(?i)\sapp-server\s*$'
    })
    $functionalHealth = Get-TunnelFunctionalHealth -Status $status
    $currentHostCount = @($plan.currentChains).Count
    $managedReady = [bool]($status.process_running -and $status.ready -and $status.healthy -and $codexSidecars.Count -eq 0 -and $currentHostCount -eq 1 -and -not $functionalHealth.poisoned)
    if(-not $Restart -and $managedReady){
        [pscustomobject]@{
            ok = $true
            alias = $Alias
            state = "already-ready"
            mcpFunctionallyHealthy = $true
            kaiHostCount = $currentHostCount
            codexProductSidecarCount = 0
        } | ConvertTo-Json -Compress
        exit 0
    }
    if(-not $Restart){
        $functionalIssue = Format-FunctionalHealthIssue -Health $functionalHealth
        if ($functionalIssue) { throw "The managed tunnel is superficially ready but $functionalIssue; use explicit -Restart." }
        throw 'The managed tunnel is not ready and healthy; use explicit -Restart.'
    }

    $priorTunnelIdentity=Get-ProcessIdentity -Process $tunnelProcess -Kind 'tunnel'
    $currentChain = @($plan.currentChains)[0]
    $priorStdioIdentities=@(Get-ChainIdentities -Chain $currentChain -Processes $allProcesses)
    $null=Invoke-TunnelJson -Arguments @('runtimes','stop',$Alias,'--json')
    $graceDeadline=[DateTime]::UtcNow.AddSeconds(5)
    do { $snap=Get-ProcessSnapshot; $oldTunnel=$null -ne (Get-RecordedProcessIfStillPresent -Identity $priorTunnelIdentity -Processes $snap); $remaining=@(Get-RemainingRecordedIdentities -Identities $priorStdioIdentities -Processes $snap); if(-not $oldTunnel -and $remaining.Count -eq 0){break}; if([DateTime]::UtcNow -ge $graceDeadline){break}; Start-Sleep -Milliseconds 250 } while($true)
    $snap=Get-ProcessSnapshot
    if($null -ne (Get-RecordedProcessIfStillPresent -Identity $priorTunnelIdentity -Processes $snap)){throw 'The prior managed tunnel did not exit after runtimes stop; refusing to reconnect.'}
    $remaining=@(Get-RemainingRecordedIdentities -Identities $priorStdioIdentities -Processes $snap)
    if($remaining.Count -gt 0){ Stop-RecordedIdentities -Identities $remaining; $deadline=[DateTime]::UtcNow.AddSeconds(5); do{$remaining=@(Get-RemainingRecordedIdentities -Identities $priorStdioIdentities -Processes (Get-ProcessSnapshot)); if($remaining.Count -eq 0){break}; if([DateTime]::UtcNow -ge $deadline){throw 'Recorded stdio descendants from the prior managed tunnel did not exit; refusing to reconnect.'}; Start-Sleep -Milliseconds 250}while($true) }
}

$codexDirectories = @(Get-Command codex.exe -All -ErrorAction SilentlyContinue |
    ForEach-Object { Normalize-PathEntry (Split-Path -Parent $_.Source) } |
    Select-Object -Unique)

if ($codexDirectories.Count -gt 0) {
    $pathEntries = @($env:Path -split ';' | Where-Object {
        $_ -and ((Normalize-PathEntry $_) -notin $codexDirectories)
    })
    $env:Path = $pathEntries -join ';'
}

Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:OPENAI_ORGANIZATION -ErrorAction SilentlyContinue
Remove-Item Env:OPENAI_PROJECT -ErrorAction SilentlyContinue

if (Get-Command codex.exe -ErrorAction SilentlyContinue) {
    throw "Codex remains discoverable after the managed PATH isolation."
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw "Node is unavailable after the managed PATH isolation."
}

$stdioScript = Join-Path $PSScriptRoot "start-stdio.ps1"
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "dist\stdio.js") -PathType Leaf)) {
    throw "KAI Work Host is not built. Run npm run build first."
}

$stdioPath = $stdioScript.Replace('\', '/')
$mcpCommand = '"C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $stdioPath + '"'
$null = Invoke-TunnelJson -Arguments @(
    "runtimes", "connect",
    "--alias", $Alias,
    "--profile", $ProfileName,
    "--profile-dir", $ProfileDir,
    "--tunnel-id", [string]$profile.control_plane.tunnel_id,
    "--runtime-api-key", [string]$profile.control_plane.api_key,
    "--mcp-command", $mcpCommand,
    "--json"
)

$readyDeadline=[DateTime]::UtcNow.AddSeconds(10)
$finalStatus=$null
$finalProcesses=@()
$finalTunnelPid=$null
$finalSidecars=@()
$hostNodes=@()
$finalPlan=$null
$finalFunctionalHealth=$null
$managedReady=$false
do {
    $finalStatus=Invoke-TunnelJson -Arguments @("runtimes", "status", $Alias, "--json")
    if($finalStatus.process_running -and $finalStatus.process.pid){
        $finalTunnelPid=[int]$finalStatus.process.pid
        $finalProcesses=Get-ProcessSnapshot
        $finalTunnelProcess=Get-ProcessFromSnapshot -Processes $finalProcesses -ProcessId $finalTunnelPid
        if($null -ne $finalTunnelProcess){
            $finalDescendants=@(Get-DescendantProcesses -Processes $finalProcesses -RootProcessId $finalTunnelPid)
            $finalSidecars=@($finalDescendants | Where-Object {
                $_.Name -match '(?i)^codex(\.exe)?$' -and
                $_.CommandLine -match '(?i)\sapp-server\s*$'
            })
            $finalPlan=Get-ProcessPlan -Processes $finalProcesses -CurrentTunnelPid $finalTunnelPid
            if($finalSidecars.Count -gt 0){throw "The tunnel started an unexpected Codex product sidecar."}
            if(@($finalPlan.staleChains).Count -gt 0){throw "A stale/orphan KAI stdio chain appeared during managed restart."}
            $finalFunctionalHealth = Get-TunnelFunctionalHealth -Status $finalStatus
            if(@($finalPlan.ambiguousReasons).Count -eq 0){
                $hostNodes=@($finalPlan.currentChains | ForEach-Object { $_.nodePid })
                if($finalStatus.process_running -and $finalStatus.ready -and $finalStatus.healthy -and $hostNodes.Count -eq 1 -and -not $finalFunctionalHealth.poisoned){$managedReady=$true; break}
            }
        }
    }
    if([DateTime]::UtcNow -ge $readyDeadline){break}
    Start-Sleep -Milliseconds 250
}while($true)
if(-not $managedReady){
    if($null -ne $finalPlan -and @($finalPlan.ambiguousReasons).Count -gt 0){
        throw "The managed tunnel process topology did not stabilize: $($finalPlan.ambiguousReasons -join '; ')"
    }
    if($finalFunctionalHealth -and $finalFunctionalHealth.poisoned){
        throw "The managed KAI Work Host tunnel restarted but remains functionally unhealthy: $(Format-FunctionalHealthIssue -Health $finalFunctionalHealth)"
    }
    throw "The managed KAI Work Host tunnel did not become ready and healthy with exactly one descendant stdio process."
}

[pscustomobject]@{
    ok = $true
    alias = $Alias
    state = "ready"
    mcpFunctionallyHealthy = $true
    tunnelClientCount = @($finalPlan.managedTunnelPids).Count
    kaiHostCount = $hostNodes.Count
    codexProductSidecarCount = $finalSidecars.Count
} | ConvertTo-Json -Compress
