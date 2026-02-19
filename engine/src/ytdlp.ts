import { spawn } from "node:child_process";

import type { ResolvedStream } from "./types";

export interface ResolveOptions {
  ytdlpBin: string;
  format: string;
  timeoutMs?: number;
}

interface ResolveAttempt {
  format: string;
  extractorArgs?: string;
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
  const attempts = buildAttempts(options.format);
  return resolveWithAttempts(input, options, attempts);
}

async function resolveWithAttempts(
  input: string,
  options: ResolveOptions,
  attempts: ResolveAttempt[],
): Promise<ResolvedStream> {
  const errors: string[] = [];

  for (const attempt of attempts) {
    try {
      return await runAttempt(input, options, attempt);
    } catch (error) {
      errors.push(toError(error).message);
    }
  }

  throw new Error(
    `yt-dlp failed for input ${input} after ${attempts.length} attempts: ${errors.join(
      " | ",
    )}`,
  );
}

function buildAttempts(format: string): ResolveAttempt[] {
  const rawAttempts: ResolveAttempt[] = [
    { format },
    { format, extractorArgs: "youtube:player_client=android" },
    { format: "b" },
    { format: "b", extractorArgs: "youtube:player_client=android" },
  ];

  const deduped: ResolveAttempt[] = [];
  const seen = new Set<string>();

  for (const attempt of rawAttempts) {
    const key = `${attempt.format}|${attempt.extractorArgs ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(attempt);
  }

  return deduped;
}

function runAttempt(
  input: string,
  options: ResolveOptions,
  attempt: ResolveAttempt,
): Promise<ResolvedStream> {
  const timeoutMs = options.timeoutMs ?? 15_000;

  return new Promise((resolve, reject) => {
    const args = ["--no-playlist", "--quiet"];

    if (attempt.extractorArgs) {
      args.push("--extractor-args", attempt.extractorArgs);
    }

    args.push("-f", attempt.format, "--print", "url", input);

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

      const attemptLabel = `${attempt.format}${attempt.extractorArgs ? ` (${attempt.extractorArgs})` : ""}`;

      if (timedOut) {
        reject(
          new Error(
            `yt-dlp timed out after ${timeoutMs}ms for input ${input} using ${attemptLabel}`,
          ),
        );
        return;
      }

      if (code !== 0) {
        reject(
          new Error(
            `yt-dlp exited with code ${String(code)} for input ${input} using ${attemptLabel}: ${stderr.trim()}`,
          ),
        );
        return;
      }

      const firstLine = stdout
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);

      if (!firstLine) {
        reject(
          new Error(
            `yt-dlp returned empty URL for input ${input} using ${attemptLabel}: ${stderr.trim()}`,
          ),
        );
        return;
      }

      resolve({ url: firstLine });
    });
  });
}
