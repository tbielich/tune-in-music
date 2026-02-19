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

echo "Health check"
curl -fsS http://127.0.0.1:3030/health || true
