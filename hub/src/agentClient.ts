import type { AgentStatus, UnlockResponse } from "./types.js";

const DEFAULT_TIMEOUT_MS = 4000;

export class AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  private headers(json = false): HeadersInit {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: {
          ...this.headers(Boolean(init?.body)),
          ...(init?.headers || {}),
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`agent ${path} → ${res.status}: ${text || res.statusText}`);
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  health(): Promise<{ ok: true; version: string }> {
    return this.request("/health", { timeoutMs: 2500 });
  }

  status(): Promise<AgentStatus> {
    return this.request("/status", { timeoutMs: 2500 });
  }

  sleep(mode: "sleep" | "hibernate" = "sleep"): Promise<{ ok: true }> {
    return this.request("/sleep", {
      method: "POST",
      body: JSON.stringify({ mode }),
      timeoutMs: 8000,
    });
  }

  unlock(secret: string, kind: "pin" | "password" = "pin"): Promise<UnlockResponse> {
    return this.request("/unlock", {
      method: "POST",
      body: JSON.stringify({ secret, kind }),
      timeoutMs: 45000,
    });
  }

  prepare(): Promise<{ ok: true; message?: string }> {
    return this.request("/prepare", {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: 30000,
    });
  }
}

export async function probeApollo(hostAddress: string, port: number, timeoutMs = 2500): Promise<boolean> {
  if (!hostAddress || !port) return false;
  const https = await import("node:https");
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: hostAddress,
        port,
        path: "/",
        method: "GET",
        rejectUnauthorized: false,
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
