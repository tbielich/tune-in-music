import type { ChannelDef, TrackInput } from "./channels";

export class ChannelPlayer {
  private tracks: TrackInput[];
  private cursor = 0;

  constructor(channel: ChannelDef) {
    this.tracks = channel.tracks;
  }

  setTracks(tracks: TrackInput[]): void {
    const currentId = this.tracks[this.cursor]?.id;
    this.tracks = tracks;

    // Try to keep cursor at the same track
    if (currentId) {
      const idx = tracks.findIndex((t) => t.id === currentId);
      if (idx >= 0) {
        this.cursor = idx;
        return;
      }
    }

    // Only reset if current track not found in new list
    if (this.cursor >= this.tracks.length) {
      this.cursor = 0;
    }
  }

  getTrackCount(): number {
    return this.tracks.length;
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
