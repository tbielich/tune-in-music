import fs from "node:fs";
import path from "node:path";

import { ChannelPlayer } from "./channelPlayer";
import { channels, type ChannelId, type TrackInput } from "./channels";
import { startHttpServer } from "./httpServer";
import { logger } from "./logger";
import { startMediaKeyListener } from "./mediaKeys";
import { MpvIpc } from "./mpvIpc";
import { resolveSpotifyPlaylist, type SpotifyResolveOptions } from "./spotify";
import { StateStore, createInitialState, setState } from "./state";
import type { EngineState, NowPlaying, PlaybackState, ResolvedStream } from "./types";
import { VideoCache } from "./videoCache";
import { resolveStreamUrl } from "./ytdlp";

interface EngineConfig {
  host: string;
  port: number;
  channelId: ChannelId;
  format: string;
  mpvSocket: string;
  ytdlpBin: string;
  mpvBin: string;
  enableMediaKeys: boolean;
  spotifyPlaylistUrl: string;
  spotifyRefreshMinutes: number;
  noiseVideoPath: string;
  cacheDir: string;
  cacheMaxSizeBytes: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseSizeBytes(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)\s*(gb|mb|kb|b)?$/);
  if (!match) return fallback;
  const num = Number.parseInt(match[1] ?? "0", 10);
  if (Number.isNaN(num) || num <= 0) return fallback;
  const unit = match[2] ?? "b";
  if (unit === "gb") return num * 1024 * 1024 * 1024;
  if (unit === "mb") return num * 1024 * 1024;
  if (unit === "kb") return num * 1024;
  return num;
}

function parseEnabledFlag(value: string | undefined, fallback = false): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readConfig(): EngineConfig {
  parseEnvFile(path.resolve(process.cwd(), ".env"));

  const channelId = (process.env.TV_CHANNEL ?? "overallTop10") as ChannelId;
  if (!(channelId in channels)) {
    throw new Error(`Unknown TV_CHANNEL: ${channelId}`);
  }

  return {
    host: process.env.HOST ?? "0.0.0.0",
    port: parsePort(process.env.PORT, 3030),
    channelId,
    format: process.env.TV_FORMAT ?? "best[height<=480]",
    mpvSocket: process.env.MPV_SOCKET ?? "/tmp/mpv.sock",
    ytdlpBin: process.env.YTDLP_BIN ?? "yt-dlp",
    mpvBin: process.env.MPV_BIN ?? "mpv",
    enableMediaKeys: parseEnabledFlag(process.env.ENABLE_MEDIA_KEYS, false),
    spotifyPlaylistUrl: process.env.SPOTIFY_PLAYLIST_URL ?? "",
    spotifyRefreshMinutes: parsePort(process.env.SPOTIFY_REFRESH_MINUTES, 15),
    noiseVideoPath: process.env.NOISE_VIDEO_PATH ?? path.resolve(process.cwd(), "static-noise.mp4"),
    cacheDir: process.env.CACHE_DIR ?? path.resolve(process.cwd(), "cache"),
    cacheMaxSizeBytes: parseSizeBytes(process.env.CACHE_MAX_SIZE, 20 * 1024 * 1024 * 1024),
  };
}

class Engine {
  private readonly stateStore: StateStore;
  private readonly channelPlayer: ChannelPlayer;
  private readonly mpv: MpvIpc;
  private readonly videoCache: VideoCache;
  private pollTimer?: NodeJS.Timeout;
  private pollBusy = false;
  private reloadPromise?: Promise<void>;
  private retryTimer?: NodeJS.Timeout;
  private stopMediaKeyListener?: () => void;
  private spotifyRefreshTimer?: NodeJS.Timeout;

  constructor(private readonly config: EngineConfig) {
    this.stateStore = new StateStore(createInitialState(config.channelId));
    this.channelPlayer = new ChannelPlayer(channels[config.channelId]);
    this.mpv = new MpvIpc(config.mpvSocket);
    this.videoCache = new VideoCache({
      cacheDir: config.cacheDir,
      maxSizeBytes: config.cacheMaxSizeBytes,
      ytdlpBin: config.ytdlpBin,
      format: config.format,
    });
  }

  getState(): EngineState {
    return this.stateStore.getState();
  }

  async start(): Promise<void> {
    if (this.config.channelId === "spotify" && this.config.spotifyPlaylistUrl) {
      await this.resolveSpotifyTracks();
    }

    if (this.channelPlayer.getTrackCount() === 0 && this.config.channelId !== "spotify") {
      throw new Error(`Channel ${this.config.channelId} has no tracks`);
    }

    logger.info("engine_start", {
      channelId: this.config.channelId,
      host: this.config.host,
      port: this.config.port,
      format: this.config.format,
      mpvSocket: this.config.mpvSocket,
      mpvBin: this.config.mpvBin,
      ytdlpBin: this.config.ytdlpBin,
      enableMediaKeys: this.config.enableMediaKeys,
      spotifyPlaylistUrl: this.config.spotifyPlaylistUrl || undefined,
      trackCount: this.channelPlayer.getTrackCount(),
    });

    try {
      await this.mpv.waitForSocketReady();
      await this.reload("startup");
    } catch (error) {
      await this.handleFailure("startup_failed", error);
    }

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, 1_000);

    if (this.config.enableMediaKeys) {
      this.startMediaKeys();
    }

    if (this.config.channelId === "spotify" && this.config.spotifyPlaylistUrl) {
      const refreshMs = this.config.spotifyRefreshMinutes * 60 * 1_000;
      this.spotifyRefreshTimer = setInterval(() => {
        void this.refreshSpotifyTracks();
      }, refreshMs);
    }
  }

  async skip(): Promise<void> {
    logger.info("skip_requested");
    try {
      await this.mpv.playlistNext(true);
    } catch (error) {
      await this.handleFailure("skip_failed", error);
    }
  }

  async togglePause(): Promise<void> {
    await this.mpv.togglePause();
    await this.refreshPlaybackState();
  }

  async volumeUp(): Promise<void> {
    await this.mpv.addVolume(5);
    await this.refreshPlaybackState();
  }

  async volumeDown(): Promise<void> {
    await this.mpv.addVolume(-5);
    await this.refreshPlaybackState();
  }

  async toggleMute(): Promise<void> {
    await this.mpv.toggleMute();
    await this.refreshPlaybackState();
  }

  async reload(reason = "manual"): Promise<void> {
    if (this.reloadPromise) {
      return this.reloadPromise;
    }

    this.reloadPromise = this.doReload(reason).finally(() => {
      this.reloadPromise = undefined;
    });

    return this.reloadPromise;
  }

  private async doReload(reason: string): Promise<void> {
    logger.info("reload_start", { reason });

    try {
      this.channelPlayer.reset();

      const currentTrack = this.channelPlayer.getCurrentTrack();
      if (!currentTrack) {
        logger.warn("reload_skipped_no_tracks", { reason });
        return;
      }

      await this.showNoise();

      setState(this.stateStore, {
        status: "RESOLVING_CURRENT",
        current: { track: currentTrack },
        next: undefined,
      });

      const currentResolved = await this.resolveTrack(currentTrack, "current");
      await this.mpv.setProperty("loop-file", "no");
      await this.mpv.loadReplace(currentResolved.url);

      setState(this.stateStore, {
        status: "PLAYING",
        current: {
          track: currentTrack,
          resolved: currentResolved,
          startedAt: nowIso(),
        },
        next: undefined,
        failStreak: 0,
        lastError: undefined,
      });

      await this.resolveAndQueueNext();
      await this.refreshPlaybackState();
      await this.showTrackOsd(currentTrack);

      logger.info("reload_complete", {
        reason,
        currentTrackId: currentTrack.id,
        nextTrackId: this.stateStore.getState().next?.track.id,
      });
    } catch (error) {
      await this.handleFailure("reload_failed", error);
    }
  }

  private async poll(): Promise<void> {
    if (this.pollBusy) {
      return;
    }

    this.pollBusy = true;

    try {
      const [playlistPosRaw, playlistCountRaw, pausedForCacheRaw] = await Promise.all([
        this.mpv.getProperty<number>("playlist-pos"),
        this.mpv.getProperty<number>("playlist-count"),
        this.mpv.getProperty<unknown>("paused-for-cache"),
      ]);

      const playlistPos = Number.isFinite(playlistPosRaw) ? Number(playlistPosRaw) : 0;
      const playlistCount = Number.isFinite(playlistCountRaw) ? Number(playlistCountRaw) : 0;
      const buffering = pausedForCacheRaw === true;
      this.setPlaybackPatch({ buffering });

      if (playlistPos > 0) {
        logger.info("playlist_pos_advanced", { playlistPos, playlistCount });

        for (let index = 0; index < playlistPos; index += 1) {
          await this.handlePlaylistAdvance();
        }

        for (let index = 0; index < playlistPos; index += 1) {
          await this.mpv.removePlaylistIndex(0);
        }
      } else if (playlistCount <= 1 && this.stateStore.getState().status === "PLAYING") {
        logger.warn("playlist_missing_next", { playlistCount });
        await this.resolveAndQueueNext();
      }
    } catch (error) {
      await this.handleFailure("poll_failed", error);
    } finally {
      this.pollBusy = false;
    }
  }

  private async handlePlaylistAdvance(): Promise<void> {
    this.channelPlayer.advance();

    const state = this.stateStore.getState();
    const track = this.channelPlayer.getCurrentTrack();

    if (!track) {
      throw new Error("No current track after advance");
    }

    const currentFromQueuedNext: NowPlaying | undefined =
      state.next && state.next.track.id === track.id
        ? {
            ...state.next,
            startedAt: nowIso(),
          }
        : undefined;

    setState(this.stateStore, {
      status: "PLAYING",
      current: currentFromQueuedNext ?? {
        track,
        startedAt: nowIso(),
      },
    });

    await this.resolveAndQueueNext();
    await this.showTrackOsd(track);
  }

  private async resolveAndQueueNext(): Promise<void> {
    const nextTrack = this.channelPlayer.getNextTrack();

    if (!nextTrack) {
      setState(this.stateStore, {
        status: "PLAYING",
        next: undefined,
      });
      return;
    }

    setState(this.stateStore, {
      status: "RESOLVING_NEXT",
      next: {
        track: nextTrack,
      },
    });

    const nextResolved = await this.resolveTrack(nextTrack, "next");
    await this.mpv.appendPlay(nextResolved.url);

    setState(this.stateStore, {
      status: "PLAYING",
      next: {
        track: nextTrack,
        resolved: nextResolved,
      },
      failStreak: 0,
      lastError: undefined,
    });

    logger.info("next_queued", {
      trackId: nextTrack.id,
      url: nextResolved.url,
    });
  }

  private async showNoise(): Promise<void> {
    if (!fs.existsSync(this.config.noiseVideoPath)) {
      return;
    }
    try {
      await this.mpv.loadReplace(this.config.noiseVideoPath);
      await this.mpv.setProperty("loop-file", "inf");
    } catch {
      // best-effort, don't fail if noise can't be shown
    }
  }

  private async showTrackOsd(track: TrackInput): Promise<void> {
    try {
      await this.mpv.showOsd(track.label, 8000);
    } catch {
      // non-critical
    }
  }

  private async resolveTrack(
    track: TrackInput,
    slot: "current" | "next",
  ): Promise<ResolvedStream> {
    logger.info("resolve_start", {
      slot,
      trackId: track.id,
      input: track.input,
    });

    // Try local cache first
    const cached = this.videoCache.get(track.id);
    if (cached) {
      logger.info("resolve_from_cache", { slot, trackId: track.id });
      return { url: cached };
    }

    // Try downloading to cache
    try {
      const localPath = await this.videoCache.download(track.id, track.input);
      logger.info("resolve_downloaded", { slot, trackId: track.id });
      return { url: localPath };
    } catch (error) {
      logger.warn("cache_download_fallback_to_stream", {
        slot,
        trackId: track.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Fallback: resolve stream URL (no cache)
    const resolved = await resolveStreamUrl(track.input, {
      ytdlpBin: this.config.ytdlpBin,
      format: this.config.format,
      timeoutMs: 15_000,
    });

    logger.info("resolve_done", {
      slot,
      trackId: track.id,
    });

    return resolved;
  }

  private startMediaKeys(): void {
    try {
      this.stopMediaKeyListener = startMediaKeyListener({
        onTogglePause: () =>
          this.runMediaKeyAction("TOGGLE_PAUSE", () => this.mpv.togglePause(), true),
        onNext: () => this.runMediaKeyAction("NEXT", () => this.mpv.playlistNext(true)),
        onPrev: () => this.runMediaKeyAction("PREV", () => this.mpv.playlistPrev(true)),
        onReload: () => this.runMediaKeyAction("RELOAD", () => this.reload("media_key_reload")),
        onVolUp: () => this.runMediaKeyAction("VOL_UP", () => this.mpv.addVolume(5), true),
        onVolDown: () =>
          this.runMediaKeyAction("VOL_DOWN", () => this.mpv.addVolume(-5), true),
        onToggleMute: () =>
          this.runMediaKeyAction("TOGGLE_MUTE", () => this.mpv.toggleMute(), true),
      });
    } catch (error) {
      logger.warn("media_key_listener_start_failed", {
        error: toError(error),
      });
    }
  }

  private async runMediaKeyAction(
    action: string,
    run: () => Promise<void>,
    refreshPlaybackState = false,
  ): Promise<void> {
    try {
      await run();
      if (refreshPlaybackState) {
        await this.refreshPlaybackState();
      }
    } catch (error) {
      logger.warn("media_key_action_failed", {
        action,
        error: toError(error),
      });
    }
  }

  private async refreshPlaybackState(): Promise<void> {
    try {
      const [pausedRaw, volumeRaw, muteRaw] = await Promise.all([
        this.mpv.getProperty<unknown>("pause"),
        this.mpv.getProperty<unknown>("volume"),
        this.mpv.getProperty<unknown>("mute"),
      ]);

      const playback: PlaybackState = {};
      let hasPlaybackValue = false;

      if (typeof pausedRaw === "boolean") {
        playback.paused = pausedRaw;
        hasPlaybackValue = true;
      }

      if (typeof volumeRaw === "number" && Number.isFinite(volumeRaw)) {
        playback.volume = volumeRaw;
        hasPlaybackValue = true;
      }

      if (typeof muteRaw === "boolean") {
        playback.mute = muteRaw;
        hasPlaybackValue = true;
      }

      if (!hasPlaybackValue) {
        return;
      }

      this.setPlaybackPatch(playback);
    } catch (error) {
      logger.warn("playback_state_refresh_failed", {
        error: toError(error),
      });
    }
  }

  private setPlaybackPatch(patch: Partial<PlaybackState>): void {
    setState(this.stateStore, (previous) => ({
      playback: {
        ...(previous.playback ?? {}),
        ...patch,
      },
    }));
  }

  private async handleFailure(event: string, error: unknown): Promise<void> {
    const err = toError(error);
    const nextFailStreak = this.stateStore.getState().failStreak + 1;

    setState(this.stateStore, (previous) => ({
      failStreak: nextFailStreak,
      lastError: err.message,
      status: nextFailStreak > 3 ? "ERROR" : previous.status,
    }));

    logger.error(event, {
      error: err,
      failStreak: nextFailStreak,
    });

    if (this.retryTimer) {
      return;
    }

    if (nextFailStreak <= 3) {
      const delayMs = nextFailStreak * 1_000;
      logger.warn("engine_retry_scheduled", {
        delayMs,
        failStreak: nextFailStreak,
      });

      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.reload("retry");
      }, delayMs);
      return;
    }

    const backoffMs = 30_000;
    logger.warn("engine_backoff_scheduled", {
      delayMs: backoffMs,
      failStreak: nextFailStreak,
    });

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.reload("backoff-recovery");
    }, backoffMs);

    await sleep(10);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }

    if (this.spotifyRefreshTimer) {
      clearInterval(this.spotifyRefreshTimer);
      this.spotifyRefreshTimer = undefined;
    }

    if (this.stopMediaKeyListener) {
      this.stopMediaKeyListener();
      this.stopMediaKeyListener = undefined;
    }

    this.mpv.close();
  }

  private async resolveSpotifyTracks(): Promise<void> {
    const options: SpotifyResolveOptions = {
      ytdlpBin: this.config.ytdlpBin,
      timeoutMs: 20_000,
    };

    const tracks = await resolveSpotifyPlaylist(
      this.config.spotifyPlaylistUrl,
      options,
    );

    this.channelPlayer.setTracks(tracks);

    // Start background download of all tracks
    this.videoCache.downloadInBackground(tracks);
  }

  private async refreshSpotifyTracks(): Promise<void> {
    try {
      logger.info("spotify_refresh_start");
      const options: SpotifyResolveOptions = {
        ytdlpBin: this.config.ytdlpBin,
        timeoutMs: 20_000,
      };

      const tracks = await resolveSpotifyPlaylist(
        this.config.spotifyPlaylistUrl,
        options,
      );

      this.channelPlayer.setTracks(tracks);
      logger.info("spotify_refresh_done", { trackCount: tracks.length });
    } catch (error) {
      logger.warn("spotify_refresh_failed", {
        error: toError(error),
      });
    }
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const engine = new Engine(config);

  startHttpServer(
    {
      host: config.host,
      port: config.port,
    },
    {
      getState: () => engine.getState(),
      skip: () => engine.skip(),
      reload: () => engine.reload(),
      togglePause: () => engine.togglePause(),
      volumeUp: () => engine.volumeUp(),
      volumeDown: () => engine.volumeDown(),
      toggleMute: () => engine.toggleMute(),
    },
  );

  process.on("SIGINT", () => {
    logger.info("signal_received", { signal: "SIGINT" });
    engine.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    logger.info("signal_received", { signal: "SIGTERM" });
    engine.stop();
    process.exit(0);
  });

  await engine.start();
}

void main().catch((error) => {
  logger.error("engine_fatal", { error: toError(error) });
  process.exit(1);
});
