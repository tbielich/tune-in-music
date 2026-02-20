#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-<REPO_URL_PLACEHOLDER>}"
TARGET_DIR="/opt/tune-in-music"
ENGINE_ENV_FILE="/etc/default/tune-in-music-engine"
MPV_ENV_FILE="/etc/default/tune-in-music-mpv"
SERVICE_USER="${SERVICE_USER:-$(id -un)}"
SUDO_AS_USER=(sudo -H -u "$SERVICE_USER")

if [[ "$REPO_URL" == "<REPO_URL_PLACEHOLDER>" ]]; then
  echo "Please set REPO_URL in this script before running it."
  exit 1
fi

echo "[1/8] Installing dependencies"
sudo apt-get update
sudo apt-get install -y mpv yt-dlp git
if ! command -v node >/dev/null 2>&1; then
  sudo apt-get install -y nodejs
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is missing. Install a Node.js distribution that includes npm and rerun."
  exit 1
fi

echo "[2/8] Cloning/updating repository"
if [[ -d "$TARGET_DIR/.git" ]]; then
  sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$TARGET_DIR"
  "${SUDO_AS_USER[@]}" git -C "$TARGET_DIR" pull --ff-only
else
  sudo mkdir -p /opt
  sudo mkdir -p "$TARGET_DIR"
  sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$TARGET_DIR"
  "${SUDO_AS_USER[@]}" git clone "$REPO_URL" "$TARGET_DIR"
fi
sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$TARGET_DIR"

echo "[3/8] Installing engine dependencies and build"
"${SUDO_AS_USER[@]}" bash -lc "cd '$TARGET_DIR/engine' && npm ci && npm run build"

echo "[4/8] Installing systemd units"
sudo cp "$TARGET_DIR/deploy/systemd/tune-in-music-mpv.service" /etc/systemd/system/
sudo cp "$TARGET_DIR/deploy/systemd/tune-in-music-engine.service" /etc/systemd/system/
sudo sed -i "s/^User=.*/User=${SERVICE_USER}/" /etc/systemd/system/tune-in-music-mpv.service
sudo sed -i "s/^User=.*/User=${SERVICE_USER}/" /etc/systemd/system/tune-in-music-engine.service

echo "[5/8] Creating default env files"
if [[ ! -f "$ENGINE_ENV_FILE" ]]; then
  sudo tee "$ENGINE_ENV_FILE" >/dev/null <<'ENVEOF'
HOST=0.0.0.0
PORT=3030
TV_CHANNEL=overallTop10
TV_FORMAT=best[height<=480]
MPV_SOCKET=/tmp/mpv.sock
YTDLP_BIN=yt-dlp
MPV_BIN=mpv
ENABLE_MEDIA_KEYS=0
ENVEOF
fi

if [[ ! -f "$MPV_ENV_FILE" ]]; then
  sudo tee "$MPV_ENV_FILE" >/dev/null <<'ENVEOF'
# Optional output override, e.g. alsa/plughw:CARD=Headphones,DEV=0
MPV_AUDIO_DEVICE=
# Pin mpv KMS/DRM output to one connector, e.g. HDMI-A-1 or HDMI-A-2
MPV_DRM_CONNECTOR=HDMI-A-1
ENVEOF
fi

echo "[6/8] Reloading systemd"
sudo systemctl daemon-reload

echo "[7/8] Enabling services"
sudo systemctl enable tune-in-music-mpv tune-in-music-engine

echo "[8/8] Starting services"
sudo systemctl restart tune-in-music-mpv tune-in-music-engine
sudo systemctl --no-pager --full status tune-in-music-mpv tune-in-music-engine || true

echo "Install complete"
