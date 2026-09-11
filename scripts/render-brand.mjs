#!/usr/bin/env node
/**
 * Rasterize docs/logo.svg into GitHub / Hub / Windows icon files.
 *
 *   npm install @resvg/resvg-js png-to-ico
 *   node scripts/render-brand.mjs
 */
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svg = fs.readFileSync(path.join(root, "docs/logo.svg"));

function pngAt(px) {
  return new Resvg(svg, {
    fitTo: { mode: "width", value: px },
    background: "rgba(0,0,0,0)",
  })
    .render()
    .asPng();
}

function write(rel, buf) {
  const dest = path.join(root, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log(rel, buf.length);
}

write("docs/logo.png", pngAt(512));
write("hub/public/favicon.svg", svg);
write("hub/public/icon-192.png", pngAt(192));
write("hub/public/icon-512.png", pngAt(512));
write("hub/public/apple-touch-icon.png", pngAt(180));

const tmp = path.join(root, "docs/.icon-tmp");
fs.mkdirSync(tmp, { recursive: true });
for (const s of [16, 24, 32, 48, 64, 128, 256]) {
  fs.writeFileSync(path.join(tmp, `${s}.png`), pngAt(s));
}

const fav = await pngToIco([16, 32, 48].map((s) => path.join(tmp, `${s}.png`)));
write("hub/public/favicon.ico", fav);

const win = await pngToIco([16, 24, 32, 48, 64, 128, 256].map((s) => path.join(tmp, `${s}.png`)));
write("agent/winres/icon.ico", win);
fs.copyFileSync(path.join(tmp, "256.png"), path.join(root, "agent/winres/icon.png"));
console.log("agent/winres/icon.png", fs.statSync(path.join(root, "agent/winres/icon.png")).size);

fs.rmSync(tmp, { recursive: true, force: true });
