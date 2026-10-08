/**
 * Small in-memory failure limiter. Each key (usually a client IP) gets a few
 * free failures, then an exponentially growing lockout. A global bucket caps
 * total failures so rotating source IPs does not help an attacker much.
 */
export class FailureLimiter {
  private readonly perKey = new Map<string, { fails: number; lockedUntil: number; lastFail: number }>();
  private globalFails: number[] = [];

  constructor(
    private readonly opts: {
      freeFailures: number;
      baseLockMs: number;
      maxLockMs: number;
      /** Forget a key's history after this long without failures */
      resetAfterMs: number;
      globalMax: number;
      globalWindowMs: number;
    }
  ) {}

  /** Milliseconds the caller must wait, or 0 if allowed. */
  retryAfterMs(key: string): number {
    const now = Date.now();
    this.globalFails = this.globalFails.filter((t) => now - t < this.opts.globalWindowMs);
    if (this.globalFails.length >= this.opts.globalMax) {
      return this.opts.globalWindowMs - (now - this.globalFails[0]);
    }
    const entry = this.perKey.get(key);
    if (!entry) return 0;
    if (now - entry.lastFail > this.opts.resetAfterMs) {
      this.perKey.delete(key);
      return 0;
    }
    return Math.max(0, entry.lockedUntil - now);
  }

  fail(key: string): void {
    const now = Date.now();
    this.globalFails.push(now);
    const entry = this.perKey.get(key) || { fails: 0, lockedUntil: 0, lastFail: 0 };
    if (now - entry.lastFail > this.opts.resetAfterMs) entry.fails = 0;
    entry.fails++;
    entry.lastFail = now;
    const over = entry.fails - this.opts.freeFailures;
    if (over > 0) {
      const lock = Math.min(this.opts.maxLockMs, this.opts.baseLockMs * 2 ** (over - 1));
      entry.lockedUntil = now + lock;
    }
    this.perKey.set(key, entry);
    if (this.perKey.size > 10_000) {
      // Bound memory: drop the oldest entries
      for (const k of this.perKey.keys()) {
        this.perKey.delete(k);
        if (this.perKey.size <= 5_000) break;
      }
    }
  }

  succeed(key: string): void {
    this.perKey.delete(key);
  }
}

export function clientKey(req: { ip?: string; socket?: { remoteAddress?: string } }): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}
