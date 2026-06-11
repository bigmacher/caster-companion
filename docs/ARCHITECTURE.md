# Architecture

Caster Companion is a small Electron app. Three files do the work:

```
src/
├── main.js              # Electron main process — all filesystem, ffmpeg, HID, IPC
├── preload.js           # contextBridge — exposes a typed `window.rode` API
└── renderer/
    ├── index.html       # layout (Sounds / Podcasts tabs)
    ├── styles.css        # styling
    └── app.js           # UI logic, session state, polling, export orchestration
```

The renderer is sandboxed (`contextIsolation: true`, `nodeIntegration: false`).
It never touches the filesystem or spawns processes directly — everything goes
through `preload.js` and IPC to the main process.

## IPC surface (`window.rode`)

| Method | Main handler | Purpose |
|---|---|---|
| `scanSessions()` | `scan-sessions` | Find the card, read each `POD*.WAV` header, group into sessions. |
| `analyzeSession({chunkPaths, channels})` | `analyze-session` | Measure per-channel RMS on a sample → which tracks have signal. |
| `exportSession({…})` | `export-session` | Concat chunks + split channels + encode, with progress events. |
| `chooseDestination()` | `choose-destination` | Native folder picker. |
| `ejectVolume()` | `eject-volume` | `diskutil eject` the card. |
| `revealFile(path)` | `reveal-file` | Reveal an exported file in Finder. |
| `scanHid()` | `scan-hid` | Enumerate RØDE USB HID devices (Sounds tab). |
| `onExportProgress(cb)` | `export-progress` (event) | Streamed `{percent}` during export. |

## Session scanning

`scan-sessions` lists `RODE/PODCASTS/*.WAV` (falling back to the volume root),
reads each file's metadata with `readWavMeta()` — a small native RIFF-header
parser (no external `ffprobe`) that pulls duration, size, channel count, and the
`date`/`ICRD` tag while reading only the header chunks, never the multi-GB audio
data — then groups by the `date;time` prefix and sorts chunks by their trailing
letter. The channel map (9 named tracks for 14-channel files, just
Stereo Mix for 2-channel files) is attached to each session. See
[PROTOCOL.md](PROTOCOL.md) for the format details.

The renderer polls `scanSessions()` every 3 seconds and re-renders only when the
set of sessions changes (a cheap fingerprint of ids + sizes), so plugging the
card in or pulling it out updates the UI automatically without flicker.

## The export filtergraph

All audio work uses the **bundled** `ffmpeg-static` binary (resolved by
`resolveFfmpeg()` in `src/main.js`, with a system-ffmpeg fallback for dev), so
the shipped app has no external runtime dependency.

The heart of the app is one ffmpeg invocation per session that reads each chunk
**once** and writes every selected track. For chunks `c0…cN` and selected
tracks `t0…tM`:

```
# 1. concat all chunks into one 14-channel stream
[0:a][1:a]…concat=n=N:v=0:a=1[full];

# 2. fan it out, one branch per selected track
[full]asplit=M[s0][s1]…[sM];

# 3. pan each branch down to that track's channel(s),
#    optionally loudness-normalizing for MP3/AAC
[s0]pan=stereo|c0=c0|c1=c1[o0];          # Stereo Mix
[s1]pan=mono|c0=c2[o1];                  # Mic 1
[s2]pan=stereo|c0=c6|c1=c7[o2];          # USB
…
```

Each `[oI]` is mapped to its own output file with the chosen codec
(`pcm_s24le` for WAV, `libmp3lame`/`aac` at the selected bitrate for MP3/AAC).
When normalization is on, `,loudnorm=I=-16:TP=-1.5:LRA=11` is appended to each
track's pan stage. Single-chunk sessions skip the concat (`[0:a]anull[full]`).

Doing it in one pass (rather than one ffmpeg run per track) means the multi-GB
source files are decoded only once.

### Progress

ffmpeg is spawned with `-stats`; the main process parses the `time=HH:MM:SS.xx`
lines from stderr, divides by the session's total duration, and emits
`export-progress` events that drive the per-session progress bar.

## Active-track detection

`analyze-session` decodes a 30-second sample of the first chunk through the
`astats` filter, parses the per-channel `RMS level dB`, and marks a track
"active" if any of its channels exceeds −70 dB. On long files the sample is
taken ~60 s in to skip silent lead-in; on short files it clamps to the start.
The renderer then auto-checks only the active tracks.

## Test hooks

Two environment variables make the app testable without hardware (used by the
Playwright-driven checks during development):

- `RODE_TEST_VOLUME=/path` — treat this folder as the mounted card.
- `RODE_TEST_DEST=/path` — skip the native folder picker and export here.
