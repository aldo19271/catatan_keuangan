(() => {
'use strict';

/* ================= Konstanta & helper ================= */
const DAYS_SHORT = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
const DAYS_LONG = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const MONTHS_LONG = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const MAX_AMOUNT = 999999999999;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const todayKey = () => keyOf(new Date());
const dowIndex = (d) => (d.getDay() + 6) % 7; // Senin = 0
const fmtNum = (n) => Number(n || 0).toLocaleString('id-ID');
const rupiah = (n) => 'Rp ' + fmtNum(n);
const fmtLong = (k) => { const d = parseKey(k); return `${DAYS_LONG[dowIndex(d)]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const fmtMini = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

function mondayOf(date) {
  const x = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  x.setDate(x.getDate() - dowIndex(x));
  return x;
}
function weekDates(offset) {
  const m = mondayOf(new Date());
  return Array.from({ length: 7 }, (_, i) => new Date(m.getFullYear(), m.getMonth(), m.getDate() + offset * 7 + i));
}
function uid() {
  if (window.crypto && crypto.randomUUID) { try { return crypto.randomUUID(); } catch (e) { /* lanjut */ } }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
function parseAmount(v) {
  const n = Number(String(v || '').replace(/\D/g, '') || 0);
  return Math.min(n, MAX_AMOUNT);
}

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v == null) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = String(v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
  }
  kids.flat().forEach((c) => { if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c))); });
  return e;
}
function s(tag, attrs, text) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

/* ================= Data (server, Neon) ================= */
// Semua catatan dan saran disimpan di akun pengguna lewat /api/data. Nama fungsi db* dipertahankan.
let onSessionLost = () => {};
async function api(path, body) {
  let res;
  try {
    res = await fetch(path, body === undefined ? { cache: 'no-store' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
    });
  } catch (e) { throw new Error('Tidak ada koneksi ke server. Periksa internet lalu coba lagi.'); }
  let data = {};
  try { data = await res.json(); } catch (e) { /* respons bukan JSON */ }
  if (res.status === 401 && (!path.startsWith('/api/auth') || state.user)) { onSessionLost(); throw new Error('Sesi berakhir. Silakan masuk lagi.'); }
  if (!res.ok) { const er = new Error(data.error || 'Terjadi kesalahan di server (' + res.status + ').'); er.data = data; throw er; }
  return data;
}
const dbRange = (from, to) => api(`/api/data?from=${from}&to=${to}`).then((d) => d.items);
const dbGetAdvice = (date) => api(`/api/data?advice=${date}`).then((d) => d.advice);
const dbPutAdvice = (a) => api('/api/data', { action: 'advice', date: a.date, text: a.text, createdAt: a.createdAt });
const dbAdd = (items) => api('/api/data', { action: 'add', items });
const dbUpdate = (item) => api('/api/data', { action: 'update', id: item.id, amount: item.amount, desc: item.desc });
const dbDelete = (id) => api('/api/data', { action: 'delete', id });
const dbClear = () => api('/api/data', { action: 'clear' });
async function dbExport() {
  const d = await api('/api/data?export=1');
  return { app: 'catatan-keuangan', version: 1, exportedAt: new Date().toISOString(), tx: d.tx, advice: d.advice };
}
async function dbImport(txs, advices) {
  const N = 500; // dipecah supaya tiap permintaan tidak terlalu besar
  for (let i = 0; i < txs.length; i += N) await api('/api/data', { action: 'import', tx: txs.slice(i, i + N), advice: [] });
  for (let i = 0; i < advices.length; i += N) await api('/api/data', { action: 'import', tx: [], advice: advices.slice(i, i + N) });
}

/* ================= State ================= */
// mode: 'week' | 'month' | 'year' (periode grafik analisis). offset = minggu pada kalender, pOffset = bulan/tahun pada grafik.
const state = { user: null, mode: 'week', offset: 0, pOffset: 0, selected: todayKey(), lastToday: todayKey(), seq: 0, dir: 0, pending: new Set() };
const MODE_ORDER = { year: 0, month: 1, week: 2 };
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(.2,.8,.2,1)';
let editing = null;
let saranKey = null;

/* ================= Grafik ================= */
function niceMax(peak) {
  if (peak <= 0) return 100000;
  const p = Math.pow(10, Math.floor(Math.log10(peak)));
  const n = peak / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
function short(v) {
  const f = (x, unit) => (Number.isInteger(x) ? String(x) : x.toFixed(1).replace('.', ',')) + ' ' + unit;
  if (v >= 1e9) return f(v / 1e9, 'M');
  if (v >= 1e6) return f(v / 1e6, 'jt');
  if (v >= 1e3) return Math.round(v / 1e3) + ' rb';
  return String(Math.round(v));
}
// pts: [{out, inc}] urut dari kiri ke kanan. o: { labels: [{i, t}], selIdx, dotR, onPick(i) }
function drawChart(pts, o) {
  const svg = $('chart');
  // gerak antar periode: grafik lama didorong keluar, grafik baru meluncur masuk (hanya transform, tanpa fade)
  const wrap = svg.parentElement;
  wrap.querySelectorAll('.ghost').forEach((g) => g.remove());
  svg.getAnimations().forEach((an) => an.cancel());
  let ghost = null;
  if (o.dir && !reduceMotion() && svg.childElementCount) {
    ghost = svg.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.classList.add('ghost');
  }
  svg.replaceChildren();
  const W = 340, H = 170, L = 44, R = 14, T = 14, B = 26;
  const iw = W - L - R, ih = H - T - B, n = pts.length;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const peak = Math.max(0, ...pts.map((d) => Math.max(d.out, d.inc)));
  const max = niceMax(peak);
  const x = (i) => L + (iw * i) / (n - 1);
  const y = (v) => T + ih - (v / max) * ih;

  [0, 0.5, 1].forEach((f) => {
    const yy = T + ih - ih * f;
    svg.append(
      s('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: 'grid' }),
      s('text', { x: L - 6, y: yy + 3, class: 'ylab', 'text-anchor': 'end' }, short(max * f)),
    );
  });
  o.labels.forEach(({ i, t }) => svg.append(
    s('text', { x: x(i), y: H - 8, class: 'xlab' + (i === o.selIdx ? ' sel' : ''), 'text-anchor': 'middle' }, t),
  ));
  if (o.selIdx >= 0) svg.append(s('line', { x1: x(o.selIdx), x2: x(o.selIdx), y1: T, y2: T + ih, class: 'selline' }));

  const draw = (key, cls) => {
    svg.append(s('polyline', { points: pts.map((d, i) => `${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' '), class: 'ln ' + cls }));
    pts.forEach((d, i) => svg.append(s('circle', { cx: x(i).toFixed(1), cy: y(d[key]).toFixed(1), r: i === o.selIdx ? 4.5 : o.dotR, class: 'dot ' + cls })));
  };
  draw('out', 'out');
  draw('inc', 'inc');

  // satu lapisan transparan: ketukan dicocokkan ke titik terdekat (titik bulanan terlalu rapat untuk target sendiri-sendiri)
  const hit = s('rect', { x: 0, y: T, width: W, height: H - T, fill: 'transparent', class: 'hit' });
  hit.addEventListener('click', (e) => {
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const vx = ((e.clientX - r.left) / r.width) * W;
    o.onPick(Math.max(0, Math.min(n - 1, Math.round(((vx - L) / iw) * (n - 1)))));
  });
  svg.append(hit);

  if (ghost) {
    wrap.append(ghost);
    const opt = { duration: 420, easing: EASE };
    ghost.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-o.dir * 100}%)` }], opt).finished.then(() => ghost.remove(), () => ghost.remove());
    svg.animate([{ transform: `translateX(${o.dir * 100}%)` }, { transform: 'translateX(0)' }], opt);
  }
}

/* ================= Render ================= */
const weekOffsetOf = (key) => Math.round((mondayOf(parseKey(key)) - mondayOf(new Date())) / 604800000);
const monthOffsetOf = (y, m) => { const now = new Date(); return (y - now.getFullYear()) * 12 + (m - now.getMonth()); };

// rentang tanggal untuk mode bulan/tahun sesuai pOffset (0 = bulan/tahun berjalan, negatif = ke belakang)
function periodInfo() {
  const now = new Date();
  if (state.mode === 'month') {
    const base = new Date(now.getFullYear(), now.getMonth() + state.pOffset, 1);
    const y = base.getFullYear(), m = base.getMonth(), n = new Date(y, m + 1, 0).getDate();
    return { y, m, n, from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(n)}` };
  }
  const y = now.getFullYear() + state.pOffset;
  return { y, from: `${y}-01-01`, to: `${y}-12-31` };
}
// penanda oranye meluncur ke tombol yang dipilih
function movePill(animate) {
  const seg = document.querySelector('.seg'), pill = seg.querySelector('.pill');
  const b = seg.querySelector(`button[data-mode="${state.mode}"]`);
  if (!pill || !b || !b.offsetWidth) return;
  pill.style.transition = animate && !reduceMotion() ? '' : 'none';
  pill.style.width = b.offsetWidth + 'px';
  pill.style.transform = `translateX(${b.offsetLeft}px)`;
}
function syncControls() {
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  movePill(true);
  const nav = $('pNav'), wasHidden = nav.hidden;
  nav.hidden = state.mode === 'week';
  if (wasHidden && !nav.hidden && !reduceMotion()) {
    nav.animate([{ transform: 'translateX(-28px) scale(.9)' }, { transform: 'none' }], { duration: 380, easing: EASE });
  }
  $('nextP').disabled = state.pOffset >= 0;
}
// pindah periode: mulai dari periode yang sedang dilihat, bukan selalu dari hari ini
function setMode(next) {
  if (next === state.mode) return;
  const prev = state.mode, now = new Date(), d = parseKey(state.selected);
  let off = 0;
  if (next === 'month') {
    if (prev === 'year') {
      const y = now.getFullYear() + state.pOffset;
      off = d.getFullYear() === y ? monthOffsetOf(y, d.getMonth()) : monthOffsetOf(y, 11);
    } else off = monthOffsetOf(d.getFullYear(), d.getMonth());
  } else if (next === 'year') {
    const base = prev === 'month' ? new Date(now.getFullYear(), now.getMonth() + state.pOffset, 1) : d;
    off = base.getFullYear() - now.getFullYear();
  }
  state.pOffset = Math.min(0, off);
  state.dir = MODE_ORDER[next] > MODE_ORDER[prev] ? 1 : -1;
  state.mode = next;
  render();
}
// ketuk titik pada grafik bulanan: buka hari itu di kalender (hanya sampai minggu berjalan)
function pickDay(key) {
  const off = weekOffsetOf(key);
  if (off > 0) return;
  state.selected = key; state.offset = off;
  render();
}
// ketuk titik pada grafik tahunan: buka bulan itu
function pickMonth(y, m) {
  const off = monthOffsetOf(y, m);
  if (off > 0) return;
  state.mode = 'month'; state.pOffset = off;
  render();
}

async function render() {
  if (!state.user) return;
  const seq = ++state.seq;
  syncControls();
  const dates = weekDates(state.offset);
  const keys = dates.map(keyOf);
  if (!keys.includes(state.selected)) state.selected = state.offset === 0 ? todayKey() : keys[0];
  const sel = state.selected;
  const per = state.mode === 'week' ? null : periodInfo();
  const [list, plist, adv] = await Promise.all([
    dbRange(keys[0], keys[6]),
    per ? dbRange(per.from, per.to) : null,
    dbGetAdvice(sel),
  ]);
  if (seq !== state.seq) return;
  const dir = state.dir; state.dir = 0;

  const by = {};
  keys.forEach((k) => { by[k] = []; });
  list.forEach((t) => { if (by[t.date]) by[t.date].push(t); });
  const days = keys.map((k) => ({
    key: k,
    out: by[k].filter((t) => t.type === 'out').reduce((a, t) => a + t.amount, 0),
    inc: by[k].filter((t) => t.type === 'in').reduce((a, t) => a + t.amount, 0),
  }));

  // deret untuk grafik: minggu = 7 hari, bulan = tiap tanggal, tahun = 12 bulan
  let pts = days, labels = DAYS_SHORT.map((t, i) => ({ i, t })), selIdx = keys.indexOf(sel), dotR = 2.6;
  let onPick = (i) => selectDay(keys[i]);
  let word = 'minggu', current = state.offset === 0, desc = 'satu minggu';
  const addTo = (arr, idx, t) => { const p = arr[idx]; if (p) p[t.type === 'out' ? 'out' : 'inc'] += t.amount; };
  if (per && state.mode === 'month') {
    pts = Array.from({ length: per.n }, () => ({ out: 0, inc: 0 }));
    plist.forEach((t) => addTo(pts, Number(t.date.slice(8, 10)) - 1, t));
    labels = [1, 5, 10, 15, 20, 25].map((d) => ({ i: d - 1, t: String(d) })).concat({ i: per.n - 1, t: String(per.n) });
    const prefix = `${per.y}-${pad(per.m + 1)}-`;
    selIdx = sel.startsWith(prefix) ? Number(sel.slice(8, 10)) - 1 : -1;
    dotR = 1.8;
    onPick = (i) => pickDay(prefix + pad(i + 1));
    word = 'bulan'; current = state.pOffset === 0; desc = 'satu bulan';
    $('pLabel').textContent = `${MONTHS_LONG[per.m]} ${per.y}`;
  } else if (per) {
    pts = Array.from({ length: 12 }, () => ({ out: 0, inc: 0 }));
    plist.forEach((t) => addTo(pts, Number(t.date.slice(5, 7)) - 1, t));
    labels = MONTHS.map((t, i) => ({ i, t }));
    selIdx = sel.startsWith(per.y + '-') ? Number(sel.slice(5, 7)) - 1 : -1;
    onPick = (i) => pickMonth(per.y, i);
    word = 'tahun'; current = state.pOffset === 0; desc = 'satu tahun';
    $('pLabel').textContent = String(per.y);
  }

  $('chart').setAttribute('aria-label', 'Grafik pengeluaran dan penghasilan ' + desc);
  drawChart(pts, { labels, selIdx, dotR, onPick, dir });
  $('totOut').textContent = rupiah(pts.reduce((a, d) => a + d.out, 0));
  $('totIn').textContent = rupiah(pts.reduce((a, d) => a + d.inc, 0));
  $('lblOut').textContent = `Pengeluaran ${word} ${current ? 'ini' : 'itu'}`;
  $('lblIn').textContent = `Penghasilan ${word} ${current ? 'ini' : 'itu'}`;
  const sameMonth = dates[0].getMonth() === dates[6].getMonth();
  const startLabel = sameMonth ? String(dates[0].getDate()) : fmtMini(dates[0]);
  $('weekLabel').textContent = `${startLabel} - ${fmtMini(dates[6])} ${dates[6].getFullYear()}` + (state.offset === 0 ? ' · minggu ini' : '');
  $('nextWeek').disabled = state.offset >= 0;

  const t = todayKey();
  const daysEl = $('days');
  daysEl.replaceChildren(...dates.map((d, i) => {
    const k = keys[i];
    return h('button', {
      class: `day${k === sel ? ' sel' : ''}${k === t ? ' today' : ''}${k > t ? ' future' : ''}`,
      'aria-pressed': String(k === sel),
      'aria-label': fmtLong(k),
      onclick: () => selectDay(k),
    },
    h('span', { class: 'dn', text: DAYS_SHORT[i] }),
    h('span', { class: 'dd', text: d.getDate() }),
    h('span', { class: 'dots' }, days[i].out > 0 && h('i', { class: 'o' }), days[i].inc > 0 && h('i', { class: 'g' })));
  }));

  drawDetail(sel, by[sel].slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)), adv, !dir);
}

function drawDetail(key, txs, adv, rise = true) {
  const box = $('detail');
  const t = todayKey();
  const isToday = key === t, isPast = key < t, hasData = txs.length > 0;
  const out = txs.filter((x) => x.type === 'out').reduce((a, x) => a + x.amount, 0);
  const inc = txs.filter((x) => x.type === 'in').reduce((a, x) => a + x.amount, 0);

  let hint = '';
  if (!isPast && !isToday) hint = 'Hari ini belum tiba, belum bisa dianalisis.';
  else if (!hasData) hint = isToday ? 'Catat dulu pengeluaran atau penghasilan agar bisa dianalisis.' : 'Tidak ada catatan di hari ini untuk dianalisis.';
  const canAdvise = (isPast || isToday) && hasData;
  const label = canAdvise && adv ? 'Lihat Saran' : 'Minta Saran AI';

  const list = hasData
    ? h('ul', { class: 'txs' }, txs.map((x) => h('li', { class: `tx ${x.type}` },
      h('button', { class: 'tx-main', onclick: () => openEdit(x), 'aria-label': 'Ubah catatan' },
        h('span', { class: 'l' },
          h('span', { class: 't', text: x.type === 'out' ? 'Pengeluaran' : 'Penghasilan' }),
          h('span', { class: 'd' + (x.desc ? '' : ' none'), text: x.desc || '(tanpa deskripsi)' })),
        h('span', { class: 'a', text: (x.type === 'out' ? '− ' : '+ ') + rupiah(x.amount) })),
      h('button', { class: 'tx-del', onclick: () => removeTx(x), 'aria-label': 'Hapus catatan', text: '✕' }))))
    : h('p', { class: 'empty', text: isPast ? 'Tidak ada catatan di hari ini.' : isToday ? 'Belum ada catatan hari ini. Tekan + untuk mencatat.' : 'Hari ini belum tiba.' });

  box.replaceChildren(
    h('div', { class: 'd-head' }, h('h2', { text: fmtLong(key) }), isToday && h('span', { class: 'badge', text: 'Hari ini' })),
    h('div', { class: 'd-sum' },
      h('div', { class: 'stat' }, h('small', { text: 'Pengeluaran' }), h('strong', { class: 'c-out', text: rupiah(out) })),
      h('div', { class: 'stat' }, h('small', { text: 'Penghasilan' }), h('strong', { class: 'c-inc', text: rupiah(inc) }))),
    list,
    h('button', { class: 'btn-saran', disabled: !canAdvise, onclick: () => openAdvice(key), text: label }),
    hint && h('p', { class: 'saran-hint', text: hint }),
  );
  if (rise) {
    box.style.animation = 'none';
    void box.offsetWidth;
    box.style.animation = '';
  }
}

function selectDay(key) {
  state.selected = key;
  render();
}

/* ================= Sheet ================= */
function openSheet(id) {
  const el = $(id);
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  document.body.classList.add('lock');
}
function hidePasswords(root) {
  (root || document).querySelectorAll('.eye[aria-pressed="true"]').forEach((b) => setEye(b, false));
}
function setEye(b, show) {
  const inp = $(b.dataset.for);
  inp.type = show ? 'text' : 'password';
  b.setAttribute('aria-pressed', String(show));
  b.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
}
function closeSheet(id) {
  const el = $(id);
  hidePasswords(el);
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
  if (!document.querySelector('.sheet.open')) document.body.classList.remove('lock');
  if (id === 'sheetSaran') saranKey = null;
  if (id === 'sheetForm') editing = null;
}
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]');
  if (c) { const sh = c.closest('.sheet'); if (sh) closeSheet(sh.id); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.sheet.open').forEach((sh) => closeSheet(sh.id));
});

/* ================= Form catatan ================= */
// Tiap jenis punya nominal dan deskripsi sendiri. Hanya satu yang terbuka (radio), tapi yang tertutup tetap tersimpan
// bila nominalnya diisi, dan ringkasannya tampil di barisnya supaya jelas apa yang akan disimpan.
const TYPES = {
  out: { box: 'typeOut', radio: 'rOut', body: 'bodyOut', amt: 'inOut', desc: 'descOut', sum: 'sumOut' },
  in: { box: 'typeIn', radio: 'rIn', body: 'bodyIn', amt: 'inIn', desc: 'descIn', sum: 'sumIn' },
};
let formType = null; // 'out' | 'in' | null (belum memilih)

function updateSums() {
  Object.entries(TYPES).forEach(([k, c]) => {
    const n = parseAmount($(c.amt).value);
    $(c.sum).textContent = k !== formType && n > 0 ? rupiah(n) : '';
  });
}
function setType(t) {
  formType = t;
  Object.entries(TYPES).forEach(([k, c]) => {
    const open = k === t;
    $(c.box).classList.toggle('open', open);
    $(c.radio).checked = open;
    $(c.body).toggleAttribute('inert', !open);
  });
  updateSums();
}
function bindMoney(inp) {
  inp.addEventListener('input', () => {
    const d = inp.value.replace(/\D/g, '').slice(0, 12).replace(/^0+(?=\d)/, '');
    inp.value = d === '' ? '' : fmtNum(Number(d));
    updateSums();
  });
  inp.addEventListener('focus', () => { if (parseAmount(inp.value) === 0) inp.value = ''; });
  inp.addEventListener('blur', () => { if (!inp.value) inp.value = '0'; });
}
function setFormError(msg) { $('formErr').textContent = msg || ''; }

function resetForm() {
  Object.values(TYPES).forEach((c) => { $(c.amt).value = '0'; $(c.desc).value = ''; });
  setFormError('');
}
let addDate = null; // tanggal tujuan catatan baru: hari terpilih bila sudah berlalu/hari ini, selain itu hari ini
function openAdd() {
  editing = null;
  const t = todayKey();
  addDate = state.selected <= t ? state.selected : t;
  $('formTitle').textContent = addDate === t ? 'Buat Catatan' : 'Buat Catatan • ' + fmtLong(addDate);
  $('form').classList.remove('editing');
  Object.values(TYPES).forEach((c) => { $(c.radio).disabled = false; });
  resetForm();
  setType(null);
  openSheet('sheetForm');
}
function openEdit(item) {
  editing = item;
  $('formTitle').textContent = 'Ubah Catatan';
  $('form').classList.add('editing');
  resetForm();
  const c = TYPES[item.type];
  $(c.amt).value = fmtNum(item.amount);
  $(c.desc).value = item.desc || '';
  Object.values(TYPES).forEach((t) => { $(t.radio).disabled = true; });
  setType(item.type);
  openSheet('sheetForm');
}
async function submitForm(e) {
  e.preventDefault();
  const btn = $('btnConfirm');
  if (btn.disabled) return;
  const read = (k) => ({ amount: parseAmount($(TYPES[k].amt).value), desc: $(TYPES[k].desc).value.trim().slice(0, 200) });
  btn.disabled = true;
  try {
    if (editing) {
      const { amount, desc } = read(editing.type);
      if (amount <= 0) { setFormError('Nominal harus lebih dari 0. Untuk membuang catatan, gunakan tombol hapus.'); return; }
      await dbUpdate({ ...editing, amount, desc });
    } else {
      const out = read('out'), inc = read('in');
      if (out.amount <= 0 && inc.amount <= 0) {
        setFormError(formType ? 'Isi nominalnya terlebih dahulu.' : 'Pilih Pengeluaran atau Penghasilan, lalu isi nominalnya.');
        return;
      }
      const date = addDate || todayKey(), now = Date.now();
      const items = [];
      if (out.amount > 0) items.push({ id: uid(), date, type: 'out', amount: out.amount, desc: out.desc, createdAt: now });
      if (inc.amount > 0) items.push({ id: uid(), date, type: 'in', amount: inc.amount, desc: inc.desc, createdAt: now + 1 });
      await dbAdd(items);
      state.offset = weekOffsetOf(date);
      state.selected = date;
    }
    closeSheet('sheetForm');
    await render();
  } catch (err) {
    setFormError('Gagal menyimpan: ' + (err && err.message ? err.message : 'kesalahan database'));
  } finally {
    btn.disabled = false;
  }
}
async function removeTx(item) {
  if (!confirm(`Hapus catatan ${item.type === 'out' ? 'pengeluaran' : 'penghasilan'} ${rupiah(item.amount)}?`)) return;
  try { await dbDelete(item.id, item.date); } catch (e) { alert('Gagal menghapus.'); }
  render();
}

/* ================= Beri Saran ================= */
const sigOf = (txs) => txs.map((t) => `${t.id}:${t.type}:${t.amount}:${t.desc || ''}`).sort().join('|');

function renderInline(parent, text) {
  text.split(/\*\*(.+?)\*\*/).forEach((p, i) => {
    if (!p) return;
    if (i % 2) parent.append(h('strong', { text: p }));
    else parent.append(document.createTextNode(p));
  });
}
function renderAdvice(container, text) {
  container.replaceChildren();
  let ul = null;
  String(text).split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (!line) { ul = null; return; }
    let m;
    if ((m = line.match(/^#{1,4}\s+(.*)$/)) || (m = line.match(/^\*\*(.+?)\*\*:?$/))) {
      ul = null; container.append(h('h4', { text: m[1].replace(/\*\*/g, '') }));
    } else if ((m = line.match(/^[-*•]\s+(.*)$/))) {
      if (!ul) { ul = h('ul'); container.append(ul); }
      const li = h('li'); renderInline(li, m[1]); ul.append(li);
    } else {
      ul = null; const p = h('p'); renderInline(p, line); container.append(p);
    }
  });
}
function showSaran(kind, text) {
  const body = $('saranBody');
  if (kind === 'loading') {
    body.replaceChildren(h('div', { class: 'spin' }), h('p', { class: 'center', text: 'AI sedang menganalisis catatanmu…' }));
  } else if (kind === 'ok') {
    renderAdvice(body, text);
  } else {
    body.replaceChildren(h('p', { class: 'msg' + (kind === 'error' ? ' bad' : ''), text }));
  }
}
async function fetchSaran(date, txs) {
  let res;
  try {
    res = await fetch('/api/saran', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, items: txs.map((x) => ({ type: x.type, amount: x.amount, desc: x.desc || '' })) }),
    });
  } catch (e) {
    throw new Error('Tidak ada koneksi internet. Coba lagi saat online.');
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* abaikan */ }
  if (res.status === 429) throw new Error(data.error || 'Terlalu banyak permintaan atau kuota AI habis. Coba lagi nanti.');
  if (!res.ok || !data.saran) throw new Error(data.error || 'Gagal mendapatkan saran. Coba lagi nanti.');
  return data.saran;
}
async function openAdvice(key) {
  if (key > todayKey()) return;
  saranKey = key;
  $('saranTitle').textContent = 'Saran · ' + fmtLong(key);
  showSaran('loading'); // bersihkan isi lama agar tidak muncul sekilas
  openSheet('sheetSaran');
  try {
    const cached = await dbGetAdvice(key);
    if (saranKey !== key) return;
    if (cached) { showSaran('ok', cached.text); return; }
    const txs = await dbRange(key, key);
    if (saranKey !== key) return;
    if (!txs.length) { showSaran('msg', 'Tidak ada catatan di hari ini.'); return; }
    showSaran('loading');
    if (state.pending.has(key)) return; // permintaan yang sama masih berjalan, hasilnya tampil otomatis
    state.pending.add(key);
    try {
      const text = await fetchSaran(key, txs);
      const now = await dbRange(key, key);
      if (sigOf(now) === sigOf(txs)) await dbPutAdvice({ date: key, text, createdAt: Date.now() });
      if (saranKey === key) showSaran('ok', text);
      render();
    } catch (e) {
      if (saranKey === key) showSaran('error', e.message);
    } finally {
      state.pending.delete(key);
    }
  } catch (e) {
    if (saranKey === key) showSaran('error', 'Terjadi kesalahan: ' + e.message);
  }
}

/* ================= Pengaturan ================= */
function openSettings() {
  $('backupMsg').textContent = '';
  $('acctName').textContent = '@' + (state.user ? state.user.username : '');
  openSheet('sheetSettings');
}
async function doExport() {
  try {
    const data = await dbExport();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `catatan-keuangan-${todayKey()}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    $('backupMsg').textContent = `Diekspor: ${data.tx.length} catatan.`;
  } catch (e) { $('backupMsg').textContent = 'Gagal mengekspor: ' + e.message; }
}
async function doImport(file) {
  const msg = $('backupMsg');
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.app !== 'catatan-keuangan' || !Array.isArray(data.tx)) throw new Error('Format file tidak dikenali.');
    const txs = [];
    data.tx.forEach((x) => {
      if (!x || typeof x.id !== 'string' || !DATE_RE.test(x.date) || (x.type !== 'out' && x.type !== 'in')) return;
      const amount = Number(x.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return;
      txs.push({ id: x.id.slice(0, 64), date: x.date, type: x.type, amount: Math.round(amount), desc: typeof x.desc === 'string' ? x.desc.slice(0, 200) : '', createdAt: Number(x.createdAt) || 0 });
    });
    const advices = (Array.isArray(data.advice) ? data.advice : [])
      .filter((a) => a && DATE_RE.test(a.date) && typeof a.text === 'string')
      .map((a) => ({ date: a.date, text: a.text.slice(0, 4000), createdAt: Number(a.createdAt) || 0 }));
    if (!txs.length) throw new Error('Tidak ada catatan valid di file ini.');
    if (!confirm(`Impor ${txs.length} catatan ke akun @${state.user.username}? Data akan digabung dengan catatan yang sudah ada di akun ini.`)) return;
    await dbImport(txs, advices);
    msg.textContent = `Berhasil mengimpor ${txs.length} catatan ke akun ini.`;
    render();
  } catch (e) { msg.textContent = 'Gagal mengimpor: ' + e.message; }
}

/* ================= Akun & layar awal ================= */
const gate = $('gate');
const GATE_ORDER = { landing: 0, login: 1, register: 2, forgot: 3, reset: 4, loading: 9 };
const gv = (v) => gate.querySelector(`.gv[data-v="${v}"]`);
const EASE_OUT = 'cubic-bezier(.2,.8,.2,1)';
let gateToken = 0;
let gateDrops = false; // tirai turun hanya saat keluar dari aplikasi (logout, hapus akun), bukan saat pertama dibuka

// pesan kesalahan: teks muncul dari atas dan lembarnya bergetar sebentar
function setGateErr(id, msg) {
  const el = $(id);
  el.textContent = msg || '';
  el.classList.remove('pop');
  if (!msg) return;
  void el.offsetWidth;
  el.classList.add('pop');
  const led = el.closest('.ledger');
  if (led) { led.classList.remove('shake'); void led.offsetWidth; led.classList.add('shake'); }
}

function setGateOk(id, msg) {
  const el = $(id);
  el.textContent = msg || '';
  el.classList.remove('pop');
  if (!msg) return;
  void el.offsetWidth;
  el.classList.add('pop');
}

/* ---- lupa password: Gmail + kode 6 angka -> username + password baru -> kembali ke login ---- */
let fgCd = null, fgTimer = 0, fgBusy = false, resetCtx = null;
const MAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function fgUpdate() {
  const e = $('fgMail').value.trim().toLowerCase();
  const same = fgCd && fgCd.email === e;
  const left = same ? Math.max(0, Math.ceil((fgCd.until - Date.now()) / 1000)) : 0;
  const b = $('btnSendCode');
  b.disabled = fgBusy || !MAIL_OK.test(e) || e.length > 254 || left > 0; // hanya aktif bila Gmail sudah diisi dan cooldown selesai
  b.textContent = left > 0 ? `Kirim ulang (${left})` : same ? 'Kirim ulang' : 'Kirim kode';
  if (left > 0 && !fgTimer) fgTimer = setInterval(fgUpdate, 1000);
  if (left === 0 && fgTimer) { clearInterval(fgTimer); fgTimer = 0; }
}
function clearForgot() {
  ['fgMail', 'fgCode', 'resetPass'].forEach((id) => { $(id).value = ''; });
  $('resetUser').textContent = '';
  fgCd = null; fgBusy = false; resetCtx = null;
  if (fgTimer) { clearInterval(fgTimer); fgTimer = 0; }
  fgUpdate();
}
function openForgot() { clearForgot(); showGate('forgot'); }
async function sendCode() {
  const email = $('fgMail').value.trim();
  if (!MAIL_OK.test(email)) return;
  setGateErr('fgErr', ''); setGateOk('fgOk', '');
  fgBusy = true; fgUpdate();
  try {
    const d = await api('/api/auth', { action: 'forgot_send', email });
    fgCd = { email: email.toLowerCase(), until: Date.now() + (d.retryIn || 60) * 1000 };
    setGateOk('fgOk', 'Jika Gmail itu terdaftar, kode sudah dikirim. Cek kotak masuk atau folder Spam.');
    $('fgCode').focus({ preventScroll: true });
  } catch (ex) {
    if (ex.data && ex.data.retryIn) fgCd = { email: email.toLowerCase(), until: Date.now() + ex.data.retryIn * 1000 };
    setGateErr('fgErr', ex.message);
  }
  fgBusy = false; fgUpdate();
}
async function submitForgot(e) {
  e.preventDefault();
  const email = $('fgMail').value.trim(), code = $('fgCode').value.trim();
  setGateErr('fgErr', ''); setGateOk('fgOk', '');
  if (!MAIL_OK.test(email)) { setGateErr('fgErr', 'Isi Gmail akunmu.'); return; }
  if (!/^\d{6}$/.test(code)) { setGateErr('fgErr', 'Masukkan kode 6 angka dari email.'); return; }
  const btn = $('btnFgGo'); btn.disabled = true;
  try {
    const d = await api('/api/auth', { action: 'forgot_verify', email, code });
    resetCtx = { email, token: d.token };
    $('resetUser').textContent = d.username;
    $('resetPass').value = '';
    showGate('reset');
  } catch (ex) { setGateErr('fgErr', ex.message); }
  btn.disabled = false;
}
async function submitReset(e) {
  e.preventDefault();
  if (!resetCtx) { showGate('login'); return; }
  const password = $('resetPass').value;
  setGateErr('resetErr', '');
  if (password.length < 6) { setGateErr('resetErr', 'Password minimal 6 karakter.'); return; }
  const btn = $('btnResetGo'); btn.disabled = true;
  try {
    await api('/api/auth', { action: 'forgot_reset', email: resetCtx.email, token: resetCtx.token, password });
    clearForgot();
    showGate('login');
    setGateOk('loginOk', 'Password berhasil diperbarui. Silakan login dengan password barumu.');
  } catch (ex) { setGateErr('resetErr', ex.message); }
  btn.disabled = false;
}

// pindah antar layar dengan gerak geser (bukan fade). Ke/dari loading bergerak vertikal, selain itu horizontal.
function showGate(view, msg) {
  const token = ++gateToken;
  document.body.classList.add('gated');
  document.querySelectorAll('.sheet.open').forEach((sh) => closeSheet(sh.id));
  hidePasswords(gate);
  const wasHidden = gate.hidden;
  const prev = gate.dataset.view;
  gate.hidden = false;
  gate.dataset.view = view;
  gate.getAnimations({ subtree: true }).forEach((an) => { if (an.id === 'gate-move') an.cancel(); });
  gate.querySelectorAll('.gv').forEach((s) => { s.classList.remove('leaving'); s.style.zIndex = ''; });
  const next = gv(view), from = !wasHidden && prev && prev !== view ? gv(prev) : null;
  gate.querySelectorAll('.gv').forEach((s) => { if (s !== next) s.classList.remove('on'); });
  next.classList.add('on');
  next.scrollTop = 0;
  setGateErr('loginErr', view === 'login' ? msg : '');
  setGateErr('regErr', view === 'register' ? msg : '');
  setGateErr('fgErr', view === 'forgot' ? msg : '');
  setGateErr('resetErr', view === 'reset' ? msg : '');
  setGateOk('loginOk', '');
  if (view !== 'forgot') setGateOk('fgOk', '');

  if (from && !reduceMotion()) {
    const axis = view === 'loading' || prev === 'loading' ? 'Y' : 'X';
    const fwd = GATE_ORDER[view] > GATE_ORDER[prev];
    const tr = (p) => `translate${axis}(${p}%)`;
    const opt = { duration: 520, easing: EASE_OUT, id: 'gate-move' };
    from.classList.add('leaving');
    const done = () => { if (token === gateToken) { from.classList.remove('leaving'); from.style.zIndex = ''; next.style.zIndex = ''; } };
    if (fwd) { // layar baru masuk menimpa dari tepi, layar lama sedikit mundur
      next.style.zIndex = 2; from.style.zIndex = 1;
      next.animate([{ transform: tr(100) }, { transform: tr(0) }], opt);
      from.animate([{ transform: tr(0) }, { transform: tr(-22) }], opt).finished.then(done, done);
    } else { // layar lama meluncur keluar, layar di bawahnya maju dari belakang
      from.style.zIndex = 2; next.style.zIndex = 1;
      from.animate([{ transform: tr(0) }, { transform: tr(100) }], opt).finished.then(done, done);
      next.animate([{ transform: tr(-22) }, { transform: tr(0) }], opt);
    }
  } else if (wasHidden && gateDrops && !reduceMotion()) {
    gate.animate([{ transform: 'translateY(-100%)' }, { transform: 'none' }], { duration: 560, easing: EASE_OUT, id: 'gate-move' });
  }
  if (view === 'landing') heroStart(); else heroStop();
  if ((view === 'login' || view === 'register' || view === 'forgot' || view === 'reset') && !matchMedia('(pointer: coarse)').matches) {
    const first = next.querySelector('input');
    if (first) setTimeout(() => { if (token === gateToken) first.focus({ preventScroll: true }); }, 450);
  }
}

/* ---- grafik contoh di landing: dua garis ditulis, lalu bisa digeser untuk melihat angka tiap hari ---- */
const HERO = {
  names: ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'],
  days: ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'],
  out: [18000, 45000, 25000, 60000, 30000, 85000, 12000],
  inc: [0, 120000, 100000, 0, 150000, 40000, 0],
  L: 10, R: 330, T: 12, B: 134, MAX: 160000,
};
let heroEls = null, heroTimers = [], heroIdx = -1, heroUser = false;
const heroX = (i) => HERO.L + ((HERO.R - HERO.L) * i) / 6;
const heroY = (v) => HERO.T + (HERO.B - HERO.T) * (1 - v / HERO.MAX);
const rpFmt = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');
function heroBuild() {
  const svg = $('heroSvg');
  const E = (t, at, tx) => { const e = document.createElementNS('http://www.w3.org/2000/svg', t); Object.entries(at).forEach(([k, v]) => e.setAttribute(k, v)); if (tx) e.textContent = tx; return e; };
  [0, 0.5, 1].forEach((f) => svg.append(E('line', { class: 'hg', x1: HERO.L - 4, x2: HERO.R + 4, y1: HERO.B - (HERO.B - HERO.T) * f, y2: HERO.B - (HERO.B - HERO.T) * f })));
  const xl = HERO.days.map((d, i) => E('text', { class: 'hx', x: heroX(i), y: 152 }, d));
  svg.append(...xl);
  const pts = (k) => HERO[k].map((v, i) => `${heroX(i).toFixed(1)},${heroY(v).toFixed(1)}`).join(' ');
  svg.append(E('polyline', { class: 'hl o', pathLength: 1, points: pts('out') }), E('polyline', { class: 'hl i', pathLength: 1, points: pts('inc') }));
  ['out', 'inc'].forEach((k, n) => HERO[k].forEach((v, i) => svg.append(
    E('circle', { class: 'hd ' + (n ? 'i' : 'o'), cx: heroX(i).toFixed(1), cy: heroY(v).toFixed(1), r: 3.4, style: `animation-delay:${(0.45 + i * 0.17 + n * 0.3).toFixed(2)}s` }))));
  const mk = E('line', { class: 'mk mk-line idle', x1: 0, x2: 0, y1: HERO.T - 4, y2: HERO.B });
  const dO = E('circle', { class: 'mk mk-dot o idle', r: 5.5 }), dI = E('circle', { class: 'mk mk-dot i idle', r: 5.5 });
  svg.append(mk, dO, dI);
  const hit = E('rect', { x: 0, y: 0, width: 340, height: 160, fill: 'transparent' });
  svg.append(hit);
  const idxAt = (e) => {
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * 340;
    return Math.max(0, Math.min(6, Math.round(((vx - HERO.L) / (HERO.R - HERO.L)) * 6)));
  };
  const take = (e) => { heroUser = true; heroStop(); [dO, dI].forEach((d) => d.classList.remove('idle')); heroSet(idxAt(e)); };
  hit.addEventListener('pointerdown', (e) => { try { hit.setPointerCapture(e.pointerId); } catch (x) { /* abaikan */ } take(e); });
  hit.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'mouse') take(e); });
  heroEls = { mk, dO, dI, xl };
}
function heroSet(i) {
  if (!heroEls || i === heroIdx) return;
  const first = heroIdx < 0;
  heroIdx = i;
  const { mk, dO, dI, xl } = heroEls;
  const was = mk.classList.contains('idle');
  mk.classList.remove('idle');
  const x = heroX(i);
  mk.style.transform = `translateX(${x}px)`;
  dO.style.transform = `translate(${x}px, ${heroY(HERO.out[i])}px)`;
  dI.style.transform = `translate(${x}px, ${heroY(HERO.inc[i])}px)`;
  if (first || was) [mk, dO, dI].forEach((e) => { e.style.transition = 'none'; void e.getBoundingClientRect(); e.style.transition = ''; });
  xl.forEach((t, n) => t.classList.toggle('sel', n === i));
  $('heroDay').textContent = HERO.names[i];
  heroCount($('heroOut'), HERO.out[i]); heroCount($('heroIn'), HERO.inc[i]);
}
// angka berputar menuju nilai baru
function heroCount(el, to) {
  const from = Number(el.dataset.v ?? to); el.dataset.v = to;
  if (reduceMotion()) { el.textContent = rpFmt(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    if (Number(el.dataset.v) !== to) return;
    const p = Math.min(1, (t - t0) / 420), e = 1 - Math.pow(1 - p, 3);
    el.textContent = rpFmt(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function heroStart() {
  if (!heroEls) heroBuild();
  heroStop();
  heroUser = false; heroIdx = -1;
  [heroEls.mk, heroEls.dO, heroEls.dI].forEach((e) => e.classList.add('idle'));
  heroEls.xl.forEach((t) => t.classList.remove('sel'));
  $('heroDay').textContent = 'Contoh seminggu, geser grafiknya';
  $('heroOut').dataset.v = 275000; $('heroIn').dataset.v = 410000;
  $('heroOut').textContent = rpFmt(275000); $('heroIn').textContent = rpFmt(410000);
  if (reduceMotion()) return;
  // satu gerakan pembuka: penanda menyapu dari Senin ke Jumat setelah garis selesai ditulis
  [0, 1, 2, 3, 4].forEach((i, n) => heroTimers.push(setTimeout(() => {
    if (heroUser) return;
    heroEls.dO.classList.remove('idle'); heroEls.dI.classList.remove('idle');
    heroSet(i);
  }, 1900 + n * 420)));
}
function heroStop() { heroTimers.forEach(clearTimeout); heroTimers = []; }

function resetAppState() {
  state.user = null; state.mode = 'week'; state.offset = 0; state.pOffset = 0; state.dir = 0;
  state.selected = todayKey(); state.lastToday = todayKey(); state.seq++; state.pending.clear();
  editing = null; saranKey = null;
  $('detail').replaceChildren();
  admSeq++; clearTimeout(admTimer);
  $('admList').replaceChildren(); $('admQ').value = '';
  ['acMail', 'acUser', 'acCur', 'acNew'].forEach((id) => { $(id).value = ''; });
}
// masuk ke aplikasi: layar loading tetap tampil sampai data pertama selesai dimuat
async function startApp(user) {
  resetAppState();
  state.user = user;
  applyRole();
  try { await render(); } catch (e) {
    $('detail').replaceChildren(h('p', { class: 'empty', text: 'Gagal memuat data: ' + e.message }));
  }
  document.body.classList.remove('gated');
  movePill(false);
  gateToken++;
  heroStop();
  gateDrops = true;
  if (reduceMotion()) { gate.hidden = true; return; }
  // tirai layar awal terangkat ke atas, memperlihatkan Cal di bawahnya
  gate.animate([{ transform: 'none' }, { transform: 'translateY(-100%)' }], { duration: 620, easing: 'cubic-bezier(.65,0,.25,1)', id: 'gate-move', fill: 'forwards' })
    .finished.then(() => { gate.hidden = true; gate.getAnimations().forEach((an) => an.cancel()); }, () => { gate.hidden = true; });
}
onSessionLost = () => {
  if (!state.user) return;
  resetAppState();
  showGate('login', 'Sesi berakhir. Silakan masuk lagi.');
};
async function boot() {
  showGate('loading');
  let user = null, down = false;
  try {
    const r = await fetch('/api/auth', { cache: 'no-store' });
    if (r.ok) user = (await r.json()).user;
    else if (r.status !== 401) down = true;
  } catch (e) { down = true; }
  if (user) return startApp(user);
  if (down) { showGate('login', 'Tidak bisa terhubung ke server. Periksa internet lalu muat ulang.'); return; }
  showGate('landing');
}
async function submitAuth(kind, e) {
  e.preventDefault();
  const reg = kind === 'register';
  const f = reg ? { action: 'register', email: $('regMail').value.trim(), username: $('regUser').value.trim(), password: $('regPass').value }
    : { action: 'login', username: $('loginUser').value.trim(), password: $('loginPass').value };
  setGateErr(reg ? 'regErr' : 'loginErr', '');
  if ((reg && !f.email) || !f.username || !f.password) { setGateErr(reg ? 'regErr' : 'loginErr', reg ? 'Isi Gmail, username, dan password.' : 'Isi username dan password.'); return; }
  showGate('loading');
  try {
    const d = await api('/api/auth', f);
    ['loginPass', 'regPass', 'regMail', 'regUser', 'loginUser'].forEach((id) => { $(id).value = ''; });
    await startApp(d.user);
  } catch (ex) {
    showGate(kind, ex.message);
  }
}
async function doLogout() {
  if (!confirm(`Keluar dari akun @${state.user.username}?`)) return;
  try { await api('/api/auth', { action: 'logout' }); } catch (e) { /* tetap keluar di sisi aplikasi */ }
  resetAppState();
  showGate('login');
}
// Hapus akun: dua konfirmasi, lalu lembar khusus yang meminta username dan password.
function startDeleteAccount() {
  if (!confirm('PERINGATAN: akun beserta SEMUA catatan dan saran AI di dalamnya akan dihapus permanen dan tidak bisa dikembalikan. Lanjutkan?')) return;
  if (!confirm('Peringatan terakhir sebelum langkah akhir: setelah dihapus, akun ini tidak bisa dipakai masuk lagi. Sudah ekspor backup bila perlu?')) return;
  closeSheet('sheetSettings');
  $('delUser').value = ''; $('delPass').value = ''; $('delErr').textContent = '';
  $('delUserHint').textContent = state.user.username;
  $('btnDelFinal').disabled = true;
  openSheet('sheetDelAcc');
}
function delReady() {
  $('btnDelFinal').disabled = !($('delUser').value.trim().toLowerCase() === state.user.username.toLowerCase() && $('delPass').value);
}
async function submitDeleteAccount(e) {
  e.preventDefault();
  const btn = $('btnDelFinal');
  if (btn.disabled) return;
  btn.disabled = true;
  $('delErr').textContent = '';
  try {
    await api('/api/auth', { action: 'delete', password: $('delPass').value });
    resetAppState();
    showGate('landing');
  } catch (ex) {
    $('delErr').textContent = ex.message;
    delReady();
  }
}

/* ================= Akun saya & Kelola akun ================= */
// peran menentukan fungsi tombol di kiri Developer: admin = Kelola (semua akun), pengguna = Akun (akun sendiri)
function applyRole() {
  const adm = !!(state.user && state.user.isAdmin);
  $('acctLbl').textContent = adm ? 'Kelola' : 'Akun';
  $('btnAcct').setAttribute('aria-label', adm ? 'Kelola akun' : 'Akun saya');
  document.querySelector('#btnAcct .ic-user').toggleAttribute('hidden', adm);
  document.querySelector('#btnAcct .ic-admin').toggleAttribute('hidden', !adm);
  $('fldDelAcc').hidden = adm; // akun admin tidak bisa dihapus
}
function setSelf(u) {
  state.user = { ...state.user, username: u.username, email: u.email, isAdmin: !!u.isAdmin };
  $('acctName').textContent = '@' + state.user.username;
}
function openAcct() {
  if (state.user.isAdmin) openAdmin(); else openMyAcct();
}

function openMyAcct() {
  $('acMail').value = state.user.email || '';
  $('acUser').value = state.user.username;
  $('acCur').value = ''; $('acNew').value = '';
  $('acErr').textContent = ''; $('acOk').textContent = '';
  openSheet('sheetAcct');
}
async function submitMyAcct(e) {
  e.preventDefault();
  const btn = $('btnAcctSave');
  if (btn.disabled) return;
  const body = { action: 'profile', email: $('acMail').value.trim(), username: $('acUser').value.trim() };
  if ($('acNew').value || $('acCur').value) { body.password = $('acNew').value; body.currentPassword = $('acCur').value; }
  $('acErr').textContent = ''; $('acOk').textContent = '';
  if (body.password === '' ) { $('acErr').textContent = 'Isi password baru, atau kosongkan kedua kolom password.'; return; }
  btn.disabled = true;
  try {
    const d = await api('/api/auth', body);
    setSelf(d.user);
    $('acMail').value = d.user.email; $('acUser').value = d.user.username;
    $('acCur').value = ''; $('acNew').value = '';
    hidePasswords($('sheetAcct'));
    $('acOk').textContent = 'Tersimpan.';
  } catch (ex) {
    $('acErr').textContent = ex.message;
  } finally { btn.disabled = false; }
}

let admSeq = 0, admTimer = 0;
function openAdmin() {
  $('admQ').value = '';
  $('admList').replaceChildren();
  openSheet('sheetAdmin');
  loadAdmin();
}
async function loadAdmin() {
  const seq = ++admSeq, q = $('admQ').value;
  $('admInfo').textContent = 'Memuat…';
  try {
    const d = await api('/api/auth', { action: 'admin_list', q });
    if (seq !== admSeq) return;
    $('admInfo').textContent = q
      ? `${d.users.length} dari ${d.total} akun cocok` : `${d.total} akun`;
    if (d.truncated) $('admInfo').textContent += ` (menampilkan ${d.total} pertama)`;
    $('admList').replaceChildren(...(d.users.length ? d.users.map(accountItem)
      : [h('li', { class: 'empty', text: 'Tidak ada akun yang cocok.' })]));
  } catch (ex) {
    if (seq !== admSeq) return;
    $('admInfo').textContent = ex.message;
    $('admList').replaceChildren();
  }
}
const HIT = { username: 'username', gmail: 'Gmail', password: 'password' };
function accountItem(u) {
  const id = 'ac' + u.id;
  const li = h('li', { class: 'ac-item' });
  const head = h('button', { type: 'button', class: 'ac-head', 'aria-expanded': 'false', 'aria-controls': id + '-b' },
    h('span', { class: 'ac-who' },
      h('span', { class: 'ac-name' }, h('b', { text: u.username }), u.isAdmin && h('span', { class: 'ac-tag', text: 'admin' }), u.self && h('span', { class: 'ac-tag', text: 'kamu' })),
      h('span', { class: 'ac-mail', text: u.email }),
      u.match && u.match.length ? h('span', { class: 'ac-hit', text: 'Cocok: ' + u.match.map((m) => HIT[m]).join(', ') }) : null),
    h('span', { class: 'ac-chev', 'aria-hidden': 'true', text: '›' }));
  const err = h('p', { class: 'err', role: 'alert' }), ok = h('p', { class: 'ok-msg', role: 'status' });
  const mail = h('input', { id: id + '-m', class: 'plain', type: 'email', inputmode: 'email', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: 254, value: u.email });
  const user = h('input', { id: id + '-u', class: 'plain', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: 20, value: u.username });
  const pass = h('input', { id: id + '-p', class: 'plain', type: 'password', autocomplete: 'new-password', maxlength: 100, placeholder: 'Kosongkan bila tidak diubah' });
  const eye = h('button', { type: 'button', class: 'eye', 'data-for': id + '-p', 'aria-label': 'Tampilkan password', 'aria-pressed': 'false' });
  eye.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle class="eye-p" cx="12" cy="12" r="3"/><path class="eye-s" d="M4 20 20 4" pathLength="1"/></svg>';
  const save = h('button', { type: 'submit', class: 'btn-primary', text: 'Simpan' });
  const form = h('form', { novalidate: true },
    h('label', { class: 'lbl', for: id + '-m', text: 'Gmail' }), mail,
    h('label', { class: 'lbl', for: id + '-u', text: 'Username' }), user,
    h('label', { class: 'lbl', for: id + '-p', text: 'Password baru' }), h('div', { class: 'pw' }, pass, eye),
    err, ok, h('div', { class: 'actions' }, save));
  const body = h('div', { class: 'ac-body', id: id + '-b', inert: true }, h('div', { class: 'ac-in' }, form));
  head.addEventListener('click', () => {
    const open = !li.classList.contains('open');
    document.querySelectorAll('#admList .ac-item.open').forEach((o) => { if (o !== li) toggleItem(o, false); });
    toggleItem(li, open);
  });
  form.addEventListener('input', () => { err.textContent = ''; ok.textContent = ''; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    err.textContent = ''; ok.textContent = '';
    const req = { action: 'admin_update', id: u.id, email: mail.value.trim(), username: user.value.trim() };
    if (pass.value) req.password = pass.value;
    save.disabled = true;
    try {
      const d = await api('/api/auth', req);
      u.username = d.user.username; u.email = d.user.email;
      head.querySelector('.ac-name b').textContent = u.username;
      head.querySelector('.ac-mail').textContent = u.email;
      mail.value = u.email; user.value = u.username; pass.value = '';
      setEye(eye, false);
      if (u.self) setSelf(d.user);
      ok.textContent = req.password && !u.self ? 'Tersimpan. Akun ini harus login ulang dengan password baru.' : 'Tersimpan.';
    } catch (ex) { err.textContent = ex.message; } finally { save.disabled = false; }
  });
  li.append(head, body);
  return li;
}
function toggleItem(li, open) {
  li.classList.toggle('open', open);
  li.querySelector('.ac-head').setAttribute('aria-expanded', String(open));
  li.querySelector('.ac-body').inert = !open;
  if (!open) hidePasswords(li);
}

/* ================= Rollover tengah malam ================= */
function checkRollover() {
  if (!state.user) return;
  const t = todayKey();
  if (t !== state.lastToday) {
    state.lastToday = t; state.offset = 0; state.pOffset = 0; state.selected = t;
    render();
  }
}

/* ================= Init ================= */
function init() {
  Object.entries(TYPES).forEach(([k, c]) => {
    bindMoney($(c.amt));
    $(c.radio).addEventListener('change', () => {
      setType(k); setFormError('');
      $(c.amt).focus({ preventScroll: true });
    });
  });
  window.addEventListener('resize', () => movePill(false));
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('prevP').addEventListener('click', () => { state.pOffset -= 1; state.dir = -1; render(); });
  $('nextP').addEventListener('click', () => { if (state.pOffset < 0) { state.pOffset += 1; state.dir = 1; render(); } });
  $('btnAdd').addEventListener('click', openAdd);
  $('form').addEventListener('submit', submitForm);
  $('form').addEventListener('input', () => setFormError('')); // pesan error hilang begitu pengguna mulai mengisi
  $('btnSettings').addEventListener('click', openSettings);
  $('btnDev').addEventListener('click', () => openSheet('sheetDev'));
  $('prevWeek').addEventListener('click', () => { state.offset -= 1; render(); });
  $('nextWeek').addEventListener('click', () => { if (state.offset < 0) { state.offset += 1; render(); } });
  $('btnExport').addEventListener('click', doExport);
  $('btnImport').addEventListener('click', () => $('fileImport').click());
  $('fileImport').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) doImport(f); });
  $('btnClear').addEventListener('click', async () => {
    if (!confirm(`Hapus SEMUA catatan di akun @${state.user.username}? Tindakan ini tidak bisa dibatalkan.`)) return;
    if (!confirm('Yakin? Pastikan sudah ekspor backup bila perlu.')) return;
    try { await dbClear(); } catch (e) { $('backupMsg').textContent = 'Gagal menghapus: ' + e.message; return; }
    closeSheet('sheetSettings');
    render();
  });
  $('btnLogout').addEventListener('click', doLogout);
  $('btnAcct').addEventListener('click', openAcct);
  $('formAcct').addEventListener('submit', submitMyAcct);
  $('formAcct').addEventListener('input', () => { $('acErr').textContent = ''; $('acOk').textContent = ''; });
  $('admQ').addEventListener('input', () => { clearTimeout(admTimer); admTimer = setTimeout(loadAdmin, 350); });
  // tombol mata: lihat / sembunyikan password
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.eye');
    if (!b) return;
    const inp = $(b.dataset.for), caret = inp.selectionStart;
    setEye(b, inp.type === 'password');
    inp.focus({ preventScroll: true });
    try { inp.setSelectionRange(caret, caret); } catch (x) { /* abaikan */ }
  });
  $('btnDelAcc').addEventListener('click', startDeleteAccount);
  $('formDelAcc').addEventListener('submit', submitDeleteAccount);
  $('formDelAcc').addEventListener('input', delReady);
  $('btnNext').addEventListener('click', () => showGate('login'));
  $('toRegister').addEventListener('click', () => showGate('register'));
  $('toLogin').addEventListener('click', () => showGate('login'));
  $('toForgot').addEventListener('click', openForgot);
  $('fgBack').addEventListener('click', () => { clearForgot(); showGate('login'); });
  $('resetBack').addEventListener('click', () => { clearForgot(); showGate('login'); });
  $('fgMail').addEventListener('input', fgUpdate);
  $('fgCode').addEventListener('input', () => { $('fgCode').value = $('fgCode').value.replace(/\D/g, '').slice(0, 6); });
  $('btnSendCode').addEventListener('click', sendCode);
  $('formForgot').addEventListener('submit', submitForgot);
  $('formReset').addEventListener('submit', submitReset);
  $('formLogin').addEventListener('submit', (e) => submitAuth('login', e));
  $('formRegister').addEventListener('submit', (e) => submitAuth('register', e));
  setInterval(checkRollover, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkRollover(); render(); } });
  boot();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}
init();
})();
