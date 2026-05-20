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
  const current = state.current?.track.label ?? "-";
  const next = state.next?.track.label ?? "-";
  const status = state.status;
  const paused = state.playback?.paused === true;
  const muted = state.playback?.mute === true;
  const volume =
    typeof state.playback?.volume === "number" && Number.isFinite(state.playback.volume)
      ? Math.round(state.playback.volume)
      : -1;
  const playlistId = playlistUrl.match(/\/playlist\/([A-Za-z0-9]+)/)?.[1] ?? "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
    <title>tune-in-music remote</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #1a1a2e; color: #eee;
        min-height: 100dvh; padding: 16px;
        display: flex; flex-direction: column; gap: 16px;
      }
      .now-playing {
        text-align: center; padding: 12px;
        background: rgba(255,255,255,0.05); border-radius: 12px;
      }
      .now-playing .cover { width: 100%; max-width: 320px; border-radius: 8px; margin: 0 auto 8px; display: block; aspect-ratio: 16/9; object-fit: cover; }
      .now-playing .cover[src=""] { display: none; }
      .now-playing .track { font-size: 1.2rem; font-weight: 600; margin: 4px 0; }
      .now-playing .meta { font-size: 0.8rem; color: #999; }
      .next { font-size: 0.85rem; color: #777; text-align: center; }
      .controls {
        display: grid; grid-template-columns: 1fr 1fr 1fr;
        gap: 10px; max-width: 400px; margin: 0 auto; width: 100%;
      }
      .controls button {
        background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15);
        color: #eee; border-radius: 12px; padding: 16px 8px;
        font-size: 1.4rem; cursor: pointer; transition: background 0.15s;
        -webkit-tap-highlight-color: transparent;
      }
      .controls button:active { background: rgba(255,255,255,0.25); }
      .controls button.active { background: rgba(100,200,255,0.2); border-color: rgba(100,200,255,0.4); }
      .volume-row { display: flex; align-items: center; justify-content: center; gap: 12px; }
      .volume-row .vol-label { font-size: 0.9rem; min-width: 40px; text-align: center; }
      .playlist-input {
        display: flex; gap: 8px; max-width: 400px; margin: 0 auto; width: 100%;
      }
      .playlist-input input {
        flex: 1; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);
        color: #eee; border-radius: 8px; padding: 10px 12px; font-size: 0.8rem;
      }
      .playlist-input input::placeholder { color: #666; }
      .playlist-input button {
        background: rgba(100,200,255,0.15); border: 1px solid rgba(100,200,255,0.3);
        color: #eee; border-radius: 8px; padding: 10px 14px; font-size: 0.8rem; cursor: pointer;
      }
      .playlist-input button:active { background: rgba(100,200,255,0.3); }
      .status-bar {
        text-align: center; font-size: 0.75rem; color: #666; margin-top: auto;
      }
      .status-bar a { color: #888; }
    </style>
  </head>
  <body>
    <div class="now-playing">
      <img id="cover" class="cover" src="" alt="" />
      <div class="meta" id="meta"></div>
      <div class="track" id="track"></div>
    </div>
    <div class="next" id="next"></div>

    <div class="controls">
      <button id="btn-vol-down" aria-label="Volume down">🔉</button>
      <button id="btn-pause" aria-label="Play/Pause">⏸️</button>
      <button id="btn-vol-up" aria-label="Volume up">🔊</button>

      <button id="btn-skip" aria-label="Skip">⏭️</button>
      <button id="btn-mute" aria-label="Mute">🔈</button>
      <button id="btn-reload" aria-label="Reload">🔄</button>
    </div>

    <div class="volume-row">
      <span class="vol-label" id="vol-label">-</span>
    </div>

    <div class="playlist-input">
      <input id="playlist-url" type="text" placeholder="Playlist-ID eingeben..." value="${escapeHtml(playlistId)}" />
      <button id="btn-playlist">Laden</button>
    </div>

    <div class="status-bar">
      <a href="/ui">VHS UI</a> &middot; <a href="/state">JSON</a>
    </div>

    <script>
    (function() {
      var busy = false;

      function post(path) {
        if (busy) return;
        busy = true;
        fetch(path, { method: 'POST' })
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

        // Extract YouTube video ID for thumbnail
        var input = (s.current && s.current.track && s.current.track.input) || '';
        var vidMatch = input.match(/[?&]v=([A-Za-z0-9_-]+)/);
        var coverEl = document.getElementById('cover');
        if (vidMatch && vidMatch[1]) {
          coverEl.src = 'https://img.youtube.com/vi/' + vidMatch[1] + '/mqdefault.jpg';
        } else {
          coverEl.src = '';
        }

        document.getElementById('meta').textContent = s.channelId + ' \\u00b7 ' + s.status;
        document.getElementById('track').textContent = current;
        document.getElementById('next').textContent = 'Next: ' + next;
        document.getElementById('vol-label').textContent = vol >= 0 ? vol + '%' : '-';

        var pauseBtn = document.getElementById('btn-pause');
        pauseBtn.textContent = paused ? '\\u25b6\\ufe0f' : '\\u23f8\\ufe0f';
        pauseBtn.className = paused ? 'active' : '';

        var muteBtn = document.getElementById('btn-mute');
        muteBtn.textContent = muted ? '\\ud83d\\udd07' : '\\ud83d\\udd08';
        muteBtn.className = muted ? 'active' : '';
      }

      document.getElementById('btn-vol-down').onclick = function() { post('/vol-down'); };
      document.getElementById('btn-vol-up').onclick = function() { post('/vol-up'); };
      document.getElementById('btn-pause').onclick = function() { post('/toggle-pause'); };
      document.getElementById('btn-skip').onclick = function() { post('/skip'); };
      document.getElementById('btn-mute').onclick = function() { post('/toggle-mute'); };
      document.getElementById('btn-reload').onclick = function() { post('/reload'); };
      document.getElementById('btn-playlist').onclick = function() {
        var id = document.getElementById('playlist-url').value.trim();
        if (!id) return;
        var url = 'https://open.spotify.com/playlist/' + id;
        fetch('/change-playlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url })
        }).then(function() { setTimeout(poll, 1000); });
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
