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

export interface EngineState {
  status: EngineStatus;
  channelId: ChannelId;
  current?: NowPlaying;
  next?: NowPlaying;
  lastError?: string;
  failStreak: number;
  updatedAt: string;
}
