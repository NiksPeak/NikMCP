import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context, CommandResult } from "./types.js";
import { getSettings } from "./settings.js";
import { INTERNAL_ROUTE_HEADER, internalRouteToken } from "./internal-auth.js";

const execFileAsync = promisify(execFile);

export interface StudioProcessInfo {
  pid: number | null;
  windowTitle: string | null;
  filePath: string | null;
}

export interface PluginTargetIdentity {
  targetId: string;
  studioSessionId: string;
  placeId: number;
  universeId: number;
  placeName: string;
}

export interface StudioTarget {
  kind: "nikmcp-studio-target";
  targetId: string;
  studioSessionId: string;
  bridgePort: number;
  bridgePorts?: number[];
  windowTitle: string | null;
  studioPid: number | null;
  placeId: number;
  universeId: number;
  placeName: string;
  placeFilePath: string | null;
  state: "edit" | "runtime" | "disconnected";
  health: {
    bridge: boolean;
    plugin: boolean;
    runtimeAgent: boolean;
    clientAgent?: boolean;
    editAgeMs: number | null;
    serverAgeMs: number | null;
  };
  connectedToThisMcp: boolean;
  selected: boolean;
}

interface TargetConfig {
  basePort: number;
  portRange: number;
  localPort: () => number | null;
}

let config: TargetConfig | null = null;
let localIdentity: (PluginTargetIdentity & StudioProcessInfo) | null = null;
let claimedTargetId: string | null = null;
let selectedTarget: StudioTarget | null = null;
let selectedObservedAt = 0;

function authHeaders(json = false): Record<string, string> {
  const out: Record<string, string> = {
    [INTERNAL_ROUTE_HEADER]: internalRouteToken(),
  };
  const settings = getSettings();
  if (settings.auth.enabled && settings.auth.token) {
    out["x-mcp-token"] = settings.auth.token;
  }
  if (json) out["content-type"] = "application/json";
  return out;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 1200): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function assertConfigured(): TargetConfig {
  if (!config) throw new Error("Studio target routing is not configured");
  return config;
}

export function configureStudioTargets(next: TargetConfig): void {
  config = next;
}

export function getLocalTargetIdentity(): (PluginTargetIdentity & StudioProcessInfo) | null {
  return localIdentity ? { ...localIdentity } : null;
}

export function claimLocalTargetId(targetId: string, activeTargetIsAlive: boolean): boolean {
  if (!targetId) return false;
  if (!claimedTargetId) {
    claimedTargetId = targetId;
    return true;
  }
  if (claimedTargetId === targetId) return true;
  if (activeTargetIsAlive) return false;
  claimedTargetId = targetId;
  localIdentity = null;
  return true;
}

// v0.2.0: non-mutating preview of claimLocalTargetId, used by /heartbeat so a
// runtime agent can discover WHICH bridge owns its Studio window before it
// starts polling (instead of learning it from a 409 busy-loop).
export function wouldAcceptTargetId(targetId: string, activeTargetIsAlive: boolean): {
  accepts: boolean;
  exact: boolean;
  leasedTargetId: string | null;
} {
  if (!targetId) return { accepts: false, exact: false, leasedTargetId: claimedTargetId };
  if (!claimedTargetId) return { accepts: true, exact: false, leasedTargetId: null };
  if (claimedTargetId === targetId) return { accepts: true, exact: true, leasedTargetId: claimedTargetId };
  return { accepts: !activeTargetIsAlive, exact: false, leasedTargetId: claimedTargetId };
}

export function setLocalTargetIdentity(
  identity: PluginTargetIdentity,
  processInfo: StudioProcessInfo
): void {
  claimedTargetId = identity.targetId;
  const prior = localIdentity?.targetId === identity.targetId ? localIdentity : null;
  localIdentity = {
    ...identity,
    pid: processInfo.pid ?? prior?.pid ?? null,
    windowTitle: processInfo.windowTitle ?? prior?.windowTitle ?? null,
    filePath: processInfo.filePath ?? prior?.filePath ?? null,
  };
}

export async function resolveWindowsStudioProcess(
  studioSocketPort: number | undefined,
  bridgePort: number | null
): Promise<StudioProcessInfo> {
  if (process.platform !== "win32" || !studioSocketPort || !bridgePort) {
    return { pid: null, windowTitle: null, filePath: null };
  }
  const script = [
    `$tcp = Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq ${studioSocketPort} -and $_.RemotePort -eq ${bridgePort} } | Select-Object -First 1`,
    "if (-not $tcp) { exit 0 }",
    "$proc = Get-CimInstance Win32_Process -Filter \"ProcessId=$($tcp.OwningProcess)\" -ErrorAction SilentlyContinue",
    "if (-not $proc -or $proc.Name -notlike 'RobloxStudio*') { exit 0 }",
    "$gp = Get-Process -Id $tcp.OwningProcess -ErrorAction SilentlyContinue",
    "$file = $null",
    "if ($proc.CommandLine -match '(?i)(?:^|\\s)-file\\s+\"([^\"]+)\"') { $file = $Matches[1] }",
    "[pscustomobject]@{ pid=[int]$tcp.OwningProcess; windowTitle=$gp.MainWindowTitle; filePath=$file } | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 2500, windowsHide: true }
    );
    const trimmed = stdout.trim();
    if (!trimmed) return { pid: null, windowTitle: null, filePath: null };
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      windowTitle: typeof parsed.windowTitle === "string" && parsed.windowTitle ? parsed.windowTitle : null,
      filePath: typeof parsed.filePath === "string" && parsed.filePath ? parsed.filePath : null,
    };
  } catch {
    return { pid: null, windowTitle: null, filePath: null };
  }
}

async function readTarget(port: number): Promise<StudioTarget | null> {
  const cfg = assertConfigured();
  try {
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${port}/target`,
      { headers: authHeaders() },
      900
    );
    if (!response.ok) return null;
    const body = (await response.json()) as StudioTarget;
    if (body.kind !== "nikmcp-studio-target" || !body.targetId) return null;
    if (!body.health?.plugin && !body.health?.runtimeAgent) return null;
    return {
      ...body,
      bridgePort: port,
      connectedToThisMcp: port === cfg.localPort(),
      selected: selectedTarget
        ? selectedTarget.targetId === body.targetId && selectedTarget.bridgePort === port
        : port === cfg.localPort(),
    };
  } catch {
    return null;
  }
}

export async function discoverStudioTargets(): Promise<StudioTarget[]> {
  const cfg = assertConfigured();
  const ports = Array.from({ length: cfg.portRange }, (_, i) => cfg.basePort + i);
  const routes = (await Promise.all(ports.map(readTarget))).filter((v): v is StudioTarget => v !== null);
  const grouped = new Map<string, StudioTarget>();
  for (const route of routes.sort((a, b) => a.bridgePort - b.bridgePort)) {
    const prior = grouped.get(route.targetId);
    if (!prior) {
      grouped.set(route.targetId, { ...route, bridgePorts: [route.bridgePort] });
      continue;
    }
    const priorWasLocal = prior.connectedToThisMcp;
    prior.bridgePorts = [...(prior.bridgePorts ?? [prior.bridgePort]), route.bridgePort];
    prior.connectedToThisMcp ||= route.connectedToThisMcp;
    prior.selected ||= route.selected;
    if (route.selected || (!priorWasLocal && route.connectedToThisMcp)) {
      prior.bridgePort = route.bridgePort;
    }
  }
  return [...grouped.values()].sort((a, b) => a.bridgePort - b.bridgePort);
}

export async function selectStudioTarget(input: {
  targetId?: string;
  bridgePort?: number;
}): Promise<StudioTarget> {
  if (!input.targetId && input.bridgePort === undefined) {
    throw new Error("select_studio_target requires targetId or bridgePort");
  }
  const targets = await discoverStudioTargets();
  const byPort = input.bridgePort === undefined
    ? null
    : targets.find((t) => t.bridgePort === input.bridgePort || t.bridgePorts?.includes(input.bridgePort!));
  const byId = input.targetId ? targets.find((t) => t.targetId === input.targetId) : null;
  if (input.bridgePort !== undefined && !byPort) {
    throw new Error(`no reachable Studio target on bridge port ${input.bridgePort}`);
  }
  if (input.targetId && !byId) {
    throw new Error(`no reachable Studio target with id '${input.targetId}'`);
  }
  if (byPort && byId && byPort.targetId !== byId.targetId) {
    throw new Error("targetId and bridgePort refer to different Studio windows");
  }
  const chosen = (byPort ?? byId)!;
  const port = input.bridgePort ?? chosen.bridgePort;
  selectedTarget = { ...chosen, bridgePort: port, selected: true };
  selectedObservedAt = Date.now();
  return { ...selectedTarget };
}

export function getSelectedStudioTarget(): StudioTarget | null {
  return selectedTarget ? { ...selectedTarget } : null;
}

export function selectedTargetPort(localPort: number | null): number | null {
  return selectedTarget?.bridgePort ?? localPort;
}

export function selectedContextHealth(context: Context): { alive: boolean; ageMs: number | null } | null {
  if (!selectedTarget) return null;
  const alive = context === "edit" ? selectedTarget.health.plugin : selectedTarget.health.runtimeAgent;
  const baseAge = context === "edit" ? selectedTarget.health.editAgeMs : selectedTarget.health.serverAgeMs;
  const ageMs = baseAge === null ? null : baseAge + Math.max(0, Date.now() - selectedObservedAt);
  return { alive, ageMs };
}

async function assertSelectedIdentity(): Promise<StudioTarget | null> {
  if (!selectedTarget) return null;
  const fresh = await readTarget(selectedTarget.bridgePort);
  if (!fresh) {
    throw new Error(
      `selected Studio target '${selectedTarget.targetId}' is no longer reachable on port ${selectedTarget.bridgePort}`
    );
  }
  if (fresh.targetId !== selectedTarget.targetId) {
    throw new Error(
      `selected Studio target identity changed on port ${selectedTarget.bridgePort}; ` +
        `expected '${selectedTarget.targetId}', now '${fresh.targetId}'. Re-run get_studio_targets and select_studio_target.`
    );
  }
  selectedTarget = { ...fresh, selected: true };
  selectedObservedAt = Date.now();
  return selectedTarget;
}

export async function refreshSelectedStudioTarget(): Promise<StudioTarget | null> {
  return assertSelectedIdentity();
}

export async function routeSelectedCommand(
  type: string,
  context: Context,
  payload: unknown,
  timeoutMs: number,
  expectedTargetId?: string,
): Promise<CommandResult | null> {
  const selected = await assertSelectedIdentity();
  if (!selected) return null;
  if (expectedTargetId && selected.targetId !== expectedTargetId) {
    throw new Error(
      `command target changed before routing; expected '${expectedTargetId}', selected '${selected.targetId}'`,
    );
  }
  const cfg = assertConfigured();
  if (selected.bridgePort === cfg.localPort()) return null;
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${selected.bridgePort}/invoke`,
    {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        expectedTargetId: selected.targetId,
        type,
        context,
        payload,
        timeoutMs,
      }),
    },
    timeoutMs + 1500
  );
  const body = (await response.json()) as CommandResult & { error?: string };
  if (!response.ok && !body.id) {
    throw new Error(body.error ?? `selected Studio bridge returned HTTP ${response.status}`);
  }
  return body;
}

export function resetStudioTargetsForTests(): void {
  config = null;
  localIdentity = null;
  claimedTargetId = null;
  selectedTarget = null;
  selectedObservedAt = 0;
}
