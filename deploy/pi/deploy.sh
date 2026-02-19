#!/usr/bin/env bash
set -euo pipefail

cd /opt/tune-in-music
git pull --ff-only

cd engine
npm ci
npm run build

sudo systemctl daemon-reload
sudo systemctl restart tune-in-music-mpv tune-in-music-engine

echo "Service status"
sudo systemctl --no-pager --full status tune-in-music-mpv tune-in-music-engine || true

echo "Health check"
curl -fsS http://127.0.0.1:3030/health || true
