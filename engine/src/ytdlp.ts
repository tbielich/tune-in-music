import { spawn } from "node:child_process";

import type { ResolvedStream } from "./types";

export interface ResolveOptions {
  ytdlpBin: string;
  format: string;
  timeoutMs?: number;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

export function resolveStreamUrl(
  input: string,
  options: ResolveOptions,
): Promise<ResolvedStream> {
  const timeoutMs = options.timeoutMs ?? 15_000;

  return new Promise((resolve, reject) => {
    const args = [
      "--no-playlist",
      "--quiet",
      "-f",
      options.format,
      "--print",
      "url",
      input,
    ];

    const child = spawn(options.ytdlpBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(toError(error));
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error(`yt-dlp timed out after ${timeoutMs}ms for input ${input}`));
        return;
      }

      if (code !== 0) {
        reject(
          new Error(
            `yt-dlp exited with code ${String(code)} for input ${input}: ${stderr.trim()}`,
          ),
        );
        return;
      }

      const firstLine = stdout
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);

      if (!firstLine) {
        reject(new Error(`yt-dlp returned empty URL for input ${input}`));
        return;
      }

      resolve({ url: firstLine });
    });
  });
}
