# tune-in-music engine

Node.js + TypeScript engine for headless TV-like music playback with `mpv` IPC and `yt-dlp` stream resolving.

## Features

- Persistent `mpv` daemon via Unix IPC socket (`/tmp/mpv.sock`)
- Early resolving of YouTube links to direct stream URLs (`yt-dlp`)
- TV-smooth queue strategy:
  - `current` is playing
  - `next` is resolved and pre-queued via `append-play`
- Poll-based `mpv` state handling (no `observe_property`)
- JSON structured logging
- HTTP status + control endpoints for LAN/headless use

## Endpoints

- `GET /` HTML status page with auto refresh and buttons
- `GET /state` JSON engine state
- `GET /health` JSON health status (`200` when healthy, `503` on `ERROR`)
- `POST /skip` skip current track (`playlist-next force`)
- `POST /reload` reset playlist from channel start

## Local development (macOS)

### 1) Install runtime tools

```bash
brew install mpv yt-dlp
```

### 2) Start mpv IPC daemon

```bash
mpv --input-ipc-server=/tmp/mpv.sock --fullscreen
```

### 3) Run engine

```bash
cd engine
cp .env.example .env
npm install
npm run dev
```

Open:

```text
http://localhost:3030
```

## Production runtime

Environment values are loaded from process env and optional `.env` file in `engine/`.

Important vars:

- `HOST` (default `0.0.0.0`)
- `PORT` (default `3030`)
- `TV_CHANNEL` (default `overallTop10`)
- `TV_FORMAT` (default `best[height<=480]`)
- `MPV_SOCKET` (default `/tmp/mpv.sock`)
- `YTDLP_BIN` (default `yt-dlp`)
- `MPV_BIN` (default `mpv`)

## Build

```bash
cd engine
npm ci
npm run build
node dist/index.js
```
