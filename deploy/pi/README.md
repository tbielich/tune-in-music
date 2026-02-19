# Raspberry Pi deployment

## One-time install

1. Edit `deploy/pi/install.sh` and replace `<REPO_URL_PLACEHOLDER>`.
2. Run:

```bash
chmod +x deploy/pi/install.sh
deploy/pi/install.sh
```

This will:

- install `mpv`, `yt-dlp`, `git`, `nodejs`, `npm`
- clone repo to `/opt/tune-in-music`
- build engine (`/opt/tune-in-music/engine/dist`)
- install systemd units
- create env files in `/etc/default`
- enable and start services

## Update deployment (git pull workflow)

```bash
chmod +x /opt/tune-in-music/deploy/pi/deploy.sh
/opt/tune-in-music/deploy/pi/deploy.sh
```

This runs:

- `git pull --ff-only`
- `npm ci`
- `npm run build`
- `systemctl restart tune-in-music-mpv tune-in-music-engine`
- status + `/health` check

## Runtime files

- Repo root: `/opt/tune-in-music`
- Engine dist: `/opt/tune-in-music/engine/dist`
- Engine env: `/etc/default/tune-in-music-engine`
- mpv env: `/etc/default/tune-in-music-mpv`
  - `MPV_DRM_CONNECTOR=HDMI-A-1` pins tune-in output to HDMI-1

## Useful commands

```bash
sudo journalctl -u tune-in-music-mpv -f
sudo journalctl -u tune-in-music-engine -f
curl -s http://127.0.0.1:3030/state | jq
curl -s http://127.0.0.1:3030/health
```
