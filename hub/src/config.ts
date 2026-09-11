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
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath();
  if (!fs.existsSync(file)) {
    const password = process.env.CARETAKER_UI_PASSWORD || "changeme";
    const cfg: HubConfig = {
      uiPasswordHash: hashPassword(password),
      sessionSecret: process.env.CARETAKER_SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
      hosts: [],
      heartbeats: {},
      wakingUntil: {},
      pairings: [],
    };
    saveConfig(cfg);
    return cfg;
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as HubConfig;
  raw.hosts ||= [];
  raw.heartbeats ||= {};
  raw.wakingUntil ||= {};
  raw.pairings ||= [];
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
      saveConfig(raw);
    }
  }
  return raw;
}

export function saveConfig(cfg: HubConfig): void {
  const file = configPath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
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
