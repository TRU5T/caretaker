import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { PeerCertificate } from "node:tls";
import { loadConfig, saveConfig } from "./config.js";
import type { AgentStatus, HostConfig, UnlockResponse } from "./types.js";

const DEFAULT_TIMEOUT_MS = 4000;

/** The agent's self-signed certificate, captured when it was paired. */
export interface AgentPin {
  certPem: string;
  /** Lowercase hex SHA-256 of the certificate DER, no separators */
  certSha256: string;
}

export function normalizeFingerprint(fp: string): string {
  return fp.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
}

function toPem(der: Buffer): string {
  const b64 = der.toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/**
 * Read the certificate an agent presents, without sending anything over the
 * connection. Used once at pairing (trust on first use, then confirmed by the
 * pairing-code proof) and to upgrade hosts paired before TLS existed.
 */
export function fetchAgentCertificate(agentUrl: string, timeoutMs = 4000): Promise<AgentPin> {
  const u = new URL(agentUrl);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: u.hostname,
      port: Number(u.port || 443),
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TLS connect to ${u.host} timed out`));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate(true) as PeerCertificate;
      socket.end();
      if (!cert?.raw) {
        reject(new Error("agent presented no certificate"));
        return;
      }
      resolve({
        certPem: toPem(cert.raw),
        certSha256: crypto.createHash("sha256").update(cert.raw).digest("hex"),
      });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Proof sent with /pair: shows the agent that the hub knows the code shown on
 * the PC *and* is talking to the agent's real certificate. A machine in the
 * middle presents a different certificate, so its proof would not verify.
 */
export function pairProof(pairCode: string, certSha256: string): string {
  const code = pairCode.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return crypto.createHmac("sha256", code).update(`caretaker-pair-v1\n${certSha256}`).digest("hex");
}

interface RequestOpts {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  /** Override the bearer token (pairing uses none) */
  token?: string | null;
}

export class AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly pin?: AgentPin
  ) {}

  async request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}${path}`);
    const body = opts.body != null ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = {};
    const token = opts.token === undefined ? this.token : opts.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let transport: typeof http | typeof https;
    let tlsOpts: https.RequestOptions = {};
    if (url.protocol === "https:") {
      const pin = this.pin;
      if (!pin?.certPem || !pin.certSha256) {
        throw new Error("agent certificate is not pinned — pair the PC again");
      }
      transport = https;
      tlsOpts = {
        // Trust exactly the certificate captured at pairing, nothing else
        ca: pin.certPem,
        rejectUnauthorized: true,
        // The agent's cert is not issued for an IP/hostname; the pin is the identity
        checkServerIdentity: (_host: string, cert: PeerCertificate) => {
          if (normalizeFingerprint(cert.fingerprint256 || "") !== pin.certSha256) {
            return new Error("agent certificate does not match the one pinned at pairing");
          }
          return undefined;
        },
      };
    } else if (url.protocol === "http:") {
      transport = http;
    } else {
      throw new Error(`unsupported agent URL scheme ${url.protocol}`);
    }

    return new Promise<T>((resolve, reject) => {
      const req = transport.request(
        url,
        {
          method: opts.method || "GET",
          headers,
          agent: false,
          timeout: timeoutMs,
          ...tlsOpts,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > 256 * 1024) {
              req.destroy(new Error("agent response too large"));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) {
              reject(new Error(`agent ${path} → ${status}: ${text.trim() || res.statusMessage}`));
              return;
            }
            if (status === 204 || !text) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              reject(new Error(`agent ${path} returned invalid JSON`));
            }
          });
          res.on("error", reject);
        }
      );
      req.on("timeout", () => req.destroy(new Error(`agent ${path} timed out`)));
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  health(): Promise<{ ok: true; version: string }> {
    return this.request("/health", { timeoutMs: 2500 });
  }

  status(): Promise<AgentStatus> {
    return this.request("/status", { timeoutMs: 2500 });
  }

  sleep(mode: "sleep" | "hibernate" = "sleep"): Promise<{ ok: true }> {
    return this.request("/sleep", { method: "POST", body: { mode }, timeoutMs: 8000 });
  }

  unlock(secret: string, kind: "pin" | "password" = "pin"): Promise<UnlockResponse> {
    return this.request("/unlock", { method: "POST", body: { secret, kind }, timeoutMs: 45000 });
  }

  prepare(): Promise<{ ok: true; message?: string }> {
    return this.request("/prepare", { method: "POST", body: {}, timeoutMs: 30000 });
  }

  rotateToken(newToken: string): Promise<{ ok: true }> {
    return this.request("/rotate", { method: "POST", body: { token: newToken }, timeoutMs: 8000 });
  }

  unpair(): Promise<{ ok: true }> {
    return this.request("/unpair", { method: "POST", body: {}, timeoutMs: 8000 });
  }
}

export function hostPin(host: HostConfig): AgentPin | undefined {
  return host.agentCertPem && host.agentCertSha256
    ? { certPem: host.agentCertPem, certSha256: host.agentCertSha256 }
    : undefined;
}

/**
 * Client for a stored host. Hosts paired before the agent spoke TLS still have
 * an http:// URL; the first time such an agent answers on TLS we pin its
 * certificate (trust on first use) and never fall back to plain HTTP again.
 */
export async function clientFor(host: HostConfig): Promise<AgentClient> {
  if (host.agentUrl.startsWith("http://") && !hostPin(host)) {
    const httpsUrl = host.agentUrl.replace(/^http:/, "https:");
    try {
      const pin = await fetchAgentCertificate(httpsUrl, 2500);
      const cfg = loadConfig();
      const stored = cfg.hosts.find((h) => h.id === host.id);
      if (stored && !hostPin(stored)) {
        stored.agentUrl = httpsUrl;
        stored.agentCertPem = pin.certPem;
        stored.agentCertSha256 = pin.certSha256;
        stored.updatedAt = new Date().toISOString();
        saveConfig(cfg);
        console.log(
          `host ${host.id}: agent now speaks TLS — pinned certificate sha256=${pin.certSha256} (trust on first use; re-pair for a verified pin)`
        );
        return new AgentClient(httpsUrl, stored.agentToken, pin);
      }
    } catch {
      /* older agent still on plain HTTP */
    }
  }
  return new AgentClient(host.agentUrl, host.agentToken, hostPin(host));
}

export async function probeApollo(hostAddress: string, port: number, timeoutMs = 2500): Promise<boolean> {
  if (!hostAddress || !port) return false;
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: hostAddress,
        port,
        path: "/",
        method: "GET",
        // Apollo uses a self-signed cert; this only checks reachability and sends nothing secret
        rejectUnauthorized: false,
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}
