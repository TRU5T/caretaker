import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { hashPassword, loadConfig, verifyPassword, saveConfig, type HubConfig } from "./config.js";

const COOKIE = "caretaker_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

interface Session {
  id: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

function sign(value: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

export function createSession(cfg: HubConfig): string {
  const id = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(id, { id, expiresAt });
  const sig = sign(id, cfg.sessionSecret);
  return `${id}.${sig}`;
}

export function destroySession(cookieValue?: string): void {
  if (!cookieValue) return;
  const id = cookieValue.split(".")[0];
  if (id) sessions.delete(id);
}

export function readSession(cookieValue: string | undefined, cfg: HubConfig): Session | null {
  if (!cookieValue) return null;
  const [id, sig] = cookieValue.split(".");
  if (!id || !sig) return null;
  const expected = sign(id, cfg.sessionSecret);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  const session = sessions.get(id);
  if (!session) {
    // Accept signed cookie even after restart (stateless-ish soft session)
    if (Date.now() > Number.MAX_SAFE_INTEGER) return null;
    const soft: Session = { id, expiresAt: Date.now() + SESSION_TTL_MS };
    sessions.set(id, soft);
    return soft;
  }
  if (session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cfg = loadConfig();
  const session = readSession(req.cookies?.[COOKIE], cfg);
  if (!session) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

export function loginHandler(req: Request, res: Response): void {
  const cfg = loadConfig();
  const password = String(req.body?.password || "");
  if (!verifyPassword(password, cfg.uiPasswordHash)) {
    res.status(401).json({ error: "invalid password" });
    return;
  }
  const token = createSession(cfg);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.CARETAKER_SECURE_COOKIE === "1",
    maxAge: SESSION_TTL_MS,
  });
  res.json({ ok: true });
}

export function logoutHandler(req: Request, res: Response): void {
  destroySession(req.cookies?.[COOKIE]);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
}

export function meHandler(req: Request, res: Response): void {
  const cfg = loadConfig();
  const session = readSession(req.cookies?.[COOKIE], cfg);
  res.json({ authenticated: Boolean(session) });
}

export function changePasswordHandler(req: Request, res: Response): void {
  const cfg = loadConfig();
  const current = String(req.body?.currentPassword || "");
  const next = String(req.body?.newPassword || "");
  if (!verifyPassword(current, cfg.uiPasswordHash)) {
    res.status(401).json({ error: "invalid current password" });
    return;
  }
  if (next.length < 6) {
    res.status(400).json({ error: "new password must be at least 6 characters" });
    return;
  }
  cfg.uiPasswordHash = hashPassword(next);
  saveConfig(cfg);
  res.json({ ok: true });
}

export { COOKIE };
