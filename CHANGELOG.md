# Changelog

## 2.0.0 (2026-05-20)

Redesigned remote UI, video caching, and Spotify playlist switching.

### Remote UI (redesigned)

- Unified dark mobile-first interface at `/` — replaces the old status page
- Controls: ↻ Reload, ⏸ Pause, ⏭ Skip — circular buttons, Pause visually dominant (Gestalt Focal Point)
- Volume slider with mute toggle — slider jumps to 0 on mute (Gestalt Continuity)
- Progress ring around Play button — blue outline fills as track plays, white spinner during loading
- YouTube thumbnail as cover art above track title
- Playlist-ID input — enter a Spotify playlist ID and tap "Laden" to switch playlists live
- Live state polling every 2 seconds — no page reloads needed
- Plain Unicode symbols instead of emojis for consistent cross-device rendering
- Design follows Gestalt principles (Proximity, Similarity, Common Region, Focal Point, Continuity) and Nielsen usability heuristics (Visibility of System Status, User Control)

### Video Download Cache

- Videos are downloaded to `/opt/tune-in-music/engine/cache/` for instant local playback
- LRU eviction: least-recently-played videos are deleted when disk is full
- Configurable max size via `CACHE_MAX_SIZE` (default `20gb`)
- YouTube URL stored in cache metadata for thumbnail display
- Fallback to streaming if download fails

### Lazy Spotify Resolution

- Playlist track names fetched in ~1 second (single HTTP request to Spotify)
- Cached tracks loaded instantly — no YouTube search needed on restart
- First 2 uncached tracks resolved immediately, rest in background
- `setTracks` preserves playback cursor — no jumping back to track 1

### Playlist Switching

- `POST /change-playlist` accepts a new Spotify playlist URL
- Remote UI input field for playlist ID — switch playlists without SSH
- Engine re-resolves tracks and starts playback of new playlist

### OSD Overlays (mpv)

- Track title shown as OSD text for 8 seconds on each track change (font-size 28)
- MTUI logo overlay top-right (16px margin)
- QR code overlay bottom-right linking to Spotify playlist (16px margin)
- TV static noise video during track transitions (instead of black screen)

### Boot Experience

- ASCII art "TUNE IN MUSIC" splash on console during boot
- getty disabled on tty1 — no login prompt on TV
- Kernel boot messages suppressed (`loglevel=0`, cursor hidden)

### Deployment (Raspberry Pi OS Bookworm 64-bit)

- Fresh install on Pi 4 with `--vo=drm --drm-device=/dev/dri/card1 --drm-connector=HDMI-A-2`
- Hardware video decoding (v4l2m2m)
- HDMI audio pinned to `alsa/hdmi:CARD=vc4hdmi1,DEV=0`
- yt-dlp 2026.03.17 (via pip, Python 3.11 native on Bookworm)
- Node.js v20.18.1 (arm64 binary)

### Bug Fixes

- Fixed `loop-file=inf` leak from noise video causing single-track loop
- Fixed playlist cursor reset on error recovery
- Fixed race condition: reload during Spotify resolution no longer crashes
- Fixed remote UI showing stale data (now polls `/state` every 2s)
- Fixed mpv DRM connector selection for Pi 4 dual-HDMI

---

## 1.0.0 (2026-05-20)

Initial release — headless music TV with Spotify integration, mpv IPC, and yt-dlp.

See git history for details.
