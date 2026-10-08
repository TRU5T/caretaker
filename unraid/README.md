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
   - **UI Password** — strong password, 10+ characters (first boot only)
   - **Session Secret** — optional: paste the output of `openssl rand -hex 32`, or leave empty and the Hub generates one
   - Leave **Network Type** as **Host**
   - Leave Appdata at `/mnt/user/appdata/caretaker` unless you prefer another path
   - If **8080** is already in use, set **WebUI Port** and **CARETAKER_PORT** to the **same** free port (e.g. both `8060`)
5. **Apply**. Use the container’s **WebUI** button (or `http://<unraid-ip>:<port>`).

Then on the Windows gaming PC: Hub → **Setup** → **Download installer** → run as Administrator. Type the pairing code it shows into the Hub next to the PC under Nearby PCs → **Pair**.

## WebUI button opens the wrong port

Unraid’s WebUI link follows **WebUI Port**. The Hub listens on **CARETAKER_PORT**. Those two must match.

**Fix a container already on 8060:**

1. Docker → **Caretaker-Hub** → Edit  
2. Set **CARETAKER_PORT** = `8060`  
3. Toggle **Advanced View** → set **WebUI** to `http://[IP]:[PORT:8080]/`  
4. Add or edit a **Port** mapping: Container Port `8080`, Host Port `8060`, TCP  
   (host networking ignores the map for Docker, but Unraid uses Host Port for the WebUI button)  
5. **Apply**

Or the one-liner Advanced WebUI override: `http://[IP]:8060/`

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

If 8080 is already taken, set **WebUI Port** and **CARETAKER_PORT** to the **same** value (e.g. both `8060`). Do not change only one of them.

## Environment variables

| Variable | Required | Notes |
|----------|----------|--------|
| `CARETAKER_UI_PASSWORD` | yes | First config only; `changeme` if empty, and you must change it at first sign-in |
| `CARETAKER_SESSION_SECRET` | no | 32+ chars; auto-generated if empty. Keep stable after first set |
| `CARETAKER_UID` / `CARETAKER_GID` | no | Hub runs as this user (template: `99`/`100`) |
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
