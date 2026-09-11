/** Shared API contract between Caretaker Hub and Agent */

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

export interface AgentHealth {
  ok: true;
  version: string;
}

export interface SleepRequest {
  mode?: "sleep" | "hibernate";
}

export interface UnlockRequest {
  /** PIN digits or password — never logged by hub/agent */
  secret: string;
  kind?: "pin" | "password";
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
  /** Empty until the agent claims the pairing code */
  agentUrl: string;
  broadcastAddress?: string;
  apolloPort?: number;
  hostAddress?: string;
  agentToken: string;
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

export interface HeartbeatPayload {
  hostId: string;
  status: AgentStatus;
  token: string;
}

export interface PairingChallenge {
  pairingCode: string;
  expiresAt: string;
}

export interface PairCompleteRequest {
  pairingCode: string;
  agentUrl: string;
  mac: string;
  name?: string;
  hostname?: string;
}

export const AGENT_DEFAULT_PORT = 7842;
export const AGENT_VERSION = "0.1.0";
export const HUB_VERSION = "0.1.0";
