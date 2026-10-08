import dgram from "node:dgram";
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { hostAddressFromAgentUrl, loadConfig, normalizeMac, saveConfig } from "./config.js";
import { AgentClient, fetchAgentCertificate, pairProof } from "./agentClient.js";
import type { HostConfig } from "./types.js";

export const BEACON_PORT = 7843;

export interface DiscoveredAgent {
  id: string;
  hostname: string;
  version: string;
  paired: boolean;
  port: number;
  macs: string[];
  preferredMac: string;
  /** Agent ≥0.2 serves HTTPS; older agents plain HTTP */
  tls: boolean;
  addresses: addressesSeen;
  agentUrls: string[];
  lastSeenAt: string;
  fromAddress: string;
}

type addressesSeen = string[];

const discovered = new Map<string, DiscoveredAgent>();
let socket: dgram.Socket | null = null;

function agentKey(from: string, port: number, hostname: string): string {
  return `${from}:${port}:${hostname}`;
}

export function listDiscovered(maxAgeMs = 20_000): DiscoveredAgent[] {
  const now = Date.now();
  const out: DiscoveredAgent[] = [];
  for (const [key, agent] of discovered) {
    if (now - Date.parse(agent.lastSeenAt) > maxAgeMs) {
      discovered.delete(key);
      continue;
    }
    // Hide already-paired agents that are already hosts in hub
    out.push(agent);
  }
  return out.sort((a, b) => a.hostname.localeCompare(b.hostname));
}

export function startDiscoveryListener(): void {
  if (socket) return;
  socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  socket.on("error", (err) => {
    console.error("discovery listener error:", err.message);
  });
  socket.on("message", (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString("utf8")) as {
        service?: string;
        version?: string;
        hostname?: string;
        paired?: boolean;
        port?: number;
        macs?: string[];
        addresses?: string[];
        preferredMac?: string;
        tls?: boolean;
      };
      if (data.service !== "caretaker-agent") return;
      const port = Number(data.port || 7842);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return;
      // Beacons are unauthenticated LAN input: cap sizes, keep only plausible IPv4s
      const hostname = String(data.hostname || rinfo.address).slice(0, 64);
      data.addresses = (Array.isArray(data.addresses) ? data.addresses : [])
        .map(String)
        .filter((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a))
        .slice(0, 8);
      data.macs = (Array.isArray(data.macs) ? data.macs : []).map(String).slice(0, 8);
      const key = agentKey(rinfo.address, port, hostname);
      const addresses = Array.from(
        new Set([rinfo.address, ...(data.addresses || [])].filter(Boolean))
      );
      const macs = (data.macs || []).map((m) => {
        try {
          return normalizeMac(m);
        } catch {
          return m;
        }
      });
      const preferredMac = data.preferredMac
        ? (() => {
            try {
              return normalizeMac(data.preferredMac);
            } catch {
              return macs[0] || "";
            }
          })()
        : macs[0] || "";
      const tlsAgent = Boolean(data.tls);
      const scheme = tlsAgent ? "https" : "http";
      // Prefer the address the beacon actually came from
      const agentUrls = addresses.map((ip) => `${scheme}://${ip}:${port}`);
      const existing = discovered.get(key);
      discovered.set(key, {
        id: existing?.id || uuidv4(),
        hostname,
        version: String(data.version || ""),
        paired: Boolean(data.paired),
        port,
        macs,
        preferredMac,
        tls: tlsAgent,
        addresses,
        agentUrls,
        lastSeenAt: new Date().toISOString(),
        fromAddress: rinfo.address,
      });
      if (discovered.size > 256) {
        const oldest = discovered.keys().next().value;
        if (oldest) discovered.delete(oldest);
      }
    } catch {
      /* ignore malformed */
    }
  });
  socket.bind(BEACON_PORT, () => {
    try {
      socket?.setBroadcast(true);
    } catch {
      /* ignore */
    }
    console.log(`discovery listening for agent beacons on UDP :${BEACON_PORT}`);
  });
}

export async function pairDiscovered(opts: {
  agentUrl: string;
  /** Code the agent shows on the PC (installer dialog / agent.log) */
  pairCode: string;
  name?: string;
  mac?: string;
  hubPublicUrl: string;
}): Promise<{ host: HostConfig }> {
  // Agents ≥0.2 only speak TLS. Old beacons advertised http:// on the same port.
  const agentUrl = opts.agentUrl.replace(/\/$/, "").replace(/^http:/, "https:");

  let pin;
  try {
    pin = await fetchAgentCertificate(agentUrl);
  } catch (err) {
    throw new Error(
      `could not open a TLS connection to the agent (${err instanceof Error ? err.message : String(err)}). ` +
        "Update the agent with the installer from this Hub."
    );
  }
  const client = new AgentClient(agentUrl, "", pin);

  const info = await client.request<{
    paired?: boolean;
    hostname?: string;
    preferredMac?: string;
    macs?: string[];
  }>("/discover", { token: null });
  if (info.paired) {
    throw new Error("agent reports it is already paired");
  }

  let mac = opts.mac || info.preferredMac || info.macs?.[0] || "";
  if (!mac) {
    throw new Error("could not determine MAC — enter it manually");
  }
  mac = normalizeMac(mac);

  const cfg = loadConfig();
  const existing = cfg.hosts.find((h) => h.mac === mac);
  if (existing?.paired) {
    throw new Error(`a paired host with MAC ${mac} already exists (${existing.name})`);
  }

  const token = crypto.randomBytes(32).toString("hex");
  const hostId = existing?.id || uuidv4();
  const name = (opts.name || info.hostname || "Gaming PC").trim().slice(0, 64);

  // Ask the agent first; only record the host once the agent accepted the code.
  await client.request("/pair", {
    method: "POST",
    token: null,
    timeoutMs: 8000,
    body: {
      hostId,
      token,
      hubUrl: opts.hubPublicUrl.replace(/\/$/, ""),
      name,
      mac,
      proof: pairProof(opts.pairCode, pin.certSha256),
    },
  });

  const now = new Date().toISOString();
  const fresh = loadConfig();
  let host = fresh.hosts.find((h) => h.id === hostId);
  if (!host) {
    host = {
      id: hostId,
      name,
      mac,
      agentUrl,
      broadcastAddress: "255.255.255.255",
      apolloPort: 47990,
      hostAddress: hostAddressFromAgentUrl(agentUrl),
      agentToken: token,
      paired: true,
      createdAt: now,
      updatedAt: now,
    };
    fresh.hosts.push(host);
  }
  host.name = name;
  host.agentUrl = agentUrl;
  host.hostAddress = hostAddressFromAgentUrl(agentUrl);
  host.agentToken = token;
  host.agentCertPem = pin.certPem;
  host.agentCertSha256 = pin.certSha256;
  host.paired = true;
  host.updatedAt = now;
  saveConfig(fresh);

  return { host };
}
