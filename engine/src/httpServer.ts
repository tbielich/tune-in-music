import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { logger } from "./logger";
import type { EngineState } from "./types";

export interface HttpEngineController {
  getState: () => EngineState;
  skip: () => Promise<void>;
  reload: () => Promise<void>;
  togglePause: () => Promise<void>;
  volumeUp: () => Promise<void>;
  volumeDown: () => Promise<void>;
  setVolume: (vol: number) => Promise<void>;
  toggleMute: () => Promise<void>;
  changePlaylist: (url: string) => Promise<void>;
  getPlaylistUrl: () => string;
}

export interface HttpServerConfig {
  host: string;
  port: number;
}

interface UiAsset {
  filePath: string;
  contentType: string;
}

const UI_ROOT = path.resolve(process.cwd(), "ui");

const UI_ASSETS: Record<string, UiAsset> = {
  "/ui": {
    filePath: path.join(UI_ROOT, "index.html"),
    contentType: "text/html; charset=utf-8",
  },
  "/ui/style.css": {
    filePath: path.join(UI_ROOT, "style.css"),
    contentType: "text/css; charset=utf-8",
  },
  "/ui/app.js": {
    filePath: path.join(UI_ROOT, "app.js"),
    contentType: "application/javascript; charset=utf-8",
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function writeJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const content = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(content),
    "cache-control": "no-store",
  });
  res.end(content);
}

function writeContent(
  res: http.ServerResponse,
  statusCode: number,
  contentType: string,
  content: Buffer | string,
): void {
  const size = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, "utf8");
  res.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": size,
    "cache-control": "no-store",
  });
  res.end(content);
}

function renderHomeHtml(state: EngineState, playlistUrl: string): string {
  const status = state.status;
  const volume =
    typeof state.playback?.volume === "number" && Number.isFinite(state.playback.volume)
      ? Math.round(state.playback.volume)
      : 50;
  const playlistId = playlistUrl.match(/\/playlist\/([A-Za-z0-9]+)/)?.[1] ?? "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <title>tune-in-music</title>
    <style>
      :root {
        --bg: #0f0f1a;
        --surface: rgba(255,255,255,0.04);
        --surface-hover: rgba(255,255,255,0.08);
        --border: rgba(255,255,255,0.1);
        --text: #f0f0f0;
        --text-subtle: #888;
        --text-dim: #555;
        --accent: #64c8ff;
        --accent-bg: rgba(100,200,255,0.12);
        --radius: 12px;
        --radius-sm: 8px;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--bg); color: var(--text);
        min-height: 100dvh; padding: 16px;
        display: flex; flex-direction: column; gap: 14px;
        max-width: 420px; margin: 0 auto;
      }

      /* Now Playing Card — Common Region (Gestalt #6) */
      .now-playing {
        background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 14px;
        display: flex; flex-direction: column; align-items: center; gap: 10px;
      }
      .cover {
        width: 100%; border-radius: var(--radius-sm);
        aspect-ratio: 16/9; object-fit: cover; display: block;
      }
      .cover[src=""] { display: none; }
      .track-info { text-align: center; }
      .track-info .title { font-size: 1.1rem; font-weight: 600; line-height: 1.3; }
      .track-info .next { font-size: 0.8rem; color: var(--text-subtle); margin-top: 4px; }
      .track-info .meta { font-size: 0.7rem; color: var(--text-dim); margin-top: 2px; }

      /* Controls — Proximity (Gestalt #1): grouped tightly */
      .controls {
        display: flex; justify-content: center; align-items: center; gap: 12px;
      }
      .controls button {
        width: 56px; height: 56px;
        background: var(--surface); border: 1px solid var(--border);
        color: var(--text); border-radius: 50%;
        font-size: 1.3rem; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.12s, transform 0.1s;
        -webkit-tap-highlight-color: transparent;
      }
      .controls button:active { background: var(--surface-hover); transform: scale(0.92); }
      .controls button.primary {
        width: 64px; height: 64px; font-size: 1.5rem;
        background: var(--accent-bg); border-color: transparent;
        position: relative;
      }
      .controls button.primary::before {
        content: ''; position: absolute; inset: -3px;
        border-radius: 50%;
        background: conic-gradient(var(--accent) var(--progress, 0%), transparent var(--progress, 0%));
        z-index: -1;
      }
      .controls button.primary.loading::before {
        background: conic-gradient(#fff 25%, transparent 25%);
        animation: spin 1s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .controls button.active { background: var(--accent-bg); border-color: var(--accent); }

      /* Volume Slider — Continuity (Gestalt #4): horizontal flow */
      .volume-section {
        display: flex; align-items: center; gap: 10px; padding: 0 4px;
      }
      .volume-section .vol-icon { font-size: 1rem; cursor: pointer; padding: 4px; }
      .volume-section input[type=range] {
        flex: 1; height: 4px; -webkit-appearance: none; appearance: none;
        background: var(--border); border-radius: 2px; outline: none;
      }
      .volume-section input[type=range]::-webkit-slider-thumb {
        -webkit-appearance: none; width: 20px; height: 20px;
        background: var(--accent); border-radius: 50%; cursor: pointer;
      }
      .volume-section .vol-value {
        font-size: 0.75rem; color: var(--text-subtle); min-width: 32px; text-align: right;
      }

      /* Playlist Input — Common Region (Gestalt #6) */
      .playlist-section {
        display: flex; gap: 8px;
      }
      .playlist-section input {
        flex: 1; background: var(--surface); border: 1px solid var(--border);
        color: var(--text); border-radius: var(--radius-sm);
        padding: 10px 12px; font-size: 0.8rem; outline: none;
      }
      .playlist-section input:focus { border-color: var(--accent); }
      .playlist-section input::placeholder { color: var(--text-dim); }
      .playlist-section button {
        background: var(--accent-bg); border: 1px solid var(--accent);
        color: var(--accent); border-radius: var(--radius-sm);
        padding: 10px 14px; font-size: 0.8rem; font-weight: 500; cursor: pointer;
      }
      .playlist-section button:active { background: rgba(100,200,255,0.25); }

      /* Footer */
      .footer { text-align: center; font-size: 0.7rem; color: var(--text-dim); margin-top: auto; }
      .footer a { color: var(--text-subtle); text-decoration: none; }
    </style>
  </head>
  <body>

    <div class="now-playing">
      <img id="cover" class="cover" src="" alt="" />
      <div class="track-info">
        <div class="title" id="track">-</div>
        <div class="next" id="next">-</div>
        <div class="meta" id="meta">-</div>
      </div>
    </div>

    <div class="controls">
      <button id="btn-reload" aria-label="Reload">&#x21bb;</button>
      <button id="btn-pause" class="primary" aria-label="Play/Pause">&#x23f8;</button>
      <button id="btn-skip" aria-label="Skip">&#x23ed;</button>
    </div>

    <div class="volume-section">
      <span class="vol-icon" id="btn-mute">&#x266b;</span>
      <input type="range" id="vol-slider" min="0" max="100" value="${volume}" />
      <span class="vol-value" id="vol-label">${volume}%</span>
    </div>

    <div class="playlist-section">
      <input id="playlist-url" type="text" placeholder="Spotify Playlist-ID" value="${escapeHtml(playlistId)}" />
      <button id="btn-playlist">Laden</button>
    </div>

    <div class="footer">
      <a href="/state">API</a> &middot; <a href="/health">Health</a>
    </div>

    <script>
    (function() {
      var busy = false;
      var volTimeout = null;

      function post(path, body) {
        if (busy) return;
        busy = true;
        var opts = { method: 'POST' };
        if (body) {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = JSON.stringify(body);
        }
        fetch(path, opts)
          .then(function() { setTimeout(poll, 400); })
          .catch(function() {})
          .finally(function() { busy = false; });
      }

      function poll() {
        fetch('/state', { cache: 'no-store' })
          .then(function(r) { return r.json(); })
          .then(render)
          .catch(function() {});
      }

      function render(s) {
        var current = (s.current && s.current.track && s.current.track.label) || '-';
        var next = (s.next && s.next.track && s.next.track.label) || '-';
        var paused = s.playback && s.playback.paused === true;
        var muted = s.playback && s.playback.mute === true;
        var vol = (s.playback && typeof s.playback.volume === 'number') ? Math.round(s.playback.volume) : -1;

        var input = (s.current && s.current.track && s.current.track.input) || '';
        var vidMatch = input.match(/[?&]v=([A-Za-z0-9_-]+)/);
        var coverEl = document.getElementById('cover');
        if (vidMatch && vidMatch[1]) {
          var newSrc = 'https://img.youtube.com/vi/' + vidMatch[1] + '/mqdefault.jpg';
          if (coverEl.src !== newSrc) coverEl.src = newSrc;
        } else {
          coverEl.src = '';
        }

        document.getElementById('track').textContent = current;
        document.getElementById('next').textContent = 'Next: ' + next;
        document.getElementById('meta').textContent = s.channelId + ' \\u00b7 ' + s.status;

        var pauseBtn = document.getElementById('btn-pause');
        pauseBtn.textContent = paused ? '\\u25b6' : '\\u23f8';

        var isLoading = s.status === 'RESOLVING_CURRENT' || s.status === 'RESOLVING_NEXT' || s.status === 'IDLE';
        var progress = 0;
        if (s.playback && s.playback.duration > 0 && s.playback.position >= 0) {
          progress = Math.min(100, (s.playback.position / s.playback.duration) * 100);
        }
        pauseBtn.className = 'primary' + (paused ? ' active' : '') + (isLoading ? ' loading' : '');
        pauseBtn.style.setProperty('--progress', progress + '%');

        var muteIcon = document.getElementById('btn-mute');
        muteIcon.textContent = muted ? '\\u2715' : '\\u266b';

        if (vol >= 0) {
          document.getElementById('vol-slider').value = muted ? 0 : vol;
          document.getElementById('vol-label').textContent = muted ? '0%' : vol + '%';
        }
      }

      document.getElementById('btn-pause').onclick = function() { post('/toggle-pause'); };
      document.getElementById('btn-skip').onclick = function() { post('/skip'); };
      document.getElementById('btn-reload').onclick = function() { post('/reload'); };
      document.getElementById('btn-mute').onclick = function() { post('/toggle-mute'); };

      document.getElementById('vol-slider').oninput = function() {
        var val = this.value;
        document.getElementById('vol-label').textContent = val + '%';
        clearTimeout(volTimeout);
        volTimeout = setTimeout(function() {
          fetch('/set-volume', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ volume: Number(val) })
          });
        }, 150);
      };

      document.getElementById('btn-playlist').onclick = function() {
        var id = document.getElementById('playlist-url').value.trim();
        if (!id) return;
        post('/change-playlist', { url: 'https://open.spotify.com/playlist/' + id });
      };

      render(${JSON.stringify({ status, channelId: state.channelId, current: state.current, next: state.next, playback: state.playback })});
      setInterval(poll, 2000);
    })();
    </script>
  </body>
</html>`;
}

export function startHttpServer(
  config: HttpServerConfig,
  engine: HttpEngineController,
): http.Server {
  const loggedUiAssetPaths = new Set<string>();

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = parsedUrl.pathname;
      const normalizedPath = pathname === "/ui/" ? "/ui" : pathname;

      if (method === "GET" && normalizedPath in UI_ASSETS) {
        const asset = UI_ASSETS[normalizedPath];
        if (!asset) {
          writeJson(res, 404, { error: "UI asset not found" });
          return;
        }

        if (!loggedUiAssetPaths.has(normalizedPath)) {
          loggedUiAssetPaths.add(normalizedPath);
          logger.info("UI_STATIC_SERVE", { path: normalizedPath });
        }

        try {
          const content = await fs.readFile(asset.filePath);
          writeContent(res, 200, asset.contentType, content);
          return;
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code === "ENOENT") {
            writeJson(res, 404, { error: "UI asset not found" });
            return;
          }
          throw error;
        }
      }

      if (method === "GET" && pathname === "/") {
        const html = renderHomeHtml(engine.getState(), engine.getPlaylistUrl());
        writeContent(res, 200, "text/html; charset=utf-8", html);
        return;
      }

      if (method === "GET" && pathname === "/state") {
        writeJson(res, 200, engine.getState());
        return;
      }

      if (method === "GET" && pathname === "/health") {
        const state = engine.getState();
        const ok = state.status !== "ERROR";
        writeJson(res, ok ? 200 : 503, {
          ok,
          status: state.status,
          failStreak: state.failStreak,
          updatedAt: state.updatedAt,
          lastError: state.lastError,
        });
        return;
      }

      if (method === "POST" && pathname === "/skip") {
        await engine.skip();
        res.writeHead(303, { location: "/" });
        res.end();
        return;
      }

      if (method === "POST" && pathname === "/reload") {
        await engine.reload();
        res.writeHead(303, { location: "/" });
        res.end();
        return;
      }

      if (method === "POST" && pathname === "/toggle-pause") {
        await engine.togglePause();
        writeJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/vol-up") {
        await engine.volumeUp();
        writeJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/vol-down") {
        await engine.volumeDown();
        writeJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/set-volume") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }
        try {
          const parsed = JSON.parse(body);
          const vol = typeof parsed.volume === "number" ? parsed.volume : -1;
          if (vol < 0 || vol > 150) {
            writeJson(res, 400, { error: "Invalid volume" });
            return;
          }
          await engine.setVolume(vol);
          writeJson(res, 200, { ok: true });
        } catch {
          writeJson(res, 400, { error: "Invalid request" });
        }
        return;
      }

      if (method === "POST" && pathname === "/toggle-mute") {
        await engine.toggleMute();
        writeJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/change-playlist") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }
        try {
          const parsed = JSON.parse(body);
          const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
          if (!url || !url.includes("spotify.com/playlist/")) {
            writeJson(res, 400, { error: "Invalid Spotify playlist URL" });
            return;
          }
          await engine.changePlaylist(url);
          writeJson(res, 200, { ok: true, url });
        } catch (error) {
          writeJson(res, 500, { error: "Failed to change playlist" });
        }
        return;
      }

      writeJson(res, 404, { error: "Not found" });
    } catch (error) {
      logger.error("http_request_error", {
        error,
        method: req.method,
        path: req.url,
      });
      writeJson(res, 500, { error: "Internal server error" });
    }
  });

  server.listen(config.port, config.host, () => {
    logger.info("http_listen", {
      host: config.host,
      port: config.port,
    });
  });

  return server;
}
