# Sound-pad upload — status & feasibility

**Status: not implemented.** The Sounds tab currently only *detects* the device.

## Why it's hard

Unlike podcasts (plain files on the SD card), sound pads live in the device's
**internal flash**. Confirmed: a full `find` of the mounted card shows only
`RODE/PODCASTS` — there is no sounds/bank/pad directory to copy into. So the
only way to load a pad is to speak the device's proprietary protocol over the
**USB HID** vendor interface (usage page `0xff00`).

From the original app's binary we know:
- It uses macOS **IOKit HID** directly (`IOHIDDeviceSetReport` to push data,
  `IOHIDDeviceRegisterInputReportCallback` to read responses).
- It has the concepts we'd need to address: **banks**, **pads**, `set bank
  name`, `Clear Current Bank`, plus per-pad settings.

What we *don't* know (and the binary won't tell us cleanly): the command
opcodes, the report sizes, how a file is chunked and acknowledged, and what
audio format/encoding the device expects in flash.

## Feasibility: tractable, but a real project — and time-sensitive

This is decodable, because the reference implementation still exists. The
standard approach is a **USB protocol capture**:

1. Run the original (Intel) Companion app — it still works under Rosetta 2
   **today**.
2. Capture USB traffic while you upload one known sound to one known pad
   (e.g. a short, distinctive WAV). On macOS this means a USB packet capture
   (Apple's `PacketLogger`/the "USB" capture in Additional Tools for Xcode, or
   Wireshark with USB capture).
3. Repeat with a couple of different sounds/pads/banks to see what changes in
   the byte stream — that isolates the addressing (which bytes are the pad
   index, the bank, the length, the audio payload) from the constant framing.
4. Reconstruct the command sequence and the expected audio format, then
   reimplement it with `node-hid` (`device.write(...)`) — the device is already
   detected by the Sounds tab, so the enumeration half is done.

**The time-sensitive part:** step 1 only works while Rosetta 2 still runs the
old app. Once Apple removes Rosetta, the reference implementation is gone and
decoding gets dramatically harder. **If sound-pad upload matters at all, capture
the traffic now** (even an hour of captures saved to disk) — you can decode and
implement from the capture later, at leisure, after the old app no longer runs.

## Recommendation

For most users the podcast multitrack export is the bulk of the value, and it's
done. Sound-pad upload is a nice-to-have that costs real reverse-engineering
time with an uncertain payoff (small audience; you can also just record pads on
the device itself).

So: don't block the release on it. But if you want to keep the door open,
**grab USB captures of the old app uploading sounds while Rosetta still works**,
commit them to this repo, and the actual decode/implementation can happen any
time after.
