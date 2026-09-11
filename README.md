# Caretaker

All-in-one **Moonlight / Apollo companion** for a Windows gaming PC:

1. **Wake** the PC (Wake-on-LAN)
2. **Unlock** the Windows lock screen (PIN pad from your phone)
3. Open **Moonlight** and stream via **Apollo**
4. **Sleep** the PC when you’re done

```
Phone / browser  →  Caretaker Hub (Docker)  →  WoL magic packet
                              ↕ token API
                    Caretaker Agent (Windows service)
                              ↕
                    Apollo + your games
```

## Components

| Piece | Path | Runs where |
|--------|------|------------|
| **Hub** | [`hub/`](hub/) | Always-on host (NAS, Pi, homelab VM) in Docker |
| **Agent** | [`agent/`](agent/) | Native Windows service on the gaming PC |
| **Shared contract** | [`shared/api.ts`](shared/api.ts) | API shapes |

Apollo does **not** replace Caretaker — it has no host WoL/sleep/unlock API. Caretaker stops at “Ready”; you still open Moonlight yourself.

## Quick start

### 1. Hub (container)

```bash
cd hub
export CARETAKER_UI_PASSWORD='pick-a-strong-password'
export CARETAKER_SESSION_SECRET="$(openssl rand -hex 32)"
docker compose up -d --build
```

Open `http://<hub-host>:8080` (host networking). Default password is `changeme` if you skip the env var.

> **WoL note:** `network_mode: host` is used so UDP broadcasts reach your LAN. On Docker Desktop this is limited — prefer a Linux VM/NAS for the hub.

### 2. Agent (Windows gaming PC)

On a machine with Go (or use a pre-built `caretaker-agent.exe` from CI):

```powershell
cd agent
go build -o caretaker-agent.exe ./cmd/caretaker-agent
```

**Pairing (discovery — recommended):**

1. On the gaming PC, install and run the agent (unpaired):
   ```powershell
   .\caretaker-agent.exe install
   .\caretaker-agent.exe start
   ```
2. Open the Hub → **Setup** — the PC appears under **Nearby PCs** (hostname, MAC, IP).
3. Tap **Pair**. Done.

The agent broadcasts on the LAN (UDP 7843). The hub listens and one-click pairs by pushing a token to the agent.

**Fallback:** Setup → manual add with a pairing code, then `caretaker-agent pair --hub … --code … --agent-url …`.

### 3. Couch flow

1. Open Caretaker on your phone  
2. **Wake** → wait until status is **locked** or **ready**  
3. If locked, enter PIN  
4. When status is **ready** (and Apollo badge is up), open Moonlight  
5. **Sleep** when finished  

## Wake-on-LAN checklist (Windows host)

1. **UEFI/BIOS:** enable Wake on LAN / Power on by PCI-E  
2. **Device Manager → NIC → Power Management:** allow this device to wake the computer  
3. **NIC Advanced:** enable **Wake on Magic Packet**; disable **Wake on pattern**  
4. Prefer **Sleep** over full shutdown if your NIC drops WoL after long soft-offs  
5. Hub and PC must be on the **same L2 network** (or use a directed broadcast your router allows)

## How remote unlock works (do not "simplify" this)

This sequence was arrived at empirically and is the only one that unlocks on the
first attempt. The relevant code is `wakeCredentialUI` / `unlockInject` in
`agent/internal/agent/session_windows.go`.

1. The service (Session 0) duplicates the **winlogon SYSTEM token** for the
   active console session and launches itself as `unlock-helper` there via
   `CreateProcessAsUserW`, hidden (`CREATE_NO_WINDOW` + `SW_HIDE`).
2. The helper joins `winsta0`, then wakes the monitor with
   `SetThreadExecutionState(ES_DISPLAY_REQUIRED)`. This needs no desktop access,
   so it works while `SendInput` is still being denied.
3. It taps **Space** (not a modifier — the Win10/11 lock screen is `LockApp` on
   the **Default** desktop and ignores Shift), re-tapping every 500 ms until
   `OpenInputDesktop` reports **Winlogon**, which is the desktop that owns the
   password field. `SendInput` is only accepted by the desktop currently owning
   input, and that desktop changes as a result of the tap.
4. It re-attaches to that desktop, clears the field (Ctrl+A, Backspace), types
   the secret, then presses Enter.

If typing is interrupted part-way (the desktop switched mid-word), the field is
cleared and the whole secret is retyped — never resumed, since a partial secret
would submit a wrong password and burn a Windows lockout attempt.

## Security

- Hub UI is password-protected (session cookie)  
- Hub ↔ agent uses a **shared bearer token**  
- Unlock PIN/password is **never logged** and not stored on the hub  
- Unlock attempts are rate-limited (3 failures / 15 minutes) to avoid Windows PIN lockout  
- **LAN-first:** do not expose the hub to the public internet without a VPN (Tailscale, WireGuard, etc.)  
- For reliable unlock, run the agent as a **Windows service** (SYSTEM) so it can reach the secure desktop  

## Development

```bash
# Hub
cd hub && npm install && CARETAKER_DATA=../data npm run dev

# Agent (Linux stub — sleep/unlock are Windows-only)
cd agent && go run ./cmd/caretaker-agent run --config /tmp/caretaker-agent.json
```

Cross-compile Windows agent from Linux:

```bash
cd agent
GOOS=windows GOARCH=amd64 go build -o caretaker-agent.exe ./cmd/caretaker-agent
```

## API sketch

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/login` | — | UI session |
| GET | `/api/hosts` | UI | List hosts |
| POST | `/api/hosts` | UI | Add PC (name+MAC) → returns pairing code |
| POST | `/api/hosts/:id/pair` | UI | Re-issue pairing code for a host |
| POST | `/api/hosts/:id/wake` | UI | Send WoL |
| POST | `/api/hosts/:id/sleep` | UI | Proxy sleep to agent |
| POST | `/api/hosts/:id/unlock` | UI | Proxy PIN/password (body not logged) |
| GET | `/api/hosts/:id/status` | UI | Aggregated state + Apollo probe |
| POST | `/api/pair/complete` | agent | Claim pairing code for existing host |
| POST | `/api/heartbeat` | agent token | Optional agent→hub heartbeat |

Agent (on PC): `GET /health`, `GET /status`, `POST /sleep`, `POST /unlock` — all except health require `Authorization: Bearer <token>`.

## Limits (MVP)

- Unlock uses secure-desktop key injection (not a custom Credential Provider). Some setups (Hello-only, certain policies) may need Phase‑2 credential provider work.  
- No embedded Moonlight client — Caretaker is the power/login companion only.  
- Apollo reachability is a best-effort HTTPS probe on port `47990`.  
