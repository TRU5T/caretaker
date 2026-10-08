import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import {
  hashPassword,
  isDefaultPassword,
  loadConfig,
  verifyPassword,
  saveConfig,
  type HubConfig,
} from "./config.js";
import { clientKey, FailureLimiter } from "./rateLimit.js";

const COOKIE = "caretaker_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const MIN_PASSWORD_LENGTH = 10;

interface Session {
  id: string;
  expiresAt: number;
}

/** 5 free tries per IP, then 30s, 60s, 120s… capped at 15 min; 50 failures/15 min overall. */
const loginLimiter = new FailureLimiter({
  freeFailures: 5,
  baseLockMs: 30_000,
  maxLockMs: 15 * 60_000,
  resetAfterMs: 60 * 60_000,
  globalMax: 50,
  globalWindowMs: 15 * 60_000,
});

/**
 * Cookie value: `<id>.<expiresAtMs>.<hmac>`. The HMAC covers the id, the
 * expiry, and the config's session epoch, so expiry cannot be extended and a
 * password change (which rotates the epoch) signs every session out.
 */
function sign(id: string, expiresAt: number, cfg: HubConfig): string {
  return crypto
    .createHmac("sha256", cfg.sessionSecret)
    .update(`${id}.${expiresAt}.${cfg.sessionEpoch}`)
    .digest("hex");
}

export function createSession(cfg: HubConfig): string {
  const id = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  return `${id}.${expiresAt}.${sign(id, expiresAt, cfg)}`;
}

function parseCookie(cookieValue: string | undefined): { id: string; expiresAt: number; sig: string } | null {
  if (!cookieValue) return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const expiresAt = Number(exp);
  if (!id || !sig || !Number.isSafeInteger(expiresAt)) return null;
  return { id, expiresAt, sig };
}

export function destroySession(cookieValue: string | undefined, cfg: HubConfig): void {
  const parsed = parseCookie(cookieValue);
  if (!parsed || !readSession(cookieValue, cfg)) return;
  const now = Date.now();
  for (const [id, exp] of Object.entries(cfg.revokedSessions)) {
    if (exp < now) delete cfg.revokedSessions[id];
  }
  cfg.revokedSessions[parsed.id] = parsed.expiresAt;
  saveConfig(cfg);
}

export function readSession(cookieValue: string | undefined, cfg: HubConfig): Session | null {
  const parsed = parseCookie(cookieValue);
  if (!parsed) return null;
  const expected = sign(parsed.id, parsed.expiresAt, cfg);
  const a = Buffer.from(parsed.sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (parsed.expiresAt < Date.now()) return null;
  if (cfg.revokedSessions[parsed.id]) return null;
  return { id: parsed.id, expiresAt: parsed.expiresAt };
}

/** Routes a signed-in user may reach while the default password is still set. */
const ALLOWED_DURING_PASSWORD_CHANGE = new Set(["/password", "/logout", "/me"]);

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cfg = loadConfig();
  const session = readSession(req.cookies?.[COOKIE], cfg);
  if (!session) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (cfg.mustChangePassword && !ALLOWED_DURING_PASSWORD_CHANGE.has(req.path)) {
    res.status(403).json({ error: "change the default password first", mustChangePassword: true });
    return;
  }
  next();
}

function tooManyAttempts(res: Response, waitMs: number): void {
  const seconds = Math.ceil(waitMs / 1000);
  res.setHeader("Retry-After", String(seconds));
  res.status(429).json({ error: `too many attempts — try again in ${seconds}s` });
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.CARETAKER_SECURE_COOKIE === "1",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function loginHandler(req: Request, res: Response): void {
  const key = clientKey(req);
  const wait = loginLimiter.retryAfterMs(key);
  if (wait > 0) {
    tooManyAttempts(res, wait);
    return;
  }
  const cfg = loadConfig();
  const password = String(req.body?.password || "");
  if (!verifyPassword(password, cfg.uiPasswordHash)) {
    loginLimiter.fail(key);
    console.log(`login failed from ${key}`);
    res.status(401).json({ error: "invalid password" });
    return;
  }
  loginLimiter.succeed(key);
  setSessionCookie(res, createSession(cfg));
  res.json({ ok: true, mustChangePassword: cfg.mustChangePassword });
}

export function logoutHandler(req: Request, res: Response): void {
  destroySession(req.cookies?.[COOKIE], loadConfig());
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
}

export function meHandler(req: Request, res: Response): void {
  const cfg = loadConfig();
  const session = readSession(req.cookies?.[COOKIE], cfg);
  res.json({
    authenticated: Boolean(session),
    mustChangePassword: session ? cfg.mustChangePassword : undefined,
  });
}

export function changePasswordHandler(req: Request, res: Response): void {
  const key = clientKey(req);
  const wait = loginLimiter.retryAfterMs(key);
  if (wait > 0) {
    tooManyAttempts(res, wait);
    return;
  }
  const cfg = loadConfig();
  const current = String(req.body?.currentPassword || "");
  const next = String(req.body?.newPassword || "");
  if (!verifyPassword(current, cfg.uiPasswordHash)) {
    loginLimiter.fail(key);
    res.status(401).json({ error: "invalid current password" });
    return;
  }
  if (next.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `new password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }
  if (isDefaultPassword(next) || next === current) {
    res.status(400).json({ error: "pick a new password" });
    return;
  }
  cfg.uiPasswordHash = hashPassword(next);
  cfg.mustChangePassword = false;
  // Rotate the epoch: every other session is signed out
  cfg.sessionEpoch = crypto.randomBytes(16).toString("hex");
  cfg.revokedSessions = {};
  saveConfig(cfg);
  // Keep this browser signed in with a fresh session
  setSessionCookie(res, createSession(cfg));
  res.json({ ok: true });
}

export { COOKIE };
