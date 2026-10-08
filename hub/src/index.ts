import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { ensureConfig, listenPort } from "./config.js";
import { api } from "./routes.js";
import { startDiscoveryListener } from "./discovery.js";
import { agentWindowsInfo } from "./agentDownload.js";
import { HUB_VERSION } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

ensureConfig();
startDiscoveryListener();

const app = express();
app.disable("x-powered-by");

// Behind a reverse proxy, set CARETAKER_TRUST_PROXY (e.g. "1" or "loopback") so
// rate limits see real client IPs. Off by default: X-Forwarded-For is spoofable.
if (process.env.CARETAKER_TRUST_PROXY) {
  const v = process.env.CARETAKER_TRUST_PROXY;
  app.set("trust proxy", /^\d+$/.test(v) ? Number(v) : v);
}

app.use((_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      // The UI sets a few inline style attributes
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "manifest-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; ")
  );
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

/**
 * Reject cross-origin state-changing requests. Browsers always send Origin on
 * cross-site POSTs; other apps on the same NAS IP count as "same-site" for
 * cookies, so SameSite alone is not enough. Requests without Origin (the
 * agent, curl) are left to the normal auth checks.
 */
function allowedOrigins(req: express.Request): Set<string> {
  const out = new Set<string>();
  const host = req.headers.host;
  if (host) {
    out.add(`http://${host}`);
    out.add(`https://${host}`);
  }
  if (process.env.CARETAKER_PUBLIC_URL) {
    try {
      out.add(new URL(process.env.CARETAKER_PUBLIC_URL).origin);
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (origin && !allowedOrigins(req).has(origin)) {
    res.status(403).json({ error: "cross-origin request blocked" });
    return;
  }
  next();
});

app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());

app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.use("/api", api);

const devPublic = path.join(__dirname, "..", "public");
const prodPublic = path.join(__dirname, "public");
const staticDir = fs.existsSync(prodPublic) ? prodPublic : devPublic;

app.use(express.static(staticDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

const port = listenPort();
app.listen(port, () => {
  console.log(`caretaker-hub v${HUB_VERSION} listening on :${port}`);
  console.log(`data dir: ${process.env.CARETAKER_DATA || path.resolve(process.cwd(), "../data")}`);
  const installer = agentWindowsInfo();
  if (installer.available) {
    console.log(`windows installer: ${installer.filename} v${installer.version} (${installer.size} bytes)`);
  } else {
    console.log("windows installer: not bundled (Setup download will be hidden)");
  }
});
