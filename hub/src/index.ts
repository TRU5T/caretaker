import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { ensureConfig, listenPort } from "./config.js";
import { api } from "./routes.js";
import { startDiscoveryListener } from "./discovery.js";
import { HUB_VERSION } from "./types.js";

// Allow self-signed Apollo certificates for reachability probes.
https.globalAgent.options.rejectUnauthorized = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

ensureConfig();
startDiscoveryListener();

const app = express();
app.disable("x-powered-by");
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
});
