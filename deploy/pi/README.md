# Raspberry Pi deployment

## One-time install

Run:

```bash
chmod +x deploy/pi/install.sh
REPO_URL=git@github.com:YOUR_USER/YOUR_REPO.git SERVICE_USER=pi deploy/pi/install.sh
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
  - `ENABLE_MEDIA_KEYS=1` enables global media-key handling via `/dev/input/event*`
  - If service user group membership changed (e.g. added to `input`), reboot or re-login is required
- mpv env: `/etc/default/tune-in-music-mpv`
  - `MPV_DRM_CONNECTOR=HDMI-A-1` pins tune-in output to HDMI-1
  - `MPV_AUDIO_DEVICE=alsa/plughw:CARD=vc4hdmi0,DEV=0` pins audio to HDMI-1

## Useful commands

```bash
sudo journalctl -u tune-in-music-mpv -f
sudo journalctl -u tune-in-music-engine -f
curl -s http://127.0.0.1:3030/state | jq
curl -s http://127.0.0.1:3030/health
```

## Dual-display note

Typical setup:

- tune-in-music on HDMI-1 via `MPV_DRM_CONNECTOR=HDMI-A-1`
- dashboard kiosk on HDMI-2 (Weston output `HDMI-A-2`)
