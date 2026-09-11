# Contributing

Thanks for taking a look. Caretaker is a small homelab tool (Node Hub + Go Windows agent). Useful PRs are welcome; drive-by refactors of the unlock path are not.

## Before you start

Read [SAFETY.md](SAFETY.md). This software can wake a PC, type a Windows PIN, and sleep the machine. Changes that widen that surface (shell exec, file APIs, internet exposure) will not be merged.

## Dev setup

**Hub** (Node 18+):

```bash
cd hub
npm install
CARETAKER_DATA=../data npm run dev
```

UI: `http://localhost:8080` — default password `changeme` unless `CARETAKER_UI_PASSWORD` is set.

**Agent** (Go 1.22+):

```bash
cd agent
go run ./cmd/caretaker-agent run --config /tmp/caretaker-agent.json
```

Sleep and unlock are **Windows-only**. On Linux the agent is a stub useful for pairing/HTTP checks.

Cross-compile the Windows binary from Linux:

```bash
bash agent/build-windows.sh
# or: cd agent && GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o caretaker-agent.exe ./cmd/caretaker-agent
```

Hub in Docker (needs Linux host networking for WoL). Compose builds from the repo root so the image can compile the Windows installer:

```bash
cd hub
export CARETAKER_UI_PASSWORD='…'
export CARETAKER_SESSION_SECRET="$(openssl rand -hex 32)"
docker compose up --build
```

## Project layout

| Path | What |
|------|------|
| `hub/` | Express app + phone UI |
| `agent/` | Windows service (`caretaker-agent`) |
| `docs/logo.svg` | Brand mark (PNG/ICO generated from this) |
| `shared/api.ts` | HTTP contract (mirrored in `hub/src/types.ts`) |

Keep Hub types in sync with `shared/api.ts` when you change request/response shapes.

## Brand / icons

Canonical mark: [`docs/logo.svg`](docs/logo.svg) (teal crescent + keyhole, Hub colors). After editing it:

```bash
npm install --prefix /tmp/caretaker-brand @resvg/resvg-js png-to-ico
NODE_PATH=/tmp/caretaker-brand/node_modules node scripts/render-brand.mjs
bash agent/build-windows.sh   # refreshes the .syso used as the Windows exe icon
```

## Unlock sequence

Remote unlock is empirically fragile. The working sequence lives in `agent/internal/agent/session_windows.go` (`wakeCredentialUI` / `unlockInject`). Do **not** “simplify” it (different key to dismiss the lock screen, typing without waiting for the Winlogon desktop, resuming a partial PIN, etc.) unless you have tested on a locked Windows 10/11 console session.

## PR checklist

- [ ] Hub still typechecks (`cd hub && npm run typecheck`)
- [ ] Agent still builds (`cd agent && go build ./cmd/caretaker-agent`, plus a Windows cross-compile if you touched `*_windows.go`)
- [ ] No PIN/password logged or written to hub `data/config.json`
- [ ] New endpoints stay behind Hub session auth or the agent bearer token
- [ ] README / SAFETY.md updated if behavior or threat model changed

## Issues

Use the GitHub issue templates. Antivirus false positives belong on the **Antivirus / SmartScreen** template, not a “this is a virus” issue with no extra detail.
