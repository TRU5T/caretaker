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
  randomCode,
  saveConfig,
} from "./config.js";
import { clientFor, normalizeFingerprint } from "./agentClient.js";
import { clientKey, FailureLimiter } from "./rateLimit.js";
import { wakeHost } from "./wol.js";
import { clearWaking, getLiveStatus, markWaking, recordHeartbeat } from "./status.js";
import { listDiscovered, pairDiscovered } from "./discovery.js";
import { agentWindowsDownloadHandler, agentWindowsInfoHandler } from "./agentDownload.js";
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
    agentCertSha256: h.agentCertSha256,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

/** Unauthenticated agent-facing endpoints: 5 free failures per IP, then backoff; 30/10 min overall. */
const agentEndpointLimiter = new FailureLimiter({
  freeFailures: 5,
  baseLockMs: 30_000,
  maxLockMs: 15 * 60_000,
  resetAfterMs: 60 * 60_000,
  globalMax: 30,
  globalWindowMs: 10 * 60_000,
});

const PAIRING_CODE_LENGTH = 10; // 50 bits from a 32-symbol alphabet

/** Strip separators/whitespace so "ABCDE-FGHJK" and "abcdefghjk" both match. */
function normalizeCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function formatCode(code: string): string {
  return code.length === PAIRING_CODE_LENGTH ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

function parseAgentUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, "");
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error("agentUrl must be a full URL, e.g. https://192.168.1.50:7842");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("agentUrl must use https://");
  }
  if (u.username || u.password || (u.pathname && u.pathname !== "/") || u.search || u.hash) {
    throw new Error("agentUrl must be scheme://host:port only");
  }
  return `${u.protocol}//${u.host}`;
}

function pairCommand(code: string): string {
  return `caretaker-agent pair --hub <HUB_URL> --code ${formatCode(code)} --agent-url https://<THIS_PC_IP>:7842`;
}

function createPairingForHost(cfg: ReturnType<typeof loadConfig>, hostId: string) {
  const code = randomCode(PAIRING_CODE_LENGTH);
  const token = crypto.randomBytes(32).toString("hex");
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

api.get("/agent/windows/info", requireAuth, agentWindowsInfoHandler);
api.get("/agent/windows", requireAuth, agentWindowsDownloadHandler);

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
      pairingCode: formatCode(pairing.pairingCode),
      expiresAt: pairing.expiresAt,
      pairCommand: pairCommand(pairing.pairingCode),
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
    pairingCode: formatCode(pairing.pairingCode),
    expiresAt: pairing.expiresAt,
    pairCommand: pairCommand(pairing.pairingCode),
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
    let agentUrl = current.agentUrl;
    if (req.body?.agentUrl != null) {
      agentUrl = parseAgentUrl(String(req.body.agentUrl));
      // Never let an edit downgrade a pinned agent to plain HTTP (the token would leak)
      if (current.agentCertSha256 && !agentUrl.startsWith("https://")) {
        throw new Error("this agent uses a pinned TLS certificate — agentUrl must be https://");
      }
    }
    const next: HostConfig = {
      ...current,
      name: req.body?.name != null ? String(req.body.name).trim() : current.name,
      mac: req.body?.mac != null ? normalizeMac(String(req.body.mac)) : current.mac,
      agentUrl,
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

/** Unpair: tell the agent to forget its token (best effort), then forget the host. */
api.delete("/hosts/:id", requireAuth, async (req, res) => {
  const host = findHost(req.params.id);
  if (!host) {
    res.status(404).json({ error: "host not found" });
    return;
  }
  let agentUnpaired = false;
  let agentError: string | undefined;
  if (host.paired && host.agentUrl && host.agentToken) {
    try {
      await (await clientFor(host)).unpair();
      agentUnpaired = true;
    } catch (err) {
      agentError = err instanceof Error ? err.message : String(err);
    }
  }
  const cfg = loadConfig();
  cfg.hosts = cfg.hosts.filter((h) => h.id !== host.id);
  cfg.pairings = cfg.pairings.filter((p) => p.hostId !== host.id);
  delete cfg.heartbeats[host.id];
  delete cfg.wakingUntil[host.id];
  saveConfig(cfg);
  res.json({
    ok: true,
    agentUnpaired,
    warning: agentError
      ? `Removed from the hub, but the PC could not be reached to unpair (${agentError}). ` +
        "Its old token stops working only once the agent is unpaired: run `caretaker-agent unpair` on the PC as administrator."
      : undefined,
  });
});

/** Replace the hub↔agent bearer token (e.g. after a suspected leak). */
api.post("/hosts/:id/rotate-token", requireAuth, async (req, res) => {
  const host = findHost(req.params.id);
  if (!host) {
    res.status(404).json({ error: "host not found" });
    return;
  }
  if (!host.paired) {
    res.status(400).json({ error: "host is not paired" });
    return;
  }
  const newToken = crypto.randomBytes(32).toString("hex");
  try {
    await (await clientFor(host)).rotateToken(newToken);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const cfg = loadConfig();
  const stored = cfg.hosts.find((h) => h.id === host.id);
  if (stored) {
    stored.agentToken = newToken;
    stored.updatedAt = new Date().toISOString();
    saveConfig(cfg);
  }
  console.log(`rotate-token host=${host.id} ok`);
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
    const client = await clientFor(host);
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
    const client = await clientFor(host);
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
    const client = await clientFor(host);
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

const HEARTBEAT_MAX_SKEW_MS = 5 * 60_000;

/**
 * Agent → hub heartbeat. The hub usually runs plain HTTP, so current agents
 * never send the token itself: they send HMAC(token, "heartbeat\n<hostId>\n<ts>").
 * Agents from before 0.2 sent the raw token; that is still accepted.
 */
api.post("/heartbeat", (req, res) => {
  const hostId = String(req.body?.hostId || "");
  const host = findHost(hostId);
  const deny = () => res.status(401).json({ error: "unauthorized" });
  if (!host || !host.agentToken) {
    deny();
    return;
  }
  const sig = String(req.body?.sig || "");
  if (sig) {
    const ts = Number(req.body?.ts);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > HEARTBEAT_MAX_SKEW_MS) {
      deny();
      return;
    }
    const expected = crypto
      .createHmac("sha256", host.agentToken)
      .update(`heartbeat\n${hostId}\n${ts}`)
      .digest("hex");
    if (!safeEqual(sig, expected)) {
      deny();
      return;
    }
  } else {
    const token = String(req.body?.token || req.headers.authorization?.replace(/^Bearer\s+/i, "") || "");
    if (!token || !safeEqual(token, host.agentToken)) {
      deny();
      return;
    }
  }
  recordHeartbeat(hostId);
  res.json({ ok: true });
});

/** Agent claims a pairing code for a host that was already added in the hub */
api.post("/pair/complete", (req, res) => {
  const key = clientKey(req);
  const wait = agentEndpointLimiter.retryAfterMs(key);
  if (wait > 0) {
    res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
    res.status(429).json({ error: "too many pairing attempts — wait and try again" });
    return;
  }
  const cfg = loadConfig();
  const code = normalizeCode(String(req.body?.pairingCode || ""));
  let agentUrl: string;
  try {
    agentUrl = parseAgentUrl(String(req.body?.agentUrl || ""));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!code) {
    res.status(400).json({ error: "pairingCode and agentUrl required" });
    return;
  }
  const pairing = cfg.pairings.find(
    (p) => safeEqual(p.code, code) && !p.claimed && Date.parse(p.expiresAt) > Date.now()
  );
  if (!pairing?.hostId) {
    agentEndpointLimiter.fail(key);
    console.log(`pair/complete: bad or expired code from ${key}`);
    res.status(400).json({ error: "invalid or expired pairing code" });
    return;
  }
  agentEndpointLimiter.succeed(key);

  // Agents ≥0.2 send their TLS certificate so the hub can pin it.
  const certPem = req.body?.certPem ? String(req.body.certPem) : "";
  let certSha256 = "";
  if (certPem) {
    try {
      certSha256 = new crypto.X509Certificate(certPem).fingerprint256;
      certSha256 = normalizeFingerprint(certSha256);
    } catch {
      res.status(400).json({ error: "certPem is not a valid certificate" });
      return;
    }
    agentUrl = agentUrl.replace(/^http:/, "https:");
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
  host.agentCertPem = certPem || undefined;
  host.agentCertSha256 = certSha256 || undefined;
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
    const agentUrl = parseAgentUrl(String(req.body?.agentUrl || ""));
    const pairCode = normalizeCode(String(req.body?.pairCode || ""));
    if (!pairCode) {
      res.status(400).json({ error: "enter the pairing code shown on the PC" });
      return;
    }
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol);
    const hostHdr = String(req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${listenPortHint()}`);
    const hubPublicUrl =
      process.env.CARETAKER_PUBLIC_URL || `${proto}://${hostHdr}`;

    const { host } = await pairDiscovered({
      agentUrl,
      pairCode,
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
