# Security policy

## Supported versions

This project is pre-1.0 (`0.1.x`). Fixes land on `main`. There are no long-term support branches.

## How to report a vulnerability

**Do not open a public GitHub issue** for anything that could let a stranger wake, unlock, or sleep someone else's PC.

1. Use [GitHub private vulnerability reporting](https://github.com/TRU5T/caretaker/security/advisories/new) if it is enabled on this repository.
2. Otherwise, open a security advisory from the **Security** tab, or contact the maintainer via GitHub.

Please include:

- Affected commit / version (`caretaker-agent version`, hub `/api/health`)
- Whether the Hub was LAN-only or exposed
- Steps to reproduce, impact, and any patch you already have

You should hear back within a week. Please give a reasonable window before public disclosure.

## What is in scope

- Auth bypass on the Hub UI or agent bearer token
- Pairing as a stranger without Hub login (beyond the documented unpaired-LAN window)
- Unlock PIN/password ending up in logs, crash dumps, or hub config
- Remote code execution on Hub or agent
- Path traversal / config overwrite from untrusted input

## What is out of scope (documented behavior)

These are intentional or inherent; see [SAFETY.md](SAFETY.md):

- Wake-on-LAN with no authentication
- Plain HTTP on the LAN (no TLS in the Hub/agent themselves)
- Anyone who knows the Hub UI password controlling paired PCs
- Antivirus heuristic detections of the unsigned agent
- Leaving an **unpaired** agent reachable so another device on the LAN can `POST /pair`

## Hardening checklist

- Strong `CARETAKER_UI_PASSWORD` and `CARETAKER_SESSION_SECRET`
- Do not publish port 8080 or 7842
- Pair agents immediately; do not run unpaired on untrusted networks
- Reach the Hub over a VPN if you are away from home
- Install the agent from **your** Hub’s Setup download (built with the image) or from this source tree — not an unknown `.exe`
