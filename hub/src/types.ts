/** Local copies of shared contract types (kept in sync with ../../shared/api.ts) */

export type HostSessionState = "offline" | "waking" | "locked" | "unlocked" | "ready" | "unknown";

export interface AgentStatus {
  online: true;
  locked: boolean;
  sessionState: "locked" | "unlocked" | "unknown";
  hostname: string;
  username?: string;
  uptimeSec: number;
  agentVersion: string;
  unlockAttemptsRemaining: number;
}

export interface UnlockResponse {
  ok: boolean;
  locked: boolean;
  message: string;
  attemptsRemaining: number;
}

export interface HostConfig {
  id: string;
  name: string;
  mac: string;
  agentUrl: string;
  broadcastAddress?: string;
  apolloPort?: number;
  hostAddress?: string;
  agentToken: string;
  /** False until the Windows agent claims the pairing code */
  paired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HostPublic {
  id: string;
  name: string;
  mac: string;
  agentUrl: string;
  broadcastAddress: string;
  apolloPort: number;
  hostAddress: string;
  hasAgentToken: boolean;
  paired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HostLiveStatus {
  hostId: string;
  state: HostSessionState;
  agent?: AgentStatus;
  apolloReachable: boolean;
  lastHeartbeatAt: string | null;
  lastError?: string;
  wakingUntil?: string | null;
}

export const AGENT_DEFAULT_PORT = 7842;
export const HUB_VERSION = "0.1.0";
export const AGENT_VERSION = "0.1.0";
