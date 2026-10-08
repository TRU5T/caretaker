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
  /** Agent's self-signed TLS certificate (PEM), pinned at pairing */
  agentCertPem?: string;
  /** Lowercase hex SHA-256 of the pinned certificate */
  agentCertSha256?: string;
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
  /** SHA-256 of the pinned agent certificate; absent for legacy plain-HTTP agents */
  agentCertSha256?: string;
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
export const HUB_VERSION = "0.2.0";
export const AGENT_VERSION = "0.2.0";
