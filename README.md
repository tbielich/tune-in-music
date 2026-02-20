# tune-in-music

Music-TV setup for Raspberry Pi with:

- `mpv` daemon (JSON IPC via `/tmp/mpv.sock`)
- Node.js/TypeScript control engine
- `yt-dlp` stream resolving (no YouTube API)
- Headless LAN control via HTTP (`/`, `/ui`, `/state`, `/health`, `/skip`, `/reload`)

## Repository structure

- `engine/` TypeScript runtime engine
- `deploy/systemd/` systemd unit files
- `deploy/pi/` install and update scripts for Raspberry Pi

## Start here

- Engine documentation: `engine/README.md`
- Pi deployment documentation: `deploy/pi/README.md`

## UI

- On the Pi itself: `http://127.0.0.1:3030/ui`
- From another LAN device: `http://<PI-IP>:3030/ui` (e.g. `http://192.168.20.20:3030/ui`)
- JSON/status endpoints remain available at `/state` and `/health`

## Typical Pi setup

- tune-in playback on HDMI-1
- dashboard kiosk on HDMI-2
- configured via `/etc/default/tune-in-music-mpv`:
  - `MPV_DRM_CONNECTOR=HDMI-A-1`
  - `MPV_AUDIO_DEVICE=alsa/plughw:CARD=vc4hdmi0,DEV=0`

## Deployment workflow

One-time install on Pi:

```bash
REPO_URL=git@github.com:YOUR_USER/YOUR_REPO.git SERVICE_USER=pi deploy/pi/install.sh
```

Update deploy on Pi:

```bash
/opt/tune-in-music/deploy/pi/deploy.sh
```
