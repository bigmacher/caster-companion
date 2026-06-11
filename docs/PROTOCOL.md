# RODECaster Pro (gen 1) — Recording & Device Protocol Notes

Everything here was reverse-engineered from a real RODECaster Pro, its microSD
card, and the original (Intel) RODE Companion app v2.1.2
(`com.rode.rodecasterpro`). No RODE documentation beyond public marketing/help
pages was used. Each claim notes how it was verified.

## USB identity

| Property | Value | How verified |
|----------|-------|--------------|
| Vendor ID | `0x19f7` (RØDE) | Found in the original app's device-matching disassembly (`cmpl $0x19f7, …`) **and** by live HID enumeration of the connected unit. |
| Product ID | `0x11` | Live HID enumeration (`node-hid`) of the connected device. |
| HID usage page | `0xff00` (vendor-defined) | Live HID enumeration. |
| HID usage | `0x1` | Live HID enumeration. |

The original app talks to the device through macOS **IOKit HID** directly
(`IOHIDManagerCreate`, `IOHIDDeviceOpen`, `IOHIDDeviceSetReport`,
`IOHIDDeviceRegisterInputReportCallback`) — confirmed via `nm -u` on the binary.
It does **not** use `hidapi`.

## Two independent data paths

The device exposes **two** completely separate interfaces, and only one is used
for podcasts:

1. **USB Mass Storage** — in *Podcast Transfer Mode* the microSD card mounts as
   a normal volume named `RODECASTER`. **All podcast transfer happens here.** No
   HID, no proprietary protocol — it's just files on a disk. This is what Caster
   Companion uses.
2. **USB HID** (vendor page `0xff00`) — used for firmware updates and sound-pad
   uploads. This path is proprietary and undecoded. See
   [SOUND-PADS.md](SOUND-PADS.md).

## Card layout

```
/Volumes/RODECASTER/
└── RODE/
    └── PODCASTS/
        ├── POD00759.WAV
        ├── POD00760.WAV
        └── …
```

There is **no** sounds/bank/pad directory on the card (verified with a full
`find` of the mounted volume). Sound pads therefore live in the device's
internal flash, which is why uploading them requires the HID path rather than a
file copy.

## Recording format

Each `POD#####.WAV` is a **14-channel, 24-bit, 48 kHz** PCM poly-WAV
(`pcm_s24le`), verified with `ffprobe`.

### Channel layout

| Channel (1-based) | Track | Width |
|---|---|---|
| 1–2 | Stereo Mix (main mix L/R) | stereo |
| 3 | Mic 1 | mono |
| 4 | Mic 2 | mono |
| 5 | Mic 3 | mono |
| 6 | Mic 4 | mono |
| 7–8 | USB | stereo |
| 9–10 | TRRS (3.5 mm phone) | stereo |
| 11–12 | Bluetooth | stereo |
| 13–14 | Sound pads | stereo |

Verified three independent ways:
1. **RØDE's own documentation** describes the order as: stereo mix first, then
   Mic 1→4, then USB, TRRS, Bluetooth, sound pads; mics mono, the rest stereo.
2. **Strings in the original binary** include `Mic 1`…`Mic 4`, `Stereo Mix`,
   `Bluetooth Left`/`Bluetooth Right`, `TRRS Left`/`TRRS Right`,
   `Sounds Left`/`Sounds Right` — matching this grouping.
3. **Per-channel RMS measurement** of a real recording (ffmpeg `astats`)
   produced sensible results: an active Stereo Mix on 1–2, signal on the Mic 1
   and USB channels, and digital silence on the unused inputs — exactly what the
   layout predicts for a host-on-mic + remote-guest-on-USB session.

### Sessions and chunk splitting

A long recording is split across multiple files at the **~4 GB FAT32 file-size
limit** (observed chunk sizes of 3.78 GB and 3.08 GB, not a fixed time).

Chunks are tied together by an embedded RIFF `LIST/INFO/ICRD` tag (surfaced by
ffprobe as `format_tags.date`):

```
date = "YYYY.MM.DD;HH.MM;<letter>"
e.g.   "2025.12.15;13.24;A"   "2025.12.15;13.24;B"
```

- The `YYYY.MM.DD;HH.MM` prefix is the **session key** — all files sharing it
  belong to one recording.
- The trailing letter (`A`, `B`, `C`, …) is the **chunk order**.
- Some tags carry a stray trailing byte after the letter (e.g. `A8`, `A(`, or a
  spurious quote). Only the prefix is used for grouping, and `localeCompare` on
  the letter still orders chunks correctly, so the junk byte is harmless.

To rebuild a continuous session you concatenate the chunks in letter order, then
split out each channel (or split first, then concat — Caster Companion concats
then splits in a single ffmpeg pass; see [ARCHITECTURE.md](ARCHITECTURE.md)).

The session **name** (e.g. "barry katz") is **not** stored on the card — the
original app prompted for it at export time, and so does Caster Companion.
