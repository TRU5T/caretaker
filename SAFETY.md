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

You can verify this by reading the agent HTTP surface in [`agent/internal/agent/server.go`](agent/internal/agent/server.go). The authenticated endpoints are `/status`, `/sleep`, `/unlock`, `/prepare`, `/rotate` (replace the token), and `/unpair` (forget the Hub).

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
| Hub UI | Password + signed, expiring session cookie (`SameSite=Strict`). Login is rate-limited (5 tries, then growing lockouts). The default `changeme` password must be changed before the Hub does anything. Changing the password signs out every other session. Placeholder or short session secrets are ignored. Cross-origin writes are rejected; CSP and `X-Frame-Options` block injected scripts and clickjacking. | Browser ↔ Hub is HTTP unless you put a reverse proxy in front, so someone sniffing the LAN can see your Hub password and the PIN you type. |
| Hub → agent | **HTTPS, pinned to the agent's own certificate**, plus a bearer token. The token can be rotated from Setup, and unpairing makes the agent forget it. | Hosts paired before 0.2 are upgraded by trusting the agent's certificate the first time it is seen; re-pair them for a fully verified pin. |
| Agent → Hub heartbeat | Signed with HMAC of the token and a timestamp; the token itself is never sent | A captured heartbeat can be replayed for up to 5 minutes, which only makes the PC look online. |
| Unlock PIN/password | Sent Hub → agent over the pinned TLS connection; **not stored on the hub**, not written to logs | Briefly present in memory. Also crosses browser → Hub (see Hub UI). |
| Unlock brute force | Agent allows 3 failures / 15 minutes | Protects Windows PIN lockout more than it protects against a stolen token. |
| LAN discovery | Unpaired agent UDP-broadcasts on port **7843** | Hostname, IPs, and MACs are visible on the LAN until paired. |
| Pairing | `POST /pair` needs proof of the 10-character code shown on the PC, bound to the agent's TLS certificate. Five wrong codes lock pairing for 15 minutes. Manual pairing codes from the Hub are 10 characters, expire in 10 minutes, and are rate-limited. | Someone on the LAN can keep an unpaired agent's pairing locked by sending wrong codes (an annoyance, not a takeover). Manual `caretaker-agent pair` against a plain-HTTP Hub sends the new token unencrypted in the Hub's reply. |
| Agent firewall | Inbound TCP on the agent port only, from the local subnet while unpaired, then from the Hub's IP only | If the Hub's IP changes, run `caretaker-agent unpair` on the PC (as administrator) and pair again. |
| Wake-on-LAN | No auth (by design of WoL) | Anyone on the L2 broadcast domain can wake the PC if they know the MAC. |

**Do this:**

1. Set a strong `CARETAKER_UI_PASSWORD` (or change `changeme` when prompted). Leave `CARETAKER_SESSION_SECRET` empty unless you generate it with `openssl rand -hex 32`.
2. Keep Hub and agent on a trusted LAN, or reach the Hub only over **Tailscale / WireGuard / similar VPN**.
3. Pair the agent with the code the installer shows. Only type that code into **your** Hub.
4. Do not port-forward `8080` or `7842` to the internet.
5. If you need HTTPS, terminate TLS on a reverse proxy you control (set `CARETAKER_SECURE_COOKIE=1`, `CARETAKER_PUBLIC_URL`, `CARETAKER_TRUST_PROXY`); do not expose the Hub directly.
6. If you think a token leaked, use **Setup → New token**. To retire a PC, use **Unpair**.

## What the agent can do vs cannot do

**Can** (after pairing, with the bearer token):

- Report lock state, hostname, signed-in username, uptime
- Sleep or hibernate the PC
- Type a PIN or password into the Windows lock screen
- Wake the display so the PIN field is reachable
- Accept a replacement token, or forget the Hub (unpair)

**Cannot:**

- Run arbitrary programs or PowerShell
- Browse the filesystem
- Change Windows users, BitLocker, or Hello policies
- Survive `caretaker-agent uninstall` / Services → stop + delete

## How to verify a binary

**1. Compare with your Hub.** Setup shows the installer's full SHA-256. On the PC:

```powershell
Get-FileHash .\caretaker-agent-setup.exe -Algorithm SHA256
```

**2. Rebuild it yourself.** The build is reproducible: the same source and Go toolchain give byte-identical output. Use the Go image pinned in [`hub/Dockerfile`](hub/Dockerfile):

```bash
cd agent
docker run --rm -v "$PWD":/src -w /src -e CGO_ENABLED=0 -e GOOS=windows -e GOARCH=amd64 \
  golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 \
  sh -c 'go build -trimpath -ldflags="-s -w -buildid=" -o caretaker-agent-setup.exe ./cmd/caretaker-agent && sha256sum caretaker-agent-setup.exe'
```

**3. Check the Sigstore signatures.** CI signs the published Hub image and the installer it contains with keyless [cosign](https://docs.sigstore.dev/). The installer, its `.sha256`, and its `.sigstore.json` bundle are attached to each "Publish Hub image" workflow run.

```bash
cosign verify ghcr.io/tru5t/caretaker-hub:latest \
  --certificate-identity-regexp '^https://github.com/TRU5T/caretaker/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

cosign verify-blob caretaker-agent-setup.exe --bundle caretaker-agent-setup.exe.sigstore.json \
  --certificate-identity-regexp '^https://github.com/TRU5T/caretaker/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

If none of these match, do not run it.

Config and logs (Windows):

- `%ProgramData%\Caretaker\` is restricted to **SYSTEM and Administrators** (the "Users can read" permission Windows normally gives `ProgramData` subfolders is removed)
- `%ProgramData%\Caretaker\agent.json` — token, hub URL, host id, pairing code
- `%ProgramData%\Caretaker\agent-cert.pem` / `agent-key.pem` — the agent's TLS identity
- `%ProgramData%\Caretaker\agent.log` — operational logs; unlock secrets are not logged (only `secretLen`)

## If you did not install this

1. Uninstall **Caretaker Agent** from Windows Apps, or `sc.exe stop CaretakerAgent` then `sc.exe delete CaretakerAgent` (or `caretaker-agent.exe setup --uninstall` / `uninstall` if the binary is still there).
2. Delete `%ProgramData%\Caretaker\`, `%ProgramFiles%\Caretaker\`, and any leftover `caretaker-agent*.exe` copies.
3. Assume the Windows PIN/password may have been typed over the network; consider changing it.
4. Check who had access to the LAN / Hub host.

## Warranty

Caretaker is provided **as is** under the [MIT License](LICENSE). Remote unlock can fail on Hello-only accounts, some Group Policy setups, and after Windows lock-screen changes. A failed or partial unlock can still count against Windows PIN lockout — that is why the agent rate-limits attempts.
