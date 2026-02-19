import fs from "node:fs";
import path from "node:path";

import { ChannelPlayer } from "./channelPlayer";
import { channels, type ChannelId, type TrackInput } from "./channels";
import { startHttpServer } from "./httpServer";
import { logger } from "./logger";
import { MpvIpc } from "./mpvIpc";
import { StateStore, createInitialState, setState } from "./state";
import type { EngineState, NowPlaying, ResolvedStream } from "./types";
import { resolveStreamUrl } from "./ytdlp";

interface EngineConfig {
  host: string;
  port: number;
  channelId: ChannelId;
  format: string;
  mpvSocket: string;
  ytdlpBin: string;
  mpvBin: string;
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
  };
}

class Engine {
  private readonly stateStore: StateStore;
  private readonly channelPlayer: ChannelPlayer;
  private readonly mpv: MpvIpc;
  private pollTimer?: NodeJS.Timeout;
  private pollBusy = false;
  private reloadPromise?: Promise<void>;
  private retryTimer?: NodeJS.Timeout;

  constructor(private readonly config: EngineConfig) {
    this.stateStore = new StateStore(createInitialState(config.channelId));
    this.channelPlayer = new ChannelPlayer(channels[config.channelId]);
    this.mpv = new MpvIpc(config.mpvSocket);
  }

  getState(): EngineState {
    return this.stateStore.getState();
  }

  async start(): Promise<void> {
    if (channels[this.config.channelId].tracks.length === 0) {
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
    });

    await this.mpv.waitForSocketReady();
    await this.reload("startup");

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, 1_000);
  }

  async skip(): Promise<void> {
    logger.info("skip_requested");
    try {
      await this.mpv.playlistNext("force");
    } catch (error) {
      await this.handleFailure("skip_failed", error);
    }
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
        throw new Error("Channel is empty and cannot be played");
      }

      setState(this.stateStore, {
        status: "RESOLVING_CURRENT",
        current: { track: currentTrack },
        next: undefined,
      });

      const currentResolved = await this.resolveTrack(currentTrack, "current");
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

      logger.info("reload_complete", {
        reason,
        currentTrackId: currentTrack.id,
        nextTrackId: this.stateStore.getState().next?.track.id,
      });
    } catch (error) {
      await this.handleFailure("reload_failed", error);
      throw toError(error);
    }
  }

  private async poll(): Promise<void> {
    if (this.pollBusy) {
      return;
    }

    this.pollBusy = true;

    try {
      const [playlistPosRaw, playlistCountRaw] = await Promise.all([
        this.mpv.getProperty<number>("playlist-pos"),
        this.mpv.getProperty<number>("playlist-count"),
      ]);

      const playlistPos = Number.isFinite(playlistPosRaw) ? Number(playlistPosRaw) : 0;
      const playlistCount = Number.isFinite(playlistCountRaw) ? Number(playlistCountRaw) : 0;

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

  private async resolveTrack(
    track: TrackInput,
    slot: "current" | "next",
  ): Promise<ResolvedStream> {
    logger.info("resolve_start", {
      slot,
      trackId: track.id,
      input: track.input,
    });

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

    this.mpv.close();
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
