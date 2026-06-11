const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const RODE_VENDOR_ID = 0x19f7;
const VOLUME_NAMES = ['RODECASTER', 'RØDECASTER'];

// Bundled, self-contained ffmpeg (ffmpeg-static). In a packaged app the path
// can point inside app.asar, which isn't executable — rewrite it to the
// unpacked copy. Fall back to a system ffmpeg for dev if needed.
function resolveFfmpeg() {
  let p;
  try {
    p = require('ffmpeg-static');
  } catch (_) {
    p = null;
  }
  if (p && p.includes('app.asar' + path.sep)) {
    p = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  }
  if (p && fs.existsSync(p)) return p;
  for (const sys of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (fs.existsSync(sys)) return sys;
  }
  return p || 'ffmpeg';
}
const FFMPEG = resolveFfmpeg();

// 14-channel multitrack layout for the gen-1 RODECaster Pro.
// Channel indices are 0-based, matching ffmpeg pan filter `cN` references.
const CHANNELS_14 = [
  { key: 'mix', label: 'Stereo Mix', idx: [0, 1] },
  { key: 'mic1', label: 'Mic 1', idx: [2] },
  { key: 'mic2', label: 'Mic 2', idx: [3] },
  { key: 'mic3', label: 'Mic 3', idx: [4] },
  { key: 'mic4', label: 'Mic 4', idx: [5] },
  { key: 'usb', label: 'USB', idx: [6, 7] },
  { key: 'trrs', label: 'TRRS', idx: [8, 9] },
  { key: 'bt', label: 'Bluetooth', idx: [10, 11] },
  { key: 'snd', label: 'Sounds', idx: [12, 13] },
];
const CHANNELS_2 = [{ key: 'mix', label: 'Stereo Mix', idx: [0, 1] }];

function channelMapFor(channelCount) {
  return channelCount >= 14 ? CHANNELS_14 : CHANNELS_2;
}

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 820,
    minWidth: 400,
    minHeight: 600,
    title: 'Caster Companion',
    backgroundColor: '#ececec',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---------- SD card volume detection ----------

function findRodecasterVolume() {
  if (process.env.RODE_TEST_VOLUME && fs.existsSync(process.env.RODE_TEST_VOLUME)) {
    return process.env.RODE_TEST_VOLUME;
  }
  try {
    for (const name of fs.readdirSync('/Volumes')) {
      const upper = name.toUpperCase();
      if (VOLUME_NAMES.some((v) => upper.startsWith(v))) {
        return path.join('/Volumes', name);
      }
    }
  } catch (_) {}
  return null;
}

function podcastsDir(volume) {
  const nested = path.join(volume, 'RODE', 'PODCASTS');
  return fs.existsSync(nested) ? nested : volume;
}

// Read WAV metadata directly from the RIFF header — no external ffprobe needed.
// We only read chunk headers (plus the small `fmt ` and `LIST/INFO` chunks),
// never the multi-GB audio data, so this is fast even on huge files.
// Returns { duration, size, channels, sampleRate, dateTag } or null.
function readWavMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      return null;
    }

    let channels = 0;
    let sampleRate = 0;
    let byteRate = 0;
    let dataSize = 0;
    let dateTag = '';

    const hdr = Buffer.alloc(8);
    let offset = 12;
    // Cap header scanning; the `data` chunk is last in these files so we break there anyway.
    while (offset + 8 <= stat.size) {
      if (fs.readSync(fd, hdr, 0, 8, offset) < 8) break;
      const id = hdr.toString('ascii', 0, 4);
      const size = hdr.readUInt32LE(4);
      const body = offset + 8;

      if (id === 'fmt ') {
        const fmt = Buffer.alloc(Math.min(size, 16));
        fs.readSync(fd, fmt, 0, fmt.length, body);
        channels = fmt.readUInt16LE(2);
        sampleRate = fmt.readUInt32LE(4);
        byteRate = fmt.readUInt32LE(8);
      } else if (id === 'data') {
        dataSize = size;
        break; // data is last; everything else has been seen
      } else if (id === 'LIST' && size >= 4) {
        const list = Buffer.alloc(Math.min(size, 4096));
        fs.readSync(fd, list, 0, list.length, body);
        if (list.toString('ascii', 0, 4) === 'INFO') {
          let p = 4;
          while (p + 8 <= list.length) {
            const subId = list.toString('ascii', p, p + 4);
            const subSize = list.readUInt32LE(p + 4);
            if (subId === 'ICRD') {
              dateTag = list.toString('ascii', p + 8, p + 8 + subSize).replace(/\0+$/, '').trim();
              break;
            }
            p += 8 + subSize + (subSize & 1);
          }
        }
      }
      offset = body + size + (size & 1); // chunks are word-aligned
    }

    if (!channels) return null;
    return {
      duration: byteRate ? dataSize / byteRate : 0,
      size: stat.size,
      channels,
      sampleRate,
      dateTag,
    };
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Group POD files into sessions using the embedded `date` tag:
//   "2025.12.15;13.24;A"  ->  group key "2025.12.15;13.24", chunk letter "A"
function defaultSessionName(groupKey) {
  const [datePart = '', timePart = ''] = groupKey.split(';');
  return `${datePart.replace(/\./g, '-')} ${timePart.replace(/\./g, ':')}`.trim() || 'Untitled session';
}

ipcMain.handle('scan-sessions', async () => {
  const volume = findRodecasterVolume();
  if (!volume) return { mounted: false };

  const dir = podcastsDir(volume);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /\.wav$/i.test(n) && !n.startsWith('.'));
  } catch (_) {
    return { mounted: true, volume, sessions: [] };
  }

  const groups = new Map();
  for (const name of names) {
    const full = path.join(dir, name);
    const info = readWavMeta(full);
    if (!info) continue;
    const parts = info.dateTag.split(';');
    const letter = parts.length >= 3 ? parts[2].trim() : '';
    const groupKey = parts.length >= 2 ? `${parts[0].trim()};${parts[1].trim()}` : name;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ path: full, name, letter, ...info });
  }

  const sessions = [];
  for (const [groupKey, chunks] of groups) {
    chunks.sort((a, b) => (a.letter || a.name).localeCompare(b.letter || b.name));
    const channels = chunks[0]?.channels || 0;
    sessions.push({
      id: groupKey,
      name: defaultSessionName(groupKey),
      chunkCount: chunks.length,
      totalDuration: chunks.reduce((s, c) => s + c.duration, 0),
      totalSize: chunks.reduce((s, c) => s + c.size, 0),
      channels,
      tracks: channelMapFor(channels).map((c) => ({ key: c.key, label: c.label })),
      chunkPaths: chunks.map((c) => c.path),
    });
  }
  sessions.sort((a, b) => b.id.localeCompare(a.id));
  return { mounted: true, volume, sessions };
});

ipcMain.handle('eject-volume', async () => {
  const volume = findRodecasterVolume();
  if (!volume) return { ok: false, error: 'No RODECASTER volume mounted.' };
  return new Promise((resolve) => {
    execFile('/usr/sbin/diskutil', ['eject', volume], (err, _stdout, stderr) => {
      resolve(err ? { ok: false, error: stderr || err.message } : { ok: true });
    });
  });
});

ipcMain.handle('choose-destination', async () => {
  if (process.env.RODE_TEST_DEST) return process.env.RODE_TEST_DEST;
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose destination folder',
    defaultPath: path.join(os.homedir(), 'Music'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('reveal-file', (_event, filePath) => shell.showItemInFolder(filePath));

// ---------- Per-channel analysis (which tracks have signal) ----------

ipcMain.handle('analyze-session', async (_event, { chunkPaths, channels }) => {
  const map = channelMapFor(channels);
  const probeFile = chunkPaths[0];
  // Sample a 30s window. Skip a lead-in on long files, but clamp so we stay
  // inside short ones (e.g. brief test recordings).
  const info = readWavMeta(probeFile);
  const dur = info?.duration || 0;
  const window = Math.min(30, dur || 30);
  const sampleStart = dur > 90 ? 60 : 0;
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, [
      '-v', 'info', '-nostats',
      '-ss', String(sampleStart), '-t', String(window),
      '-i', probeFile,
      '-af', 'astats=metadata=0',
      '-f', 'null', '-',
    ]);
    let buf = '';
    proc.stderr.on('data', (d) => (buf += d.toString()));
    proc.on('close', () => {
      // Parse "Channel: N" / "RMS level dB: X" pairs (1-based channel numbers).
      const rms = {};
      const re = /Channel:\s*(\d+)[\s\S]*?RMS level dB:\s*(-?[\d.]+|-inf)/g;
      let m;
      while ((m = re.exec(buf))) {
        rms[parseInt(m[1], 10)] = m[2] === '-inf' ? -Infinity : parseFloat(m[2]);
      }
      const active = {};
      for (const c of map) {
        const level = Math.max(...c.idx.map((i) => rms[i + 1] ?? -Infinity));
        active[c.key] = { active: level > -70, level: level === -Infinity ? null : level };
      }
      resolve({ ok: true, active });
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

// ---------- Per-channel multitrack export ----------

function codecArgs(format, bitrate) {
  const br = (bitrate || 192) + 'k';
  switch (format) {
    case 'mp3':
      return { ext: '.mp3', args: ['-c:a', 'libmp3lame', '-b:a', br] };
    case 'aac':
      return { ext: '.m4a', args: ['-c:a', 'aac', '-b:a', br] };
    default: // wav
      return { ext: '.wav', args: ['-c:a', 'pcm_s24le'] };
  }
}

function sanitize(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'Session';
}

ipcMain.handle(
  'export-session',
  async (event, { chunkPaths, channels, channelKeys, name, format, bitrate, normalize, destDir, totalDuration }) => {
    const map = channelMapFor(channels).filter((c) => channelKeys.includes(c.key));
    if (map.length === 0) return { ok: false, error: 'No tracks selected.' };
    if (!fs.existsSync(FFMPEG)) {
      return { ok: false, error: 'ffmpeg not found at ' + FFMPEG + '. Install with: brew install ffmpeg' };
    }

    const { ext, args: codec } = codecArgs(format, bitrate);
    const normFilter = normalize && format !== 'wav' ? ',loudnorm=I=-16:TP=-1.5:LRA=11' : '';
    const safe = sanitize(name);

    // Build the filtergraph: concat all chunks -> split N ways -> pan each track out.
    const inputs = [];
    chunkPaths.forEach((p) => inputs.push('-i', p));

    let filter;
    const n = chunkPaths.length;
    if (n > 1) {
      const concatIn = chunkPaths.map((_, i) => `[${i}:a]`).join('');
      filter = `${concatIn}concat=n=${n}:v=0:a=1[full];`;
    } else {
      filter = `[0:a]anull[full];`;
    }
    const splitLabels = map.map((_, i) => `[s${i}]`).join('');
    filter += `[full]asplit=${map.length}${splitLabels};`;
    map.forEach((c, i) => {
      const pan =
        c.idx.length === 1
          ? `mono|c0=c${c.idx[0]}`
          : `stereo|c0=c${c.idx[0]}|c1=c${c.idx[1]}`;
      filter += `[s${i}]pan=${pan}${normFilter}[o${i}];`;
    });
    filter = filter.replace(/;$/, '');

    const outputs = [];
    const destFiles = [];
    map.forEach((c, i) => {
      const dest = path.join(destDir, `${safe} - ${c.label}${ext}`);
      destFiles.push(dest);
      outputs.push('-map', `[o${i}]`, ...codec, '-y', dest);
    });

    const fullArgs = ['-v', 'error', '-stats', ...inputs, '-filter_complex', filter, ...outputs];

    return new Promise((resolve) => {
      const proc = spawn(FFMPEG, fullArgs);
      let errBuf = '';
      proc.stderr.on('data', (d) => {
        const s = d.toString();
        errBuf += s;
        // ffmpeg -stats prints "time=HH:MM:SS.xx"
        const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(s);
        if (m && totalDuration) {
          const sec = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
          const percent = Math.min(99, Math.round((sec / totalDuration) * 100));
          event.sender.send('export-progress', { percent });
        }
      });
      proc.on('close', (code) => {
        if (code === 0) {
          event.sender.send('export-progress', { percent: 100 });
          resolve({ ok: true, files: destFiles });
        } else {
          resolve({ ok: false, error: errBuf.split('\n').filter(Boolean).slice(-4).join('\n') });
        }
      });
      proc.on('error', (err) => resolve({ ok: false, error: err.message }));
    });
  }
);

// ---------- HID device detection (Sounds tab) ----------

ipcMain.handle('scan-hid', () => {
  try {
    const HID = require('node-hid');
    const devices = HID.devices().filter((d) => d.vendorId === RODE_VENDOR_ID);
    return { ok: true, devices };
  } catch (err) {
    return { ok: false, error: err.message, devices: [] };
  }
});
