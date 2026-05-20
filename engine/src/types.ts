import type { ChannelId, TrackInput } from "./channels";

export type EngineStatus =
  | "IDLE"
  | "RESOLVING_CURRENT"
  | "PLAYING"
  | "RESOLVING_NEXT"
  | "ERROR";

export interface ResolvedStream {
  url: string;
}

export interface NowPlaying {
  track: TrackInput;
  resolved?: ResolvedStream;
  startedAt?: string;
}

export interface PlaybackState {
  paused?: boolean;
  volume?: number;
  mute?: boolean;
  buffering?: boolean;
  duration?: number;
  position?: number;
}

export interface EngineState {
  status: EngineStatus;
  channelId: ChannelId;
  current?: NowPlaying;
  next?: NowPlaying;
  playback?: PlaybackState;
  lastError?: string;
  failStreak: number;
  updatedAt: string;
}
