import { Router } from "express";
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import {
  changePasswordHandler,
  loginHandler,
  logoutHandler,
  meHandler,
  requireAuth,
} from "./auth.js";
import {
  hostAddressFromAgentUrl,
  loadConfig,
  normalizeMac,
  saveConfig,
} from "./config.js";
import { AgentClient } from "./agentClient.js";
import { wakeHost } from "./wol.js";
import { clearWaking, getLiveStatus, markWaking, recordHeartbeat } from "./status.js";
import { listDiscovered, pairDiscovered } from "./discovery.js";
import type { HostConfig, HostPublic } from "./types.js";
import { HUB_VERSION } from "./types.js";

export const api = Router();

function toPublic(h: HostConfig): HostPublic {
  return {
    id: h.id,
    name: h.name,
    mac: h.mac,
    agentUrl: h.agentUrl,
    broadcastAddress: h.broadcastAddress || "255.255.255.255",
    apolloPort: h.apolloPort ?? 47990,
    hostAddress: h.hostAddress || hostAddressFromAgentUrl(h.agentUrl),
    hasAgentToken: Boolean(h.agentToken),
    paired: Boolean(h.paired),
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

function createPairingForHost(cfg: ReturnType<typeof loadConfig>, hostId: string) {
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  cfg.pairings = cfg.pairings.filter(
    (p) => p.hostId !== hostId && Date.parse(p.expiresAt) > Date.now() && !p.claimed
  );
  cfg.pairings.push({ code, token, expiresAt, hostId });
  return { pairingCode: code, expiresAt, agentToken: token };
}

function findHost(id: string): HostConfig | undefined {
  return loadConfig().hosts.find((h) => h.id === id);
}

api.get("/health", (_req, res) => {
  res.json({ ok: true, version: HUB_VERSION, service: "caretaker-hub" });
});

api.get("/me", meHandler);
api.post("/login", loginHandler);
api.post("/logout", logoutHandler);

api.post("/password", requireAuth, changePasswordHandler);

api.get("/hosts", requireAuth, (_req, res) => {
  res.json({ hosts: loadConfig().hosts.map(toPublic) });
});

api.post("/hosts", requireAuth, (req, res) => {
  const cfg = loadConfig();
  try {
    const name = String(req.body?.name || "Gaming PC").trim();
    const mac = normalizeMac(String(req.body?.mac || ""));
    const now = new Date().toISOString();
    const host: HostConfig = {
      id: uuidv4(),
      name,
      mac,
      // Filled in when the agent claims the pairing code
      agentUrl: "",
      broadcastAddress: String(req.body?.broadcastAddress || "255.255.255.255"),
      apolloPort: Number(req.body?.apolloPort || 47990),
      hostAddress: String(req.body?.hostAddress || ""),
      agentToken: "",
      paired: false,
      createdAt: now,
      updatedAt: now,
    };
    const pairing = createPairingForHost(cfg, host.id);
    host.agentToken = pairing.agentToken;
    cfg.hosts.push(host);
    saveConfig(cfg);
    res.status(201).json({
      host: toPublic(host),
      pairingCode: pairing.pairingCode,
      expiresAt: pairing.expiresAt,
      pairCommand: `caretaker-agent pair --hub <HUB_URL> --code ${pairing.pairingCode} --agent-url http://<THIS_PC_IP>:7842`,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Re-issue a pairing code for an existing (or unpaired) host */
api.post("/hosts/:id/pair", requireAuth, (req, res) => {
  const cfg = loadConfig();
  const host = cfg.hosts.find((h) => h.id === req.params.id);
  if (!host) {
    res.status(404).json({ error: "host not found" });
    return;
  }
  const pairing = createPairingForHost(cfg, host.id);
  host.agentToken = pairing.agentToken;
  host.paired = false;
  host.updatedAt = new Date().toISOString();
  saveConfig(cfg);
  res.json({
    host: toPublic(host),
    pairingCode: pairing.pairingCode,
    expiresAt: pairing.expiresAt,
    pairCommand: `caretaker-agent pair --hub <HUB_URL> --code ${pairing.pairingCode} --agent-url http://<THIS_PC_IP>:7842`,
  });
});

api.put("/hosts/:id", requireAuth, (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.hosts.findIndex((h) => h.id === req.params.id);
  if (idx < 0) {
    res.status(404).json({ error: "host not found" });
    return;
  }
  try {
    const current = cfg.hosts[idx];
    const next: HostConfig = {
      ...current,
      name: req.body?.name != null ? String(req.body.name).trim() : current.name,
      mac: req.body?.mac != null ? normalizeMac(String(req.body.mac)) : current.mac,
      agentUrl:
        req.body?.agentUrl != null
          ? String(req.body.agentUrl).replace(/\/$/, "")
          : current.agentUrl,
      broadcastAddress:
        req.body?.broadcastAddress != null
          ? String(req.body.broadcastAddress)
          : current.broadcastAddress,
      apolloPort:
        req.body?.apolloPort != null ? Number(req.body.apolloPort) : current.apolloPort,
      hostAddress:
        req.body?.hostAddress != null
          ? String(req.body.hostAddress)
          : current.hostAddress || hostAddressFromAgentUrl(current.agentUrl),
      agentToken:
        req.body?.agentToken != null && String(req.body.agentToken).trim()
          ? String(req.body.agentToken).trim()
          : current.agentToken,
      updatedAt: new Date().toISOString(),
    };
    cfg.hosts[idx] = next;
    saveConfig(cfg);
    res.json({ host: toPublic(next) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

api.delete("/hosts/:id", requireAuth, (req, res) => {
  const cfg = loadConfig();
  const before = cfg.hosts.length;
  cfg.hosts = cfg.hosts.filter((h) => h.id !== req.params.id);
  delete cfg.heartbeats[req.params.id];
  delete cfg.wakingUntil[req.params.id];
  if (cfg.hosts.length === before) {
    res.status(404).json({ error: "host not found" });
    return;
  }
  saveConfig(cfg);
  res.json({ ok: true });
});

api.get("/hosts/:id/status", requireAuth, async (req, res) => {
  const host = findHost(req.params.id);
  if (!host) {
    res.status(404).json({ error: "host not found" });
    return;
  }
  const status = await getLiveStatus(host);
  res.json({ status });
});

api.post("/hosts/:id/wake", requireAuth, async (req, res) => {
  const host = findHost(req.params.id);
  if (!host) {
    res.status(404).json({ error: "host not found" });
    return;
  }
  try {
    await wakeHost(host.mac, host.broadcastAddress || "255.255.255.255");
    markWaking(host.id);
    res.json({ ok: true, message: "magic packet sent" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

api.post("/hosts/:id/sleep", requireAuth, async (req, res) => {
  const host = findHost(req.params.id);
  if (!host) {
    res.status(404).json({ error: "host not found" });
    return;
  }
  const mode = req.body?.mode === "hibernate" ? "hibernate" : "sleep";
  try {
    const client = new AgentClient(host.agentUrl, host.agentToken);
    await client.sleep(mode);
    clearWaking(host.id);
    res.json({ ok: true, mode });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

api.post("/hosts/:id/unlock", requireAuth, async (req, res) => {
  const host = findHost(req.params.id);
  if (!host) {
    res.status(404).json({ error: "host not found" });
    return;
  }
  const secret = String(req.body?.secret || "");
  const kind = req.body?.kind === "password" ? "password" : "pin";
  if (!secret) {
    res.status(400).json({ error: "secret required" });
    return;
  }
  try {
    const client = new AgentClient(host.agentUrl, host.agentToken);
    const started = Date.now();
    const result = await client.unlock(secret, kind);
    console.log(
      `unlock host=${host.id} kind=${kind} ok=${result.ok} locked=${result.locked} ms=${Date.now() - started} msg=${result.message}`
    );
    res.json({ result });
  } catch (err) {
    console.log(
      `unlock host=${host.id} kind=${kind} FAILED ${err instanceof Error ? err.message : String(err)}`
    );
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

api.post("/hosts/:id/prepare", requireAuth, async (req, res) => {
  const host = findHost(req.params.id);
  if (!host) {
    res.status(404).json({ error: "host not found" });
    return;
  }
  try {
    const client = new AgentClient(host.agentUrl, host.agentToken);
    const started = Date.now();
    const result = await client.prepare();
    console.log(`prepare host=${host.id} ok ms=${Date.now() - started} msg=${result.message || ""}`);
    res.json({ result });
  } catch (err) {
    console.log(
      `prepare host=${host.id} FAILED ${err instanceof Error ? err.message : String(err)}`
    );
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Agent → hub heartbeat (authenticated with host agent token) */
api.post("/heartbeat", (req, res) => {
  const hostId = String(req.body?.hostId || "");
  const token = String(req.body?.token || req.headers.authorization?.replace(/^Bearer\s+/i, "") || "");
  const host = findHost(hostId);
  if (!host || !token || token !== host.agentToken) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  recordHeartbeat(hostId);
  res.json({ ok: true });
});

/** Agent claims a pairing code for a host that was already added in the hub */
api.post("/pair/complete", (req, res) => {
  const cfg = loadConfig();
  const code = String(req.body?.pairingCode || "").toUpperCase();
  const agentUrl = String(req.body?.agentUrl || "").replace(/\/$/, "");
  if (!code || !agentUrl) {
    res.status(400).json({ error: "pairingCode and agentUrl required" });
    return;
  }
  const pairing = cfg.pairings.find(
    (p) => p.code === code && !p.claimed && Date.parse(p.expiresAt) > Date.now()
  );
  if (!pairing?.hostId) {
    res.status(400).json({ error: "invalid or expired pairing code" });
    return;
  }
  const host = cfg.hosts.find((h) => h.id === pairing.hostId);
  if (!host) {
    res.status(400).json({ error: "pairing host no longer exists — add the PC in the hub again" });
    return;
  }

  if (req.body?.mac) {
    try {
      const mac = normalizeMac(String(req.body.mac));
      if (host.mac && host.mac !== mac) {
        res.status(400).json({
          error: `MAC mismatch: hub has ${host.mac}, agent sent ${mac}`,
        });
        return;
      }
      host.mac = mac;
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }

  pairing.claimed = true;
  host.agentUrl = agentUrl;
  host.hostAddress = hostAddressFromAgentUrl(agentUrl);
  host.agentToken = pairing.token;
  host.paired = true;
  if (req.body?.name) host.name = String(req.body.name).trim();
  host.updatedAt = new Date().toISOString();
  saveConfig(cfg);
  res.json({
    ok: true,
    hostId: host.id,
    agentToken: pairing.token,
    mac: host.mac,
    name: host.name,
  });
});

/** Nearby unpaired agents (UDP beacon + last-seen cache) */
api.get("/discovered", requireAuth, (_req, res) => {
  const cfg = loadConfig();
  const pairedMacs = new Set(cfg.hosts.filter((h) => h.paired).map((h) => h.mac));
  const agents = listDiscovered().filter((a) => {
    if (a.paired) return false;
    if (a.preferredMac && pairedMacs.has(a.preferredMac)) return false;
    return true;
  });
  res.json({ agents });
});

/** One-click pair: hub creates host and pushes credentials to the agent */
api.post("/discovered/pair", requireAuth, async (req, res) => {
  try {
    const agentUrl = String(req.body?.agentUrl || "").replace(/\/$/, "");
    if (!agentUrl) {
      res.status(400).json({ error: "agentUrl required" });
      return;
    }
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol);
    const hostHdr = String(req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${listenPortHint()}`);
    const hubPublicUrl =
      process.env.CARETAKER_PUBLIC_URL || `${proto}://${hostHdr}`;

    const { host } = await pairDiscovered({
      agentUrl,
      name: req.body?.name ? String(req.body.name) : undefined,
      mac: req.body?.mac ? String(req.body.mac) : undefined,
      hubPublicUrl,
    });
    res.status(201).json({ host: toPublic(host) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function listenPortHint(): number {
  const n = Number(process.env.CARETAKER_PORT || 8080);
  return Number.isFinite(n) && n > 0 ? n : 8080;
}
