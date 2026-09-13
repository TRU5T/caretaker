# Caretaker Hub

Always-on companion UI: Wake-on-LAN, agent proxy (sleep/unlock), Apollo reachability, LAN discovery.

Runs in Docker on a Linux NAS / Pi / homelab VM. **Not** intended to be published to the internet — see [SAFETY.md](../SAFETY.md).

**Unraid:** use the Community-style template in [`../unraid/`](../unraid/) (`ghcr.io/tru5t/caretaker-hub:latest`, host network). Step-by-step: [`../unraid/README.md`](../unraid/README.md).

## Run (Docker)

From this directory:

```bash
export CARETAKER_UI_PASSWORD='pick-a-strong-password'
export CARETAKER_SESSION_SECRET="$(openssl rand -hex 32)"
docker compose up -d --build
```

Then open `http://<this-host>:8080`. The image build cross-compiles the Windows agent; Setup → **Download installer** serves it (login required).

| Variable | Required | Notes |
|----------|----------|--------|
| `CARETAKER_UI_PASSWORD` | strong yes | Default is `changeme` if unset. Used only on first config create. |
| `CARETAKER_SESSION_SECRET` | strong yes | HMAC key for the session cookie. Default is an insecure placeholder in compose. |
| `CARETAKER_PORT` | no | Default `8080` (compose uses host networking). |
| `CARETAKER_DATA` | no | Config dir; compose mounts `../data`. |
| `CARETAKER_SECURE_COOKIE` | no | Set to `1` if you terminate HTTPS in front of the Hub. |
| `CARETAKER_AGENT_WINDOWS` | no | Override path to `caretaker-agent-setup.exe` for the Setup download. |

Compose builds from the **repo root** (`context: ..`) so the Hub image can compile the agent. `cd hub && docker compose up --build` still works.

Compose uses `network_mode: host` so WoL UDP broadcasts actually leave the machine. Docker Desktop (macOS/Windows) generally cannot do this — run the Hub on Linux.

Data file: `data/config.json` (password hash, session secret, hosts, pairing codes). Do not commit it (already gitignored).

## Run (dev)

```bash
npm install
CARETAKER_DATA=../data CARETAKER_UI_PASSWORD='dev' npm run dev
```

Setup’s download button appears once `../agent/caretaker-agent-setup.exe` (or `caretaker-agent.exe`) exists — `bash ../agent/build-windows.sh` from this directory.

## Discovery

Listens for unpaired agent beacons on UDP **7843** (`caretaker-agent` JSON). Pairing from **Setup → Nearby PCs** pushes `{ hostId, token, hubUrl }` to the agent’s `POST /pair`.

Until an agent is paired, that `POST /pair` is unauthenticated on the LAN. Pair immediately.

## Reverse proxy / TLS

The Hub speaks HTTP. If you want HTTPS, put Caddy/nginx/Traefik in front on a private VPN IP — still do not port-forward it. Set `CARETAKER_SECURE_COOKIE=1` when the browser will only see HTTPS.
