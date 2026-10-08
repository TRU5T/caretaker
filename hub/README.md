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
| `CARETAKER_UI_PASSWORD` | recommended | First-run password. If unset it is `changeme`, and the UI refuses to do anything until you change it. |
| `CARETAKER_SESSION_SECRET` | no | HMAC key for session cookies (32+ chars, `openssl rand -hex 32`). If unset, short, or a known placeholder, a random secret is generated and kept in `config.json`. |
| `CARETAKER_RESET_PASSWORD` | no | `1` + `CARETAKER_UI_PASSWORD` resets the password on boot (signs everyone out). |
| `CARETAKER_TRUST_PROXY` | no | Behind a reverse proxy, e.g. `1` or `loopback`, so rate limits see real client IPs. Leave unset otherwise. |
| `CARETAKER_PUBLIC_URL` | no | The URL browsers use (e.g. `https://caretaker.lan`). Used for the agent's heartbeat URL and the cross-origin check behind a proxy. |
| `CARETAKER_UID` / `CARETAKER_GID` | no | User the Hub runs as inside the container (default `1000:1000`; Unraid: `99`/`100`). |
| `CARETAKER_PORT` | no | Default `8080` (compose uses host networking). |
| `CARETAKER_DATA` | no | Config dir; compose mounts `../data`. |
| `CARETAKER_SECURE_COOKIE` | no | Set to `1` if you terminate HTTPS in front of the Hub. |
| `CARETAKER_AGENT_WINDOWS` | no | Override path to `caretaker-agent-setup.exe` for the Setup download. |

Compose builds from the **repo root** (`context: ..`) so the Hub image can compile the agent. `cd hub && docker compose up --build` still works.

Compose uses `network_mode: host` so WoL UDP broadcasts actually leave the machine. Docker Desktop (macOS/Windows) generally cannot do this — run the Hub on Linux.

Data file: `data/config.json` (password hash, session secret, hosts, agent tokens, pinned agent certificates, pairing codes). It is written mode `0600` in a `0700` directory, and the container drops root before starting Node. Do not commit it (already gitignored).

## Run (dev)

```bash
npm install
CARETAKER_DATA=../data CARETAKER_UI_PASSWORD='dev' npm run dev
```

Setup’s download button appears once `../agent/caretaker-agent-setup.exe` (or `caretaker-agent.exe`) exists — `bash ../agent/build-windows.sh` from this directory.

## Discovery

Listens for unpaired agent beacons on UDP **7843** (`caretaker-agent` JSON). Pairing from **Setup → Nearby PCs**:

1. The Hub opens TLS to the agent and records its self-signed certificate.
2. It sends `{ hostId, token, hubUrl, proof }` to `POST /pair`, where `proof = HMAC-SHA256(pairingCode, "caretaker-pair-v1\n" + certSha256)`.
3. The agent accepts only if the proof matches its own certificate and the code it is showing. A machine in the middle would present a different certificate, so its proof fails.
4. From then on every request is pinned to that certificate.

Agents paired before 0.2 used plain HTTP. When such an agent is upgraded, the Hub pins its new certificate the first time it sees it (trust on first use). Unpair and pair again for a fully verified pin.

## Reverse proxy / TLS

The Hub speaks HTTP. If you want HTTPS, put Caddy/nginx/Traefik in front on a private VPN IP — still do not port-forward it. Set `CARETAKER_SECURE_COOKIE=1` when the browser will only see HTTPS, `CARETAKER_PUBLIC_URL` to the HTTPS URL, and `CARETAKER_TRUST_PROXY` so login rate limits apply per client.

The Hub sends a strict Content-Security-Policy, `X-Frame-Options: DENY`, and rejects cross-origin `POST`/`PUT`/`DELETE` requests.
