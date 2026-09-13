# Install Caretaker Hub on Unraid

Caretaker Hub belongs on your always-on NAS. Unraid is a good fit: host networking makes Wake-on-LAN and agent discovery work on the LAN.

Image: `ghcr.io/tru5t/caretaker-hub:latest`  
Template: [`caretaker-hub.xml`](caretaker-hub.xml)

> LAN-only. Do not port-forward 8080. See [SAFETY.md](../SAFETY.md).

## Quick install (template file)

1. On Unraid, open a terminal (or use the file browser) and save the template:

   ```bash
   mkdir -p /boot/config/plugins/dockerMan/templates-user
   curl -fsSL \
     -o /boot/config/plugins/dockerMan/templates-user/my-Caretaker-Hub.xml \
     https://raw.githubusercontent.com/TRU5T/caretaker/main/unraid/caretaker-hub.xml
   ```

2. **Docker** → **Add Container**.
3. Open the **Template** dropdown and choose **Caretaker-Hub** (user templates appear at the bottom).
4. Set:
   - **UI Password** — strong password (first boot only)
   - **Session Secret** — run `openssl rand -hex 32` on any machine and paste the result
   - Leave **Network Type** as **Host**
   - Leave Appdata at `/mnt/user/appdata/caretaker` unless you prefer another path
5. **Apply**. Open `http://<unraid-ip>:8080`.

Then on the Windows gaming PC: Hub → **Setup** → **Download installer** → run as Administrator → **Pair**.

## Install via template repository

1. **Settings → Docker** → enable Docker if needed.
2. Add this repository URL (exact path Unraid expects varies slightly by version; “Template repositories” is under Docker settings or Add Container → Template repositories):

   ```text
   https://raw.githubusercontent.com/TRU5T/caretaker/main/unraid/templates.xml
   ```

3. **Docker → Add Container** → select **Caretaker-Hub** → fill password + session secret → Apply.

## Why host networking?

| Feature | Needs |
|---------|--------|
| Wake-on-LAN | UDP broadcast on the LAN |
| Nearby PCs discovery | UDP **7843** from the agent |
| Agent HTTP | Hub reaches the PC on TCP **7842** |

Bridge mode often traps WoL broadcasts inside Docker’s virtual network. **Host** puts the Hub on Unraid’s LAN stack so those packets work.

## Ports (host network)

Nothing is “mapped”; the Hub binds on the Unraid host:

| Port | Use |
|------|-----|
| **8080** TCP | Web UI (change with `CARETAKER_PORT`) |
| **7843** UDP | Listens for unpaired agent beacons |

If 8080 is already taken (common), set **Web UI Port** to e.g. `18080`, then under **Advanced View** change **WebUI** to `http://[IP]:18080/`.

## Environment variables

| Variable | Required | Notes |
|----------|----------|--------|
| `CARETAKER_UI_PASSWORD` | yes | First config only |
| `CARETAKER_SESSION_SECRET` | yes | Keep stable after first set |
| `CARETAKER_PORT` | no | Default `8080` |
| `CARETAKER_DATA` | no | Keep `/data` with the Appdata mount |

## Update

**Docker → Caretaker-Hub → force update**, or pull `ghcr.io/tru5t/caretaker-hub:latest` and recreate. Appdata is preserved.

## Image not found?

The Hub image is published by GitHub Actions to GHCR on pushes to `main`. If pull fails:

1. Check [Packages on the repo](https://github.com/TRU5T/caretaker/pkgs/container/caretaker-hub)
2. Or build locally on Unraid (Compose plugin) from this repo:

   ```bash
   cd /mnt/user/appdata/caretaker-src   # after cloning the repo
   export CARETAKER_UI_PASSWORD='…'
   export CARETAKER_SESSION_SECRET="$(openssl rand -hex 32)"
   docker compose -f hub/docker-compose.yml up -d --build
   ```

   Compose already uses `network_mode: host` and mounts `../data`.
