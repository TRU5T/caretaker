# Caretaker Agent

Windows service on the gaming PC. Talks to [the Hub](../hub/) over HTTP on the LAN.

**This binary looks like a remote-access tool to antivirus because it is one — a tiny, open, LAN-only one you install yourself.** Read [SAFETY.md](../SAFETY.md) before installing. It is not a virus; it is also not something to run on a PC you do not own.

## What it does

| Endpoint | Auth | Action |
|----------|------|--------|
| `GET /health` | no | Version + paired flag |
| `GET /discover` | no | Hostname, MACs, IPs (for Hub UI) |
| `POST /pair` | unpaired only | Accept Hub token; then this closes |
| `GET /status` | bearer | Lock state, hostname, username |
| `POST /sleep` | bearer | Sleep or hibernate |
| `POST /unlock` | bearer | Type PIN/password on the lock screen |
| `POST /prepare` | bearer | Wake lock-screen UI without submitting a PIN |

Unpaired, it also **UDP-broadcasts** on port **7843** every 3 seconds so the Hub can list Nearby PCs.

There is no shell, file, or screenshot API.

## Build

On Windows (Git + [Go 1.22+](https://go.dev/dl/)):

```powershell
cd agent
go build -o caretaker-agent.exe ./cmd/caretaker-agent
```

On Linux, targeting Windows amd64:

```bash
./build-windows.sh
```

That script embeds the Caretaker icon and file version into the `.exe` (Explorer / Task Manager show **Caretaker Agent**). Plain `go build` does the same when `cmd/caretaker-agent/rsrc_windows_amd64.syso` is present — regenerate it with [`build-windows.sh`](build-windows.sh) if you change [`winres/icon.png`](winres/icon.png).

The Hub Docker image also cross-compiles this binary and serves it at `/api/agent/windows`. Prefer that (or a binary you built from this repo) over an `.exe` from a chat thread or random mirror.

## Install (from the Hub)

On the gaming PC: Hub → **Setup** → **Download installer** → double-click `caretaker-agent-setup.exe` → accept the administrator prompt.

That copies the binary to `%ProgramFiles%\Caretaker\caretaker-agent.exe`, starts the **Caretaker Agent** service, adds a LAN firewall rule, and registers **Add or Remove Programs**. Then pair from the Hub. No Command Prompt.

Uninstall: Windows **Apps** → Caretaker Agent, or `caretaker-agent.exe setup --uninstall`.

Double-clicking the downloaded `.exe` is the same as `caretaker-agent.exe setup`. Running it from a terminal with no arguments still starts in the foreground (for debugging).

## CLI (elevated)

```powershell
.\caretaker-agent.exe install
.\caretaker-agent.exe start
```

Service name: **CaretakerAgent** (display name **Caretaker Agent**). It runs as **Local System** so unlock can reach the Winlogon desktop.

```powershell
.\caretaker-agent.exe stop
.\caretaker-agent.exe uninstall
```

Foreground (debugging):

```powershell
.\caretaker-agent.exe run
```

## Files

| Path | What |
|------|------|
| `%ProgramFiles%\Caretaker\caretaker-agent.exe` | Installed service binary (from the Hub installer) |
| `%ProgramData%\Caretaker\agent.json` | Token, hub URL, host id, listen addr |
| `%ProgramData%\Caretaker\agent.log` | Service log (PIN values are not written) |
| `%ProgramData%\Caretaker\agent-crash.log` | Panic / fatal traces |

Example config: [`agent.example.json`](agent.example.json). Pairing writes the real file; you usually do not edit it by hand.

Listen port defaults to **7842** (`CARETAKER_AGENT_PORT` / `listenAddr`).

## Windows Defender / SmartScreen

Unsigned + System service + `SendInput` on the secure desktop trips heuristics. Typical handling:

1. Compare SHA-256 to Setup’s listing (`Get-FileHash caretaker-agent-setup.exe -Algorithm SHA256`).
2. Allow the binary once, or add an exclusion for `%ProgramData%\Caretaker\` and `%ProgramFiles%\Caretaker\`.
3. Do **not** turn off Defender entirely.

If SmartScreen blocks the first launch: More info → Run anyway, or unblock via file Properties.

## Pairing

From the Hub **Setup** page after the service is running (beacon must reach the Hub). Manual fallback:

```powershell
.\caretaker-agent.exe pair --hub http://10.0.1.10:8080 --code ABCDEF --agent-url http://10.0.1.50:7842
```

Leave the agent unpaired only on a network you trust.

## Linux

`go run` works for HTTP/pairing stubs. Sleep and unlock return errors; they are Windows-only (`*_windows.go`).
