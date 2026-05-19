import https from "node:https";
import { spawn } from "node:child_process";

import { logger } from "./logger";
import type { TrackInput } from "./channels";

export interface SpotifyResolveOptions {
  ytdlpBin: string;
  timeoutMs?: number;
}

function fetchHtml(url: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Spotify fetch timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; tune-in-music/1.0)",
          "Accept-Language": "en-US,en;q=0.8",
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(timer);
          fetchHtml(res.headers.location, timeoutMs).then(resolve, reject);
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          clearTimeout(timer);
          reject(new Error(`Spotify returned HTTP ${res.statusCode}`));
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
        res.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      },
    );

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function extractPlaylistId(url: string): string | undefined {
  const match = url.match(/\/playlist\/([A-Za-z0-9]+)/);
  return match?.[1];
}

function decodeSpotifyState(html: string): unknown {
  const scriptRegex = /<script[^>]*type="text\/plain"[^>]*>([^<]+)<\/script>/g;
  let match: RegExpExecArray | null;

  while ((match = scriptRegex.exec(html)) !== null) {
    const blob = match[1]?.trim();
    if (!blob) continue;

    const padding = "=".repeat((4 - (blob.length % 4)) % 4);
    try {
      const decoded = Buffer.from(blob + padding, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed === "object" && "entities" in parsed) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

interface SpotifyTrackData {
  name?: string;
  artists?: { items?: Array<{ profile?: { name?: string } }> };
}

function collectTracksFromState(state: unknown, playlistId: string): string[] {
  if (!state || typeof state !== "object") return [];

  const entities = (state as Record<string, unknown>).entities;
  if (!entities || typeof entities !== "object") return [];

  const items = (entities as Record<string, unknown>).items;
  if (!items || typeof items !== "object") return [];

  const playlistKey = `spotify:playlist:${playlistId}`;
  const playlist = (items as Record<string, unknown>)[playlistKey];
  if (!playlist || typeof playlist !== "object") return [];

  const content = (playlist as Record<string, unknown>).content;
  if (!content || typeof content !== "object") return [];

  const trackItems = (content as Record<string, unknown>).items;
  if (!Array.isArray(trackItems)) return [];

  const tracks: string[] = [];
  const seen = new Set<string>();

  for (const item of trackItems) {
    const data: SpotifyTrackData | undefined = item?.itemV2?.data;
    if (!data) continue;

    const title = (data.name ?? "").trim();
    if (!title) continue;

    const artistItems = data.artists?.items;
    const artist = artistItems?.[0]?.profile?.name?.trim() ?? "";

    const query = artist ? `${artist} - ${title}` : title;
    const key = query.toLowerCase();

    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push(query);
  }

  return tracks;
}

export async function fetchSpotifyPlaylistTracks(playlistUrl: string): Promise<string[]> {
  const playlistId = extractPlaylistId(playlistUrl);
  if (!playlistId) {
    throw new Error(`Invalid Spotify playlist URL: ${playlistUrl}`);
  }

  logger.info("spotify_fetch_start", { playlistId });

  const html = await fetchHtml(playlistUrl);
  const state = decodeSpotifyState(html);

  if (!state) {
    throw new Error("Could not decode Spotify state from playlist HTML");
  }

  const tracks = collectTracksFromState(state, playlistId);

  if (tracks.length === 0) {
    throw new Error("No tracks found in Spotify playlist");
  }

  logger.info("spotify_fetch_done", { playlistId, trackCount: tracks.length });
  return tracks;
}

export function searchYouTubeUrl(
  query: string,
  options: SpotifyResolveOptions,
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 20_000;

  return new Promise((resolve, reject) => {
    const args = [
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
      `ytsearch1:${query}`,
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
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error(`yt-dlp search timed out for: ${query}`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`yt-dlp search failed for: ${query}: ${stderr.trim()}`));
        return;
      }

      try {
        const payload = JSON.parse(stdout);
        const entries = payload.entries;
        const entry = Array.isArray(entries) && entries.length > 0 ? entries[0] : payload;

        const videoId = entry?.id;
        if (!videoId) {
          reject(new Error(`No YouTube result for: ${query}`));
          return;
        }

        resolve(`https://www.youtube.com/watch?v=${videoId}`);
      } catch {
        reject(new Error(`Failed to parse yt-dlp output for: ${query}`));
      }
    });
  });
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export async function resolveSpotifyPlaylist(
  playlistUrl: string,
  options: SpotifyResolveOptions,
): Promise<TrackInput[]> {
  const queries = await fetchSpotifyPlaylistTracks(playlistUrl);

  const tracks: TrackInput[] = [];

  for (const query of queries) {
    try {
      const youtubeUrl = await searchYouTubeUrl(query, options);
      tracks.push({
        id: slugify(query),
        label: query,
        input: youtubeUrl,
      });
      logger.info("spotify_track_resolved", { query, url: youtubeUrl });
    } catch (error) {
      logger.warn("spotify_track_resolve_failed", {
        query,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (tracks.length === 0) {
    throw new Error("Could not resolve any tracks from Spotify playlist");
  }

  logger.info("spotify_playlist_resolved", {
    total: queries.length,
    resolved: tracks.length,
  });

  return tracks;
}
