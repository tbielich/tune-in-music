import http from "node:http";

import { logger } from "./logger";
import type { EngineState } from "./types";

export interface HttpEngineController {
  getState: () => EngineState;
  skip: () => Promise<void>;
  reload: () => Promise<void>;
}

export interface HttpServerConfig {
  host: string;
  port: number;
}

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

function renderHomeHtml(state: EngineState): string {
  const current = state.current?.track.label ?? "-";
  const next = state.next?.track.label ?? "-";
  const status = state.status;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="3" />
    <title>tune-in-music</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 20px; }
      .grid { display: grid; gap: 8px; max-width: 800px; }
      .actions { display: flex; gap: 8px; margin-top: 12px; }
      button { padding: 8px 14px; }
      pre { background: #f3f3f3; padding: 12px; overflow: auto; }
    </style>
  </head>
  <body>
    <h1>tune-in-music</h1>
    <div class="grid">
      <div><strong>Status:</strong> ${escapeHtml(status)}</div>
      <div><strong>Channel:</strong> ${escapeHtml(state.channelId)}</div>
      <div><strong>Current:</strong> ${escapeHtml(current)}</div>
      <div><strong>Next:</strong> ${escapeHtml(next)}</div>
      <div><strong>Fail streak:</strong> ${state.failStreak}</div>
      <div><strong>Updated:</strong> ${escapeHtml(state.updatedAt)}</div>
      <div><strong>Last error:</strong> ${escapeHtml(state.lastError ?? "-")}</div>
    </div>

    <div class="actions">
      <form method="post" action="/skip">
        <button type="submit">Skip</button>
      </form>
      <form method="post" action="/reload">
        <button type="submit">Reload</button>
      </form>
    </div>

    <h2>State JSON</h2>
    <pre>${escapeHtml(JSON.stringify(state, null, 2))}</pre>
  </body>
</html>`;
}

export function startHttpServer(
  config: HttpServerConfig,
  engine: HttpEngineController,
): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = parsedUrl.pathname;

      if (method === "GET" && pathname === "/") {
        const html = renderHomeHtml(engine.getState());
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html),
          "cache-control": "no-store",
        });
        res.end(html);
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
