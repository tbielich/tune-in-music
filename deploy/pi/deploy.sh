#!/usr/bin/env bash
set -euo pipefail

SERVICE_USER="${SERVICE_USER:-$(id -un)}"

cd /opt/tune-in-music
git pull --ff-only

sudo cp /opt/tune-in-music/deploy/systemd/tune-in-music-mpv.service /etc/systemd/system/
sudo cp /opt/tune-in-music/deploy/systemd/tune-in-music-engine.service /etc/systemd/system/
sudo sed -i "s/^User=.*/User=${SERVICE_USER}/" /etc/systemd/system/tune-in-music-mpv.service
sudo sed -i "s/^User=.*/User=${SERVICE_USER}/" /etc/systemd/system/tune-in-music-engine.service

cd engine
npm ci
npm run build

sudo systemctl daemon-reload
sudo systemctl restart tune-in-music-mpv tune-in-music-engine

echo "Service status"
sudo systemctl --no-pager --full status tune-in-music-mpv tune-in-music-engine || true

echo "Health check (with retry)"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3030/health}"
HEALTH_MAX_ATTEMPTS="${HEALTH_MAX_ATTEMPTS:-30}"
HEALTH_RETRY_DELAY_SECONDS="${HEALTH_RETRY_DELAY_SECONDS:-1}"

health_ok=0
for attempt in $(seq 1 "$HEALTH_MAX_ATTEMPTS"); do
  if health_payload="$(curl -fsS "$HEALTH_URL" 2>/dev/null)"; then
    health_ok=1
    echo "Health check OK (${attempt}/${HEALTH_MAX_ATTEMPTS})"
    echo "$health_payload"
    break
  fi

  echo "Health not ready (${attempt}/${HEALTH_MAX_ATTEMPTS}), retry in ${HEALTH_RETRY_DELAY_SECONDS}s..."
  sleep "$HEALTH_RETRY_DELAY_SECONDS"
done

if [[ "$health_ok" -ne 1 ]]; then
  echo "Health check failed after ${HEALTH_MAX_ATTEMPTS} attempts: ${HEALTH_URL}" >&2
  echo "Service status (failure context)" >&2
  sudo systemctl --no-pager --full status tune-in-music-mpv tune-in-music-engine >&2 || true
  echo "Engine logs (tail)" >&2
  sudo journalctl -u tune-in-music-engine -n 60 --no-pager >&2 || true
  exit 1
fi
