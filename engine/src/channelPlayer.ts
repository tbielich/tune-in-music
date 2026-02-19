import type { ChannelDef, TrackInput } from "./channels";

export class ChannelPlayer {
  private readonly tracks: TrackInput[];
  private cursor = 0;

  constructor(channel: ChannelDef) {
    this.tracks = channel.tracks;
  }

  getCurrentTrack(): TrackInput | undefined {
    if (this.tracks.length === 0) {
      return undefined;
    }
    return this.tracks[this.cursor];
  }

  getNextTrack(): TrackInput | undefined {
    if (this.tracks.length === 0) {
      return undefined;
    }
    const nextIndex = (this.cursor + 1) % this.tracks.length;
    return this.tracks[nextIndex];
  }

  advance(): TrackInput | undefined {
    if (this.tracks.length === 0) {
      return undefined;
    }
    this.cursor = (this.cursor + 1) % this.tracks.length;
    return this.tracks[this.cursor];
  }

  reset(): void {
    this.cursor = 0;
  }
}
