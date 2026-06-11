const $ = (id) => document.getElementById(id);

let destDir = null;
let toastTimer = null;
let sessionState = {}; // id -> { name, format, channelKeys:Set, active }
let exporting = false;

window.rode.onExportProgress(({ percent }) => {
  const bar = document.querySelector('.progress-bar.active .progress-fill');
  const label = document.querySelector('.progress-bar.active .progress-label');
  if (bar) bar.style.width = percent + '%';
  if (label) label.textContent = percent + '%';
});

function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}

// ---- tabs ----
function showTab(name) {
  $('tab-sounds').classList.toggle('active', name === 'sounds');
  $('tab-podcasts').classList.toggle('active', name === 'podcasts');
  $('page-sounds').classList.toggle('hidden', name !== 'sounds');
  $('page-podcasts').classList.toggle('hidden', name !== 'podcasts');
}
$('tab-sounds').onclick = () => showTab('sounds');
$('tab-podcasts').onclick = () => showTab('podcasts');

// ---- formatting ----
function fmtSize(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
  return Math.round(bytes / 1e3) + ' KB';
}
function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// ---- session polling ----
let lastFingerprint = '';

async function pollSessions() {
  if (exporting) return; // don't disturb a running export
  const result = await window.rode.scanSessions();
  const mounted = $('mounted');
  const notMounted = $('not-mounted');

  if (!result.mounted) {
    mounted.classList.add('hidden');
    notMounted.classList.remove('hidden');
    lastFingerprint = '';
    sessionState = {};
    return;
  }
  notMounted.classList.add('hidden');
  mounted.classList.remove('hidden');
  $('volume-name').textContent =
    result.volume.replace('/Volumes/', '') +
    ' · ' + result.sessions.length + ' session' + (result.sessions.length === 1 ? '' : 's');

  const fingerprint = JSON.stringify(result.sessions.map((s) => s.id + s.totalSize));
  if (fingerprint === lastFingerprint) return;
  lastFingerprint = fingerprint;
  renderSessions(result.sessions);
}

function renderSessions(sessions) {
  const list = $('session-list');
  list.innerHTML = '';
  if (sessions.length === 0) {
    list.innerHTML = '<div class="instructions">No recordings found on the card.</div>';
    return;
  }
  for (const s of sessions) {
    if (!sessionState[s.id]) {
      sessionState[s.id] = {
        name: s.name,
        format: 'wav', // lossless master — best for editing; switch to MP3/AAC for a final upload
        bitrate: 128,
        normalize: true,
        channelKeys: new Set(s.tracks.map((t) => t.key)),
        active: null,
      };
    }
    list.appendChild(renderSessionCard(s));
  }
}

function renderSessionCard(s) {
  const st = sessionState[s.id];
  const card = document.createElement('div');
  card.className = 'session-card';
  card.dataset.id = s.id;

  // header: editable name
  const nameInput = document.createElement('input');
  nameInput.className = 'session-name';
  nameInput.value = st.name;
  nameInput.spellcheck = false;
  nameInput.oninput = () => (st.name = nameInput.value);

  const meta = document.createElement('div');
  meta.className = 'session-meta';
  const chunkNote = s.chunkCount > 1 ? `${s.chunkCount} chunks joined · ` : '';
  meta.textContent =
    `${chunkNote}${fmtDuration(s.totalDuration)} · ${s.tracks.length} track${s.tracks.length === 1 ? '' : 's'} · ${fmtSize(s.totalSize)}`;

  // track checkboxes
  const tracks = document.createElement('div');
  tracks.className = 'track-grid';
  for (const t of s.tracks) {
    const labelEl = document.createElement('label');
    labelEl.className = 'track-chip';
    labelEl.dataset.key = t.key;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = st.channelKeys.has(t.key);
    cb.onchange = () => {
      cb.checked ? st.channelKeys.add(t.key) : st.channelKeys.delete(t.key);
    };
    const span = document.createElement('span');
    span.textContent = t.label;
    labelEl.append(cb, span);
    tracks.appendChild(labelEl);
  }
  if (st.active) applyActive(tracks, st.active);

  // controls row
  const controls = document.createElement('div');
  controls.className = 'session-controls';

  const analyzeBtn = document.createElement('button');
  analyzeBtn.className = 'small-btn';
  analyzeBtn.textContent = st.active ? 'Re-scan tracks' : 'Find active tracks';
  analyzeBtn.onclick = () => analyze(s, analyzeBtn, tracks);

  const formatSel = document.createElement('select');
  formatSel.innerHTML =
    '<option value="wav">WAV · 24-bit (best for editing)</option>' +
    '<option value="mp3">MP3</option>' +
    '<option value="aac">AAC</option>';
  formatSel.value = st.format;

  const exportBtn = document.createElement('button');
  exportBtn.className = 'transfer-btn';
  exportBtn.textContent = 'Export tracks';
  exportBtn.onclick = () => exportSession(s, card, exportBtn);

  controls.append(analyzeBtn, formatSel, exportBtn);

  // advanced (compressed-format) settings — only relevant for MP3/AAC
  const adv = document.createElement('div');
  adv.className = 'adv-settings';
  const brSel = document.createElement('select');
  brSel.innerHTML = [128, 192, 256, 320]
    .map((b) => `<option value="${b}">${b} kbps</option>`)
    .join('');
  brSel.value = String(st.bitrate);
  brSel.onchange = () => (st.bitrate = parseInt(brSel.value, 10));

  const normLabel = document.createElement('label');
  normLabel.className = 'norm-toggle';
  const normCb = document.createElement('input');
  normCb.type = 'checkbox';
  normCb.checked = st.normalize;
  normCb.onchange = () => (st.normalize = normCb.checked);
  const normText = document.createElement('span');
  normText.textContent = 'Normalize to −16 LUFS';
  normLabel.append(normCb, normText);

  adv.append(brSel, normLabel);
  adv.style.display = st.format === 'wav' ? 'none' : 'flex';
  formatSel.onchange = () => {
    st.format = formatSel.value;
    adv.style.display = st.format === 'wav' ? 'none' : 'flex';
  };

  // progress bar
  const progress = document.createElement('div');
  progress.className = 'progress-bar';
  progress.innerHTML = '<div class="progress-fill"></div><span class="progress-label"></span>';

  card.append(nameInput, meta, tracks, controls, adv, progress);
  return card;
}

function applyActive(tracksEl, active) {
  for (const chip of tracksEl.querySelectorAll('.track-chip')) {
    const a = active[chip.dataset.key];
    chip.classList.toggle('inactive', a && !a.active);
    chip.classList.toggle('active-track', a && a.active);
    const existing = chip.querySelector('.lvl');
    if (existing) existing.remove();
    if (a && a.active && a.level != null) {
      const lvl = document.createElement('em');
      lvl.className = 'lvl';
      lvl.textContent = Math.round(a.level) + ' dB';
      chip.appendChild(lvl);
    }
  }
}

async function analyze(s, btn, tracksEl) {
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  const res = await window.rode.analyzeSession({ chunkPaths: s.chunkPaths, channels: s.channels });
  btn.disabled = false;
  btn.textContent = 'Re-scan tracks';
  if (!res.ok) return toast(res.error, true);
  const st = sessionState[s.id];
  st.active = res.active;
  // auto-select only active tracks
  st.channelKeys = new Set(Object.entries(res.active).filter(([, v]) => v.active).map(([k]) => k));
  for (const chip of tracksEl.querySelectorAll('.track-chip')) {
    chip.querySelector('input').checked = st.channelKeys.has(chip.dataset.key);
  }
  applyActive(tracksEl, res.active);
  const n = st.channelKeys.size;
  toast(`Found ${n} active track${n === 1 ? '' : 's'}.`);
}

async function exportSession(s, card, btn) {
  const st = sessionState[s.id];
  if (st.channelKeys.size === 0) return toast('Select at least one track.', true);
  if (!destDir) {
    destDir = await window.rode.chooseDestination();
    if (!destDir) return;
  }
  const progress = card.querySelector('.progress-bar');
  progress.classList.add('active');
  card.querySelector('.progress-fill').style.width = '0%';
  card.querySelector('.progress-label').textContent = '0%';
  btn.disabled = true;
  btn.textContent = 'Exporting…';
  exporting = true;

  const res = await window.rode.exportSession({
    chunkPaths: s.chunkPaths,
    channels: s.channels,
    channelKeys: [...st.channelKeys],
    name: st.name,
    format: st.format,
    bitrate: st.bitrate,
    normalize: st.normalize,
    destDir,
    totalDuration: s.totalDuration,
  });

  exporting = false;
  btn.disabled = false;
  btn.textContent = 'Export tracks';
  progress.classList.remove('active');
  if (res.ok) {
    toast(`Exported ${res.files.length} track${res.files.length === 1 ? '' : 's'} to ${destDir}`);
    window.rode.revealFile(res.files[0]);
  } else {
    toast(res.error, true);
  }
}

$('eject').onclick = async () => {
  const res = await window.rode.ejectVolume();
  if (res.ok) toast('Card ejected. You can exit Transfer Mode on the device.');
  else toast(res.error, true);
};

// ---- sounds: HID detection ----
async function pollHid() {
  if ($('page-sounds').classList.contains('hidden')) return;
  const result = await window.rode.scanHid();
  const el = $('hid-status');
  if (!result.ok) return (el.textContent = 'HID scan unavailable: ' + result.error);
  if (result.devices.length === 0) {
    el.textContent = 'No RØDE USB devices detected.\nConnect your RØDECaster Pro and power it on.';
    return;
  }
  el.textContent = result.devices
    .map((d) =>
      [
        'Found: ' + (d.product || 'unknown device'),
        '  vendorId:  0x' + d.vendorId.toString(16),
        '  productId: 0x' + d.productId.toString(16),
        '  usagePage: ' + (d.usagePage != null ? '0x' + d.usagePage.toString(16) : '?'),
      ].join('\n')
    )
    .join('\n\n');
}

pollSessions();
setInterval(pollSessions, 3000);
setInterval(pollHid, 3000);
