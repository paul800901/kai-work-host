export interface ProcessSnapshot {
  processId: number;
  parentProcessId: number;
  creationDate?: string | null;
  name: string;
  commandLine?: string | null;
}

export interface TunnelProcessOptions {
  profileName: string;
  profileDir: string;
  projectRoot: string;
}

export interface StdioChain {
  launcherPid: number;
  nodePid: number;
  evidence: string;
}

export interface ProcessClassification {
  managedTunnelPids: number[];
  currentChains: StdioChain[];
  staleChains: StdioChain[];
  unclassifiedKaiPids: number[];
  ambiguousReasons: string[];
}

export interface RestartPlan {
  action: "already-ready" | "connect" | "restart" | "fail-closed";
  cleanupChains: StdioChain[];
  stopManagedTunnel: boolean;
  connect: boolean;
  reason?: string;
}

interface PlannerInput {
  processes: ProcessSnapshot[];
  currentTunnelPid: number | null;
  options: TunnelProcessOptions;
  restart?: boolean | null;
  managedReady?: boolean | null;
}

export function parsePlannerInput(inputText: string): PlannerInput {
  // Windows PowerShell 5.1 writes a UTF-8 BOM when piping text to a native
  // process. Accept it so the managed tunnel launcher works from both
  // powershell.exe and modern pwsh.exe.
  return JSON.parse(inputText.replace(/^\uFEFF/u, "")) as PlannerInput;
}

function normalized(value: string): string {
  return value.trim().replaceAll("\\", "/").replaceAll(/\/+/g, "/").replace(/\/$/, "").toLowerCase();
}

function commandOf(process: ProcessSnapshot): string {
  return normalized(process.commandLine ?? "");
}

function nameIs(process: ProcessSnapshot, name: string): boolean {
  return process.name.toLowerCase().replace(/\.exe$/, "") === name;
}

export function isKaiStdioLauncher(process: ProcessSnapshot, projectRoot: string): boolean {
  return nameIs(process, "powershell") && commandOf(process).includes(`${normalized(projectRoot)}/scripts/start-stdio.ps1`);
}

export function isKaiHostNode(process: ProcessSnapshot, projectRoot: string): boolean {
  return nameIs(process, "node") && commandOf(process).includes(`${normalized(projectRoot)}/dist/stdio.js`);
}

export function isManagedTunnelClient(process: ProcessSnapshot, options: TunnelProcessOptions): boolean {
  const command = commandOf(process);
  const profileDir = normalized(options.profileDir);
  return nameIs(process, "tunnel-client") &&
    /(?:^|\s)run(?:\s|$)/u.test(command) &&
    command.includes(`--profile ${normalized(options.profileName)}`) &&
    command.includes(`--profile-dir ${profileDir}`);
}

function byId(processes: ProcessSnapshot[]): Map<number, ProcessSnapshot> {
  return new Map(processes.map((process) => [process.processId, process]));
}

function ancestors(process: ProcessSnapshot, processesById: Map<number, ProcessSnapshot>): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  let parentId = process.parentProcessId;
  while (parentId > 0 && !seen.has(parentId)) {
    seen.add(parentId);
    result.push(parentId);
    const parent = processesById.get(parentId);
    if (parent === undefined) break;
    parentId = parent.parentProcessId;
  }
  return result;
}

export function classifyProcessSnapshot(
  processes: ProcessSnapshot[],
  currentTunnelPid: number | null,
  options: TunnelProcessOptions,
): ProcessClassification {
  const processesById = byId(processes);
  const launchers = processes.filter((process) => isKaiStdioLauncher(process, options.projectRoot));
  const nodes = processes.filter((process) => isKaiHostNode(process, options.projectRoot));
  const managedTunnels = processes.filter((process) => isManagedTunnelClient(process, options));
  const managedTunnelPids = managedTunnels.map((process) => process.processId);
  const reasons: string[] = [];
  const chains: StdioChain[] = [];
  const chainPids = new Set<number>();

  for (const launcher of launchers) {
    const childNodes = nodes.filter((node) => node.parentProcessId === launcher.processId);
    if (childNodes.length === 1) {
      const node = childNodes[0];
      if (node === undefined) continue;
      chains.push({
        launcherPid: launcher.processId,
        nodePid: node.processId,
        evidence: `launcher ${launcher.processId} directly owns node ${node.processId}`,
      });
      chainPids.add(launcher.processId);
      chainPids.add(node.processId);
    } else {
      reasons.push(`launcher ${launcher.processId} has ${childNodes.length} direct KAI node children`);
    }
  }

  const currentChains: StdioChain[] = [];
  const staleChains: StdioChain[] = [];
  for (const chain of chains) {
    const launcher = processesById.get(chain.launcherPid);
    if (launcher === undefined) continue;
    const chainAncestors = ancestors(launcher, processesById);
    if (currentTunnelPid !== null && chainAncestors.includes(currentTunnelPid)) {
      currentChains.push(chain);
      if (launcher.parentProcessId !== currentTunnelPid) {
        reasons.push(`current launcher ${chain.launcherPid} is not directly owned by tunnel ${currentTunnelPid}`);
      }
    } else {
      staleChains.push({ ...chain, evidence: `${chain.evidence}; no current tunnel ancestor` });
    }
  }

  const currentTunnel = currentTunnelPid === null ? undefined : processesById.get(currentTunnelPid);
  if (currentTunnelPid !== null && currentTunnel === undefined) {
    reasons.push(`current tunnel PID ${currentTunnelPid} is absent from the process snapshot`);
  }
  if (currentTunnelPid !== null && !managedTunnelPids.includes(currentTunnelPid)) {
    reasons.push(`current tunnel PID ${currentTunnelPid} does not match the managed profile command line`);
  }
  if (currentTunnelPid === null && managedTunnelPids.length > 0) {
    reasons.push(`managed tunnel process(es) ${managedTunnelPids.join(", ")} exist without a status PID`);
  }
  if (managedTunnelPids.length > 1) {
    reasons.push(`multiple managed tunnel clients found: ${managedTunnelPids.join(", ")}`);
  }
  if (currentChains.length > 1) {
    reasons.push(`multiple current KAI stdio chains found: ${currentChains.map((chain) => chain.nodePid).join(", ")}`);
  }

  const currentTunnelDescendants = currentTunnelPid === null
    ? new Set<number>()
    : new Set(processes.filter((process) => ancestors(process, processesById).includes(currentTunnelPid)).map((process) => process.processId));
  const unclassifiedKaiPids = [...launchers, ...nodes]
    .filter((process) => !chainPids.has(process.processId))
    .filter((process) => currentTunnelDescendants.has(process.processId))
    .map((process) => process.processId);
  if (unclassifiedKaiPids.length > 0) {
    reasons.push(`unclassified KAI stdio process(es) under current tunnel: ${unclassifiedKaiPids.join(", ")}`);
  }

  return {
    managedTunnelPids,
    currentChains,
    staleChains,
    unclassifiedKaiPids,
    ambiguousReasons: [...new Set(reasons)],
  };
}

export function planManagedTunnel(
  classification: ProcessClassification,
  options: { restart: boolean; managedReady: boolean },
): RestartPlan {
  if (classification.ambiguousReasons.length > 0) {
    return {
      action: "fail-closed",
      cleanupChains: [],
      stopManagedTunnel: false,
      connect: false,
      reason: classification.ambiguousReasons.join("; "),
    };
  }

  const hasCurrent = classification.currentChains.length === 1;
  const hasStale = classification.staleChains.length > 0;
  if (!options.restart) {
    if (hasStale) {
      return {
        action: "fail-closed",
        cleanupChains: [],
        stopManagedTunnel: false,
        connect: false,
        reason: "proven stale/orphan KAI stdio chains require explicit -Restart",
      };
    }
    if (hasCurrent && options.managedReady) {
      return { action: "already-ready", cleanupChains: [], stopManagedTunnel: false, connect: false };
    }
    if (hasCurrent) {
      return {
        action: "fail-closed",
        cleanupChains: [],
        stopManagedTunnel: false,
        connect: false,
        reason: "managed tunnel is not ready; use explicit -Restart",
      };
    }
  }

  return {
    action: hasCurrent ? "restart" : "connect",
    cleanupChains: classification.staleChains,
    stopManagedTunnel: hasCurrent,
    connect: true,
  };
}

async function runPlannerCli(): Promise<void> {
  let inputText = "";
  for await (const chunk of process.stdin) inputText += chunk;
  const input = parsePlannerInput(inputText);
  const classification = classifyProcessSnapshot(input.processes, input.currentTunnelPid, input.options);
  const decision = input.restart === undefined || input.restart === null
    ? undefined
    : planManagedTunnel(classification, { restart: input.restart, managedReady: input.managedReady ?? false });
  process.stdout.write(JSON.stringify(decision === undefined ? classification : { ...classification, decision }));
}

if (process.argv.includes("--plan")) {
  await runPlannerCli();
}
