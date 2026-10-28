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
  if (res.status === 401 && !path.startsWith('/api/auth')) { onSessionLost(); throw new Error('Sesi berakhir. Silakan masuk lagi.'); }
  if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan di server (' + res.status + ').');
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
function closeSheet(id) {
  const el = $(id);
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
function showGate(view, msg) {
  document.body.classList.add('gated');
  document.querySelectorAll('.sheet.open').forEach((sh) => closeSheet(sh.id));
  gate.hidden = false;
  gate.dataset.view = view;
  $('loginErr').textContent = view === 'login' && msg ? msg : '';
  $('regErr').textContent = view === 'register' && msg ? msg : '';
  if (view === 'login' || view === 'register') {
    const first = gate.querySelector(`[data-v="${view}"] input`);
    if (first && !matchMedia('(pointer: coarse)').matches) first.focus();
  }
}
function resetAppState() {
  state.user = null; state.mode = 'week'; state.offset = 0; state.pOffset = 0; state.dir = 0;
  state.selected = todayKey(); state.lastToday = todayKey(); state.seq++; state.pending.clear();
  editing = null; saranKey = null;
  $('detail').replaceChildren();
}
// masuk ke aplikasi: layar loading tetap tampil sampai data pertama selesai dimuat
async function startApp(user) {
  resetAppState();
  state.user = user;
  try { await render(); } catch (e) {
    $('detail').replaceChildren(h('p', { class: 'empty', text: 'Gagal memuat data: ' + e.message }));
  }
  gate.hidden = true;
  document.body.classList.remove('gated');
  movePill(false);
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
  const err = $(reg ? 'regErr' : 'loginErr');
  const f = reg ? { action: 'register', email: $('regMail').value.trim(), username: $('regUser').value.trim(), password: $('regPass').value }
    : { action: 'login', username: $('loginUser').value.trim(), password: $('loginPass').value };
  err.textContent = '';
  if ((reg && !f.email) || !f.username || !f.password) { err.textContent = reg ? 'Isi Gmail, username, dan password.' : 'Isi username dan password.'; return; }
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
  $('btnDelAcc').addEventListener('click', startDeleteAccount);
  $('formDelAcc').addEventListener('submit', submitDeleteAccount);
  $('formDelAcc').addEventListener('input', delReady);
  $('btnNext').addEventListener('click', () => showGate('login'));
  $('toRegister').addEventListener('click', () => showGate('register'));
  $('toLogin').addEventListener('click', () => showGate('login'));
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
