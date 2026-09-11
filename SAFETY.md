# Is Caretaker safe?

**Short answer:** Caretaker is not malware. It is open-source, self-hosted software that you install on machines you own. It does not phone home, steal files, or run a hidden remote shell.

It **is** a privileged remote-control helper. Anyone who can log into your Hub can wake the PC, type your Windows PIN/password at the lock screen, and put the PC to sleep. Treat it like a house key, not like a wallpaper app.

If you found `caretaker-agent.exe` or a **Caretaker Agent** Windows service on a PC **you did not install it on**, treat that as unauthorized remote access and remove it. See [If you did not install this](#if-you-did-not-install-this).

## What it is

Caretaker is a LAN companion for [Moonlight](https://moonlight-stream.org/) + [Apollo](https://github.com/ClassicOldSong/Apollo) (a Sunshine-compatible host):

1. Wake the gaming PC (Wake-on-LAN)
2. Unlock the Windows lock screen from your phone
3. You open Moonlight yourself and stream
4. Sleep the PC when you are done

The Hub runs on an always-on box you control (NAS, Pi, homelab VM). The agent is a Windows service **you** install on the gaming PC.

## What it is not

Caretaker does **not**:

- Contact the author, GitHub, or any third-party server
- Install extra programs, browser extensions, or scheduled tasks beyond the Windows service you run (`CaretakerAgent`), plus the inbound firewall rule and Add/Remove Programs entry the installer creates
- Expose a command shell, script runner, or “execute anything” API
- Read, write, or exfiltrate your files
- Capture the screen or microphone
- Keylog ordinary typing (it only types the PIN/password **you submit in the Hub UI** onto the lock screen)
- Mine cryptocurrency, encrypt files, or persist after `caretaker-agent uninstall`

You can verify this by reading the agent HTTP surface in [`agent/internal/agent/server.go`](agent/internal/agent/server.go). The authenticated endpoints are `/status`, `/sleep`, `/unlock`, and `/prepare`.

## Why antivirus and SmartScreen may flag it

Unsigned Windows binaries that:

- Run as **Local System**
- Duplicate a winlogon token and inject input on the secure desktop
- Listen on a TCP port
- Broadcast UDP on the LAN

look like a remote-access trojan to heuristic scanners. **That similarity is real; the intent is not.** Caretaker uses those APIs because unlocking a locked Windows session from the couch requires them.

Expect:

- Microsoft Defender / SmartScreen warnings on `caretaker-agent.exe`
- “Unknown publisher” because releases are not Authenticode-signed
- False positives from other AV products, especially on first run

**Safer than downloading a random `.exe`:** use **Setup → Download installer** on *your* Hub (that file is compiled from this source when the Hub image is built), or [build the agent yourself](agent/README.md). Prefer a Defender exclusion on `%ProgramData%\Caretaker\` and `%ProgramFiles%\Caretaker\`, not a blanket disable of antivirus.

This project does not currently ship notarized or EV-signed binaries. Treat pre-built executables from anywhere other than **your Hub** or this GitHub repo as untrusted.

## Privileges (by design)

| Component | Runs as | Why |
|-----------|---------|-----|
| Hub | Docker / Node user on your always-on host | Serves the UI, sends WoL packets, talks to the agent |
| Agent (recommended) | Windows service **Local System** | Must reach the lock-screen (Winlogon) desktop to type a PIN |

If you run the agent only in a normal user session, sleep may work; reliable unlock usually will not.

## Network threat model

Caretaker is **LAN-first**. It is **not safe to put on the public internet**.

| Channel | Protection | Residual risk |
|---------|------------|----------------|
| Hub UI | Password + HMAC-signed session cookie | Default password is `changeme` if you skip env vars. HTTP (not HTTPS) unless you put a reverse proxy in front. |
| Hub → agent | Shared bearer token after pairing | Traffic is **plain HTTP**. Anyone who can sniff your LAN can see tokens and unlock payloads. |
| Unlock PIN/password | Sent Hub → agent, **not stored on the hub**, not written to logs | Briefly present in memory and in the HTTP body on the LAN. |
| Unlock brute force | Agent allows 3 failures / 15 minutes | Protects Windows PIN lockout more than it protects against a stolen token. |
| LAN discovery | Unpaired agent UDP-broadcasts on port **7843** | Hostname, IPs, and MACs are visible on the LAN until paired. |
| Pairing | Unpaired agent accepts `POST /pair` from whoever can reach TCP **7842** | Pair promptly. Do not leave an unpaired agent on an untrusted network (guest Wi-Fi, dorm, office). |
| Wake-on-LAN | No auth (by design of WoL) | Anyone on the L2 broadcast domain can wake the PC if they know the MAC. |

**Do this:**

1. Set a strong `CARETAKER_UI_PASSWORD` and `CARETAKER_SESSION_SECRET` before first Hub start.
2. Keep Hub and agent on a trusted LAN, or reach the Hub only over **Tailscale / WireGuard / similar VPN**.
3. Pair the agent as soon as you install it.
4. Do not port-forward `8080` or `7842` to the internet.
5. If you need HTTPS, terminate TLS on a reverse proxy you control; do not expose the Hub directly.

## What the agent can do vs cannot do

**Can** (after pairing, with the bearer token):

- Report lock state, hostname, signed-in username, uptime
- Sleep or hibernate the PC
- Type a PIN or password into the Windows lock screen
- Wake the display so the PIN field is reachable

**Cannot:**

- Run arbitrary programs or PowerShell
- Browse the filesystem
- Change Windows users, BitLocker, or Hello policies
- Survive `caretaker-agent uninstall` / Services → stop + delete

## How to verify a binary

```powershell
# On the machine that built it, or after cloning this repo:
cd agent
go build -o caretaker-agent.exe ./cmd/caretaker-agent

Get-FileHash .\caretaker-agent.exe -Algorithm SHA256
```

Compare that hash to any `.exe` you are about to run. If you did not build it, do not run it.

Config and logs (Windows):

- `%ProgramData%\Caretaker\agent.json` — token, hub URL, host id (mode `0600`-equivalent on write)
- `%ProgramData%\Caretaker\agent.log` — operational logs; unlock secrets are not logged (only `secretLen`)

## If you did not install this

1. Uninstall **Caretaker Agent** from Windows Apps, or `sc.exe stop CaretakerAgent` then `sc.exe delete CaretakerAgent` (or `caretaker-agent.exe setup --uninstall` / `uninstall` if the binary is still there).
2. Delete `%ProgramData%\Caretaker\`, `%ProgramFiles%\Caretaker\`, and any leftover `caretaker-agent*.exe` copies.
3. Assume the Windows PIN/password may have been typed over the network; consider changing it.
4. Check who had access to the LAN / Hub host.

## Warranty

Caretaker is provided **as is** under the [MIT License](LICENSE). Remote unlock can fail on Hello-only accounts, some Group Policy setups, and after Windows lock-screen changes. A failed or partial unlock can still count against Windows PIN lockout — that is why the agent rate-limits attempts.
