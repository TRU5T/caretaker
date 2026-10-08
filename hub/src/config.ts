import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { HostConfig } from "./types.js";

export interface HubConfig {
  uiPasswordHash: string;
  sessionSecret: string;
  hosts: HostConfig[];
  /** hostId -> ISO timestamp of last agent heartbeat */
  heartbeats: Record<string, string>;
  /** hostId -> ISO waking deadline */
  wakingUntil: Record<string, string>;
  /** Active pairing codes */
  pairings: PairingRecord[];
  /**
   * Mixed into every session signature. Rotating it (on password change)
   * invalidates all existing sessions.
   */
  sessionEpoch: string;
  /** True while the UI password is still the shipped default */
  mustChangePassword: boolean;
  /** Logged-out session ids → expiry (ms). Pruned once the cookie would have expired anyway. */
  revokedSessions: Record<string, number>;
}

export interface PairingRecord {
  code: string;
  token: string;
  expiresAt: string;
  /** Host this code belongs to (created in the hub first) */
  hostId: string;
  claimed?: boolean;
}

const DEFAULT_PORT = 8080;
const DEFAULT_PASSWORD = "changeme";
const MIN_SECRET_LENGTH = 32;

/** Placeholder secrets that have appeared in this repo's docs and examples. */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "dev-session-secret-change-me",
  "replace-with-openssl-rand-hex-32",
  "changeme",
  "change-me",
  "secret",
]);

/** Pairing-code alphabet: no 0/O/1/I/L to avoid misreads. 32 symbols = 5 bits each. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function randomCode(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const b of crypto.randomBytes(length)) {
      // Rejection sampling keeps the distribution uniform
      if (b < 256 - (256 % CODE_ALPHABET.length)) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function isDefaultPassword(password: string): boolean {
  return password === DEFAULT_PASSWORD;
}

/**
 * Use CARETAKER_SESSION_SECRET only if it is long and not a published
 * placeholder; otherwise fall back to a random secret persisted in config.
 * A guessable secret would let anyone forge a login cookie.
 */
function resolveSessionSecret(persisted: string | undefined): string {
  const env = process.env.CARETAKER_SESSION_SECRET?.trim();
  if (env) {
    if (KNOWN_PLACEHOLDER_SECRETS.has(env.toLowerCase())) {
      console.warn(
        "WARNING: CARETAKER_SESSION_SECRET is a published placeholder value and is being ignored. " +
          "Using a random secret stored in config.json instead."
      );
    } else if (env.length < MIN_SECRET_LENGTH) {
      console.warn(
        `WARNING: CARETAKER_SESSION_SECRET is shorter than ${MIN_SECRET_LENGTH} characters and is being ignored. ` +
          "Generate one with: openssl rand -hex 32"
      );
    } else {
      return env;
    }
  }
  if (persisted && persisted.length >= MIN_SECRET_LENGTH && !KNOWN_PLACEHOLDER_SECRETS.has(persisted.toLowerCase())) {
    return persisted;
  }
  return crypto.randomBytes(32).toString("hex");
}

export function dataDir(): string {
  return process.env.CARETAKER_DATA || path.resolve(process.cwd(), "../data");
}

export function configPath(): string {
  return path.join(dataDir(), "config.json");
}

export function hashPassword(password: string, salt?: string): string {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, s, 64).toString("hex");
  return `${s}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const next = crypto.scryptSync(password, salt, 64).toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(next, "hex"));
  } catch {
    return false;
  }
}

export function ensureConfig(): HubConfig {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configPath();
  if (!fs.existsSync(file)) {
    const password = process.env.CARETAKER_UI_PASSWORD || DEFAULT_PASSWORD;
    const cfg: HubConfig = {
      uiPasswordHash: hashPassword(password),
      sessionSecret: resolveSessionSecret(undefined),
      hosts: [],
      heartbeats: {},
      wakingUntil: {},
      pairings: [],
      sessionEpoch: crypto.randomBytes(16).toString("hex"),
      mustChangePassword: isDefaultPassword(password),
      revokedSessions: {},
    };
    saveConfig(cfg);
    return cfg;
  }
  const text = fs.readFileSync(file, "utf8");
  const raw = JSON.parse(text) as HubConfig;
  raw.hosts ||= [];
  raw.heartbeats ||= {};
  raw.wakingUntil ||= {};
  raw.pairings ||= [];
  raw.revokedSessions ||= {};
  raw.sessionEpoch ||= crypto.randomBytes(16).toString("hex");
  if (raw.mustChangePassword == null) {
    raw.mustChangePassword = verifyPassword(DEFAULT_PASSWORD, raw.uiPasswordHash);
  }
  const secret = resolveSessionSecret(raw.sessionSecret);
  if (secret !== raw.sessionSecret) {
    // Older installs may have persisted a placeholder; replacing it signs everyone out.
    raw.sessionSecret = secret;
  }
  // Migrate older host records
  for (const h of raw.hosts as Array<HostConfig & { paired?: boolean }>) {
    if (h.paired == null) {
      h.paired = Boolean(h.agentUrl && h.agentToken);
    }
  }
  if (process.env.CARETAKER_UI_PASSWORD) {
    // Allow resetting UI password from env on boot when CARETAKER_RESET_PASSWORD=1
    if (process.env.CARETAKER_RESET_PASSWORD === "1") {
      raw.uiPasswordHash = hashPassword(process.env.CARETAKER_UI_PASSWORD);
      raw.mustChangePassword = isDefaultPassword(process.env.CARETAKER_UI_PASSWORD);
      raw.sessionEpoch = crypto.randomBytes(16).toString("hex");
    }
  }
  // Persist migrations and tighten permissions left by older versions
  const looseMode = process.platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0;
  if (JSON.stringify(raw, null, 2) !== text || looseMode) {
    saveConfig(raw);
  }
  return raw;
}

export function saveConfig(cfg: HubConfig): void {
  const file = configPath();
  const tmp = `${file}.tmp`;
  // config.json holds agent bearer tokens and the session secret: owner-only
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function loadConfig(): HubConfig {
  return ensureConfig();
}

export function listenPort(): number {
  const n = Number(process.env.CARETAKER_PORT || DEFAULT_PORT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

export function normalizeMac(mac: string): string {
  const hex = mac.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  if (hex.length !== 12) {
    throw new Error("MAC address must be 12 hex digits");
  }
  return hex.match(/.{2}/g)!.join(":");
}

export function hostAddressFromAgentUrl(agentUrl: string): string {
  try {
    const u = new URL(agentUrl);
    return u.hostname;
  } catch {
    return "";
  }
}
