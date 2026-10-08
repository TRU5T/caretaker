#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="${HOME}/.local/go/bin:${PATH}"
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w -buildid=" -o caretaker-agent.exe ./cmd/caretaker-agent
cp -f caretaker-agent.exe caretaker-agent-setup.exe
echo "built $(pwd)/caretaker-agent.exe"
echo "built $(pwd)/caretaker-agent-setup.exe"
sha256sum caretaker-agent-setup.exe 2>/dev/null || shasum -a 256 caretaker-agent-setup.exe
