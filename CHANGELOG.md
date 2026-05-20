# Changelog

## 1.0.0 (2026-05-20)

First production release — full Raspberry Pi music TV system with Spotify integration.

### Features

- **Spotify playlist as channel source** — set `TV_CHANNEL=spotify` and provide a `SPOTIFY_PLAYLIST_URL`. Tracks are resolved via yt-dlp YouTube search.
- **Lazy startup** — fetches Spotify track names (~1s), resolves first 2 tracks, starts playback immediately. Remaining tracks resolve in background.
- **Video download cache** — videos are downloaded to local storage for instant playback. LRU eviction when disk is full (configurable via `CACHE_MAX_SIZE`, default 20GB).
- **Instant startup from cache** — on reboot, cached tracks are loaded without any YouTube search. Playback starts in seconds.
- **Mobile remote UI** (`/`) — dark, touch-optimized control interface with:
  - Play/Pause, Skip, Reload buttons
  - Volume +/-, Mute toggle
  - YouTube thumbnail as cover art
  - Live state polling (2s interval)
  - Playlist ID input to switch Spotify playlists on the fly
- **Track title OSD** — current track name shown as mpv overlay for 8 seconds on each track change (font-size 28).
- **MTUI logo overlay** — displayed top-right on the video output.
- **QR code overlay** — Spotify playlist QR code displayed bottom-right on the video output.
- **TV static noise video** — shown during track transitions instead of black screen.
- **Boot splash** — ASCII art "TUNE IN MUSIC" displayed on console during boot.
- **VHS UI** (`/ui`) — retro CRT-styled browser overlay with noise, scanlines, color bars, and live status.

### Deployment

- Raspberry Pi OS Bookworm 64-bit
- mpv with `--vo=drm` direct rendering (no X11/Wayland needed)
- systemd services: `tune-in-music-mpv`, `tune-in-music-engine`
- Hardware video decoding (v4l2m2m)
- HDMI audio output pinned to correct port

### Configuration

Key environment variables (in `/etc/default/tune-in-music-engine`):

- `TV_CHANNEL=spotify`
- `SPOTIFY_PLAYLIST_URL=https://open.spotify.com/playlist/<ID>`
- `SPOTIFY_REFRESH_MINUTES=15`
- `CACHE_MAX_SIZE=20gb`
- `TV_FORMAT=best[height<=480]`

### Bug Fixes

- Fixed `loop-file=inf` leak from noise video causing single-track loop
- Fixed playlist cursor reset on error recovery (no more jumping back to track 1)
- Fixed `setTracks` preserving playback position when background resolution completes
- Fixed remote UI showing stale track info (now polls every 2s)
- Fixed mpv DRM connector selection (`card1`, `HDMI-A-2`)
- Fixed yt-dlp compatibility (Python 3.11 required for latest yt-dlp on Bullseye; Bookworm ships 3.11 natively)
