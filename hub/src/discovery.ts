import dgram from "node:dgram";
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { hostAddressFromAgentUrl, loadConfig, normalizeMac, saveConfig } from "./config.js";
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
      };
      if (data.service !== "caretaker-agent") return;
      const port = Number(data.port || 7842);
      const hostname = String(data.hostname || rinfo.address);
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
      const agentUrls = addresses.map((ip) => `http://${ip}:${port}`);
      const existing = discovered.get(key);
      discovered.set(key, {
        id: existing?.id || uuidv4(),
        hostname,
        version: String(data.version || ""),
        paired: Boolean(data.paired),
        port,
        macs,
        preferredMac,
        addresses,
        agentUrls,
        lastSeenAt: new Date().toISOString(),
        fromAddress: rinfo.address,
      });
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
  name?: string;
  mac?: string;
  hubPublicUrl: string;
}): Promise<{ host: HostConfig }> {
  const agentUrl = opts.agentUrl.replace(/\/$/, "");
  // Refresh discovery info from agent
  const discoverRes = await fetch(`${agentUrl}/discover`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!discoverRes.ok) {
    throw new Error(`agent discover failed: ${discoverRes.status}`);
  }
  const info = (await discoverRes.json()) as {
    paired?: boolean;
    hostname?: string;
    preferredMac?: string;
    macs?: string[];
  };
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

  const token = crypto.randomBytes(24).toString("hex");
  const now = new Date().toISOString();
  const name = (opts.name || info.hostname || "Gaming PC").trim();

  let host: HostConfig;
  if (existing) {
    existing.name = name;
    existing.agentUrl = agentUrl;
    existing.hostAddress = hostAddressFromAgentUrl(agentUrl);
    existing.agentToken = token;
    existing.paired = true;
    existing.updatedAt = now;
    host = existing;
  } else {
    host = {
      id: uuidv4(),
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
    cfg.hosts.push(host);
  }
  saveConfig(cfg);

  const pairRes = await fetch(`${agentUrl}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({
      hostId: host.id,
      token,
      hubUrl: opts.hubPublicUrl.replace(/\/$/, ""),
      name: host.name,
      mac: host.mac,
    }),
  });
  if (!pairRes.ok) {
    // Roll back paired flag if agent rejected
    host.paired = false;
    host.agentToken = "";
    saveConfig(cfg);
    const text = await pairRes.text().catch(() => "");
    throw new Error(`agent pair failed: ${pairRes.status} ${text}`);
  }

  return { host };
}
