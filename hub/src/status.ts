import { clientFor, probeApollo } from "./agentClient.js";
import { hostAddressFromAgentUrl, loadConfig, saveConfig } from "./config.js";
import type { HostConfig, HostLiveStatus, HostSessionState, AgentStatus } from "./types.js";

const HEARTBEAT_STALE_MS = 45_000;
const WAKING_DEFAULT_MS = 120_000;

function isHeartbeatFresh(iso: string | undefined | null): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < HEARTBEAT_STALE_MS;
}

export function markWaking(hostId: string, ms = WAKING_DEFAULT_MS): void {
  const cfg = loadConfig();
  cfg.wakingUntil[hostId] = new Date(Date.now() + ms).toISOString();
  saveConfig(cfg);
}

export function clearWaking(hostId: string): void {
  const cfg = loadConfig();
  if (cfg.wakingUntil[hostId]) {
    delete cfg.wakingUntil[hostId];
    saveConfig(cfg);
  }
}

export function recordHeartbeat(hostId: string): void {
  const cfg = loadConfig();
  cfg.heartbeats[hostId] = new Date().toISOString();
  if (cfg.wakingUntil[hostId]) delete cfg.wakingUntil[hostId];
  saveConfig(cfg);
}

function deriveState(opts: {
  agent?: AgentStatus;
  apolloReachable: boolean;
  lastHeartbeatAt: string | null;
  wakingUntil: string | null;
}): HostSessionState {
  const wakingActive =
    opts.wakingUntil && Date.parse(opts.wakingUntil) > Date.now() ? true : false;

  if (opts.agent) {
    if (opts.agent.locked || opts.agent.sessionState === "locked") return "locked";
    if (opts.apolloReachable) return "ready";
    return "unlocked";
  }

  if (isHeartbeatFresh(opts.lastHeartbeatAt)) {
    // Heartbeat without live poll — treat as unknown-online
    if (wakingActive) return "waking";
    return "unknown";
  }

  if (wakingActive) return "waking";
  return "offline";
}

export async function getLiveStatus(host: HostConfig): Promise<HostLiveStatus> {
  const cfg = loadConfig();
  const lastHeartbeatAt = cfg.heartbeats[host.id] || null;
  let wakingUntil = cfg.wakingUntil[host.id] || null;
  if (wakingUntil && Date.parse(wakingUntil) <= Date.now()) {
    clearWaking(host.id);
    wakingUntil = null;
  }

  if (!host.paired || !host.agentUrl || !host.agentToken) {
    return {
      hostId: host.id,
      state: "offline",
      apolloReachable: false,
      lastHeartbeatAt,
      lastError: "waiting for agent pairing",
      wakingUntil,
    };
  }

  const address = host.hostAddress || hostAddressFromAgentUrl(host.agentUrl);
  const apolloPort = host.apolloPort ?? 47990;

  let agent: AgentStatus | undefined;
  let lastError: string | undefined;
  let apolloReachable = false;

  try {
    const client = await clientFor(host);
    agent = await client.status();
    recordHeartbeat(host.id);
    wakingUntil = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  try {
    apolloReachable = await probeApollo(address, apolloPort);
  } catch {
    apolloReachable = false;
  }

  const state = deriveState({
    agent,
    apolloReachable,
    lastHeartbeatAt: cfg.heartbeats[host.id] || lastHeartbeatAt,
    wakingUntil,
  });

  return {
    hostId: host.id,
    state,
    agent,
    apolloReachable,
    lastHeartbeatAt: cfg.heartbeats[host.id] || lastHeartbeatAt,
    lastError: agent ? undefined : lastError,
    wakingUntil,
  };
}
