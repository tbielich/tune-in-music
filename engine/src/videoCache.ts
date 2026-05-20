import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { logger } from "./logger";

export interface VideoCacheOptions {
  cacheDir: string;
  maxSizeBytes: number;
  ytdlpBin: string;
  format: string;
}

interface CacheEntry {
  id: string;
  filePath: string;
  sizeBytes: number;
  lastPlayedAt: number;
  downloadedAt: number;
  youtubeUrl?: string;
}

const METADATA_FILE = "cache-meta.json";

export class VideoCache {
  private readonly cacheDir: string;
  private readonly maxSizeBytes: number;
  private readonly ytdlpBin: string;
  private readonly format: string;
  private entries: Map<string, CacheEntry> = new Map();
  private downloading: Set<string> = new Set();

  constructor(options: VideoCacheOptions) {
    this.cacheDir = options.cacheDir;
    this.maxSizeBytes = options.maxSizeBytes;
    this.ytdlpBin = options.ytdlpBin;
    this.format = options.format;

    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    this.loadMetadata();
    this.pruneOrphans();
  }

  /**
   * Returns local file path if cached, undefined otherwise.
   */
  get(trackId: string): string | undefined {
    const entry = this.entries.get(trackId);
    if (!entry) return undefined;

    if (!fs.existsSync(entry.filePath)) {
      this.entries.delete(trackId);
      this.saveMetadata();
      return undefined;
    }

    entry.lastPlayedAt = Date.now();
    this.saveMetadata();
    return entry.filePath;
  }

  /**
   * Check if a track is cached.
   */
  has(trackId: string): boolean {
    return this.get(trackId) !== undefined;
  }

  /**
   * Get the stored YouTube URL for a cached track.
   */
  getYoutubeUrl(trackId: string): string | undefined {
    return this.entries.get(trackId)?.youtubeUrl;
  }

  /**
   * Download a video to cache. Returns the local file path.
   */
  async download(trackId: string, youtubeUrl: string): Promise<string> {
    const existing = this.get(trackId);
    if (existing) return existing;

    if (this.downloading.has(trackId)) {
      // Wait for ongoing download
      return this.waitForDownload(trackId);
    }

    this.downloading.add(trackId);

    try {
      const filePath = path.join(this.cacheDir, `${trackId}.mp4`);

      await this.runYtdlp(youtubeUrl, filePath);

      const stat = fs.statSync(filePath);
      const entry: CacheEntry = {
        id: trackId,
        filePath,
        sizeBytes: stat.size,
        lastPlayedAt: Date.now(),
        downloadedAt: Date.now(),
        youtubeUrl,
      };

      this.entries.set(trackId, entry);
      this.saveMetadata();
      this.evictIfNeeded();

      logger.info("cache_download_done", {
        trackId,
        sizeMB: Math.round(stat.size / 1024 / 1024 * 10) / 10,
      });

      return filePath;
    } catch (error) {
      logger.warn("cache_download_failed", {
        trackId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.downloading.delete(trackId);
    }
  }

  /**
   * Download multiple tracks in the background (non-blocking).
   * Returns immediately.
   */
  downloadInBackground(tracks: Array<{ id: string; input: string }>): void {
    const pending = tracks.filter((t) => !this.has(t.id) && !this.downloading.has(t.id));

    if (pending.length === 0) return;

    logger.info("cache_background_start", { count: pending.length });

    void this.downloadSequential(pending);
  }

  /**
   * Get total cache size in bytes.
   */
  getTotalSize(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.sizeBytes;
    }
    return total;
  }

  getCacheStats(): { entries: number; sizeMB: number; maxMB: number } {
    return {
      entries: this.entries.size,
      sizeMB: Math.round(this.getTotalSize() / 1024 / 1024),
      maxMB: Math.round(this.maxSizeBytes / 1024 / 1024),
    };
  }

  private async downloadSequential(
    tracks: Array<{ id: string; input: string }>,
  ): Promise<void> {
    for (const track of tracks) {
      if (this.has(track.id)) continue;
      try {
        await this.download(track.id, track.input);
      } catch {
        // continue with next track
      }
    }

    logger.info("cache_background_done", this.getCacheStats());
  }

  private async waitForDownload(trackId: string): Promise<string> {
    const maxWait = 120_000;
    const pollInterval = 500;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      if (!this.downloading.has(trackId)) {
        const entry = this.entries.get(trackId);
        if (entry && fs.existsSync(entry.filePath)) {
          return entry.filePath;
        }
        throw new Error(`Download completed but file missing for ${trackId}`);
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(`Timed out waiting for download of ${trackId}`);
  }

  private runYtdlp(url: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        "--no-playlist",
        "--no-warnings",
        "-f", this.format,
        "--merge-output-format", "mp4",
        "-o", outputPath,
        url,
      ];

      const child = spawn(this.ytdlpBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 120_000);

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
          reject(new Error(`yt-dlp download timed out for ${url}`));
          return;
        }

        if (code !== 0) {
          reject(new Error(`yt-dlp download failed (code ${code}): ${stderr.trim()}`));
          return;
        }

        if (!fs.existsSync(outputPath)) {
          reject(new Error(`yt-dlp completed but output file missing: ${outputPath}`));
          return;
        }

        resolve();
      });
    });
  }

  private evictIfNeeded(): void {
    while (this.getTotalSize() > this.maxSizeBytes && this.entries.size > 1) {
      const oldest = this.findLeastRecentlyPlayed();
      if (!oldest) break;

      logger.info("cache_evict", {
        trackId: oldest.id,
        sizeMB: Math.round(oldest.sizeBytes / 1024 / 1024 * 10) / 10,
        lastPlayedAt: new Date(oldest.lastPlayedAt).toISOString(),
      });

      try {
        if (fs.existsSync(oldest.filePath)) {
          fs.unlinkSync(oldest.filePath);
        }
      } catch {
        // ignore
      }

      this.entries.delete(oldest.id);
    }

    this.saveMetadata();
  }

  private findLeastRecentlyPlayed(): CacheEntry | undefined {
    let oldest: CacheEntry | undefined;

    for (const entry of this.entries.values()) {
      if (!oldest || entry.lastPlayedAt < oldest.lastPlayedAt) {
        oldest = entry;
      }
    }

    return oldest;
  }

  private loadMetadata(): void {
    const metaPath = path.join(this.cacheDir, METADATA_FILE);
    if (!fs.existsSync(metaPath)) return;

    try {
      const raw = fs.readFileSync(metaPath, "utf8");
      const data = JSON.parse(raw) as CacheEntry[];
      for (const entry of data) {
        if (entry.id && entry.filePath) {
          this.entries.set(entry.id, entry);
        }
      }
    } catch {
      // start fresh
    }
  }

  private saveMetadata(): void {
    const metaPath = path.join(this.cacheDir, METADATA_FILE);
    const data = Array.from(this.entries.values());
    try {
      fs.writeFileSync(metaPath, JSON.stringify(data, null, 2), "utf8");
    } catch {
      // non-critical
    }
  }

  private pruneOrphans(): void {
    // Remove entries whose files no longer exist
    for (const [id, entry] of this.entries) {
      if (!fs.existsSync(entry.filePath)) {
        this.entries.delete(id);
      }
    }
    this.saveMetadata();
  }
}
