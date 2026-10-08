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
  /** Agent's self-signed TLS certificate (PEM), pinned at pairing */
  agentCertPem?: string;
  /** Lowercase hex SHA-256 of the pinned certificate */
  agentCertSha256?: string;
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

export interface HeartbeatPayload {
  hostId: string;
  status: AgentStatus;
  /** Unix ms; must be within 5 minutes of the hub's clock */
  ts: number;
  /** hex(HMAC-SHA256(key=agentToken, "heartbeat\n" + hostId + "\n" + ts)) */
  sig: string;
}

/** Hub → agent POST /pair (agent must be unpaired) */
export interface AgentPairRequest {
  hostId: string;
  token: string;
  hubUrl: string;
  name?: string;
  mac?: string;
  /** hex(HMAC-SHA256(key=pairCode without separators, "caretaker-pair-v1\n" + certSha256)) */
  proof: string;
}

/** Hub → agent POST /rotate */
export interface AgentRotateRequest {
  /** New bearer token, at least 32 characters */
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
  /** Agent's TLS certificate (PEM) for the hub to pin */
  certPem?: string;
}

export const AGENT_DEFAULT_PORT = 7842;
export const AGENT_VERSION = "0.2.0";
export const HUB_VERSION = "0.2.0";
