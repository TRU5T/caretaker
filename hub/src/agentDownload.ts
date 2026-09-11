import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import { AGENT_VERSION } from "./types.js";

export const AGENT_DOWNLOAD_FILENAME = "caretaker-agent-setup.exe";

interface CachedFile {
  path: string;
  size: number;
  sha256: string;
  mtimeMs: number;
}

let cache: CachedFile | null = null;

function here(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** Locations the Hub will serve as the Windows installer. First existing file wins. */
export function candidateAgentWindowsPaths(): string[] {
  const dir = here();
  const listed = [
    process.env.CARETAKER_AGENT_WINDOWS,
    "/app/downloads/caretaker-agent-setup.exe",
    path.join(process.cwd(), "downloads", AGENT_DOWNLOAD_FILENAME),
    path.join(process.cwd(), "downloads", "caretaker-agent.exe"),
    path.join(dir, "..", "downloads", AGENT_DOWNLOAD_FILENAME),
    path.join(dir, "..", "downloads", "caretaker-agent.exe"),
    path.join(dir, "..", "..", "agent", AGENT_DOWNLOAD_FILENAME),
    path.join(dir, "..", "..", "agent", "caretaker-agent.exe"),
    path.join(process.cwd(), "..", "agent", AGENT_DOWNLOAD_FILENAME),
    path.join(process.cwd(), "..", "agent", "caretaker-agent.exe"),
  ];
  return listed.filter((p): p is string => Boolean(p));
}

export function resolveAgentWindowsPath(): string | null {
  for (const p of candidateAgentWindowsPaths()) {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0) return p;
    } catch {
      /* ignore unreadable candidates */
    }
  }
  return null;
}

function cached(): CachedFile | null {
  const file = resolveAgentWindowsPath();
  if (!file) {
    cache = null;
    return null;
  }
  const st = fs.statSync(file);
  if (cache && cache.path === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return cache;
  }
  const buf = fs.readFileSync(file);
  cache = {
    path: file,
    size: st.size,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    mtimeMs: st.mtimeMs,
  };
  return cache;
}

export function agentWindowsInfo(): {
  available: boolean;
  filename?: string;
  version?: string;
  size?: number;
  sha256?: string;
} {
  const file = cached();
  if (!file) return { available: false };
  return {
    available: true,
    filename: AGENT_DOWNLOAD_FILENAME,
    version: AGENT_VERSION,
    size: file.size,
    sha256: file.sha256,
  };
}

export function agentWindowsInfoHandler(_req: Request, res: Response): void {
  res.json(agentWindowsInfo());
}

export function agentWindowsDownloadHandler(_req: Request, res: Response): void {
  const file = cached();
  if (!file) {
    res.status(404).json({ error: "Windows installer is not bundled in this Hub" });
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.download(file.path, AGENT_DOWNLOAD_FILENAME, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  });
}
