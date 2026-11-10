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
function rid() { // id acak huruf kecil+angka (dipakai target/tabungan yang dibuat saat offline)
  const a = new Uint8Array(16); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.random() * 256; });
  return Array.from(a, (x) => (x % 36).toString(36)).join('');
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
  } catch (e) { setNet(false); const er = new Error('Tidak ada koneksi ke server. Periksa internet lalu coba lagi.'); er.offline = true; throw er; }
  setNet(true);
  let data = {};
  try { data = await res.json(); } catch (e) { /* respons bukan JSON */ }
  if (res.status === 401 && (!path.startsWith('/api/auth') || state.user)) { onSessionLost(); throw new Error('Sesi berakhir. Silakan masuk lagi.'); }
  if (!res.ok) { const er = new Error(data.error || 'Terjadi kesalahan di server (' + res.status + ').'); er.data = data; er.status = res.status; throw er; }
  return data;
}
/* --- Offline: cache catatan + antrean sinkron (IndexedDB). Hanya catatan harian. --- */
let netOn = true, qCount = 0, flushing = false;
function setNet(on) { if (netOn !== on) { netOn = on; paintChip(); if (on) flushQueue(); } }
function paintChip() {
  const txt = flushing ? 'Menyinkronkan…' : !netOn ? (qCount ? `Offline · ${qCount} belum tersinkron` : 'Offline') : qCount ? `${qCount} belum tersinkron` : '';
  document.querySelectorAll('.net-chip').forEach((c) => { c.textContent = txt; c.hidden = !txt || !state.user; });
}
const OFF = { db: null };
function offDb() {
  if (!OFF.db) OFF.db = new Promise((ok, no) => {
    const r = indexedDB.open('cal-offline', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('tx', { keyPath: 'id' }); d.createObjectStore('adv', { keyPath: 'date' }); d.createObjectStore('q', { autoIncrement: true }); d.createObjectStore('meta'); };
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
  return OFF.db;
}
// jalankan beberapa operasi dalam satu transaksi; fn menerima fungsi st(nama)
async function offTx(names, mode, fn) {
  const d = await offDb();
  return new Promise((ok, no) => {
    const tr = d.transaction(names, mode); let out;
    tr.oncomplete = () => ok(out); tr.onerror = tr.onabort = () => no(tr.error);
    const pr = (rq) => new Promise((o, n) => { rq.onsuccess = () => o(rq.result); rq.onerror = () => n(rq.error); });
    Promise.resolve(fn((n) => tr.objectStore(n), pr)).then((v) => { out = v; }, no);
  });
}
const offSafe = (p) => p.catch(() => undefined); // cache gagal tidak boleh merusak alur online
const byOrder = (x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.createdAt || 0) - (y.createdAt || 0) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
const strip = (i) => ({ id: i.id, date: i.date, type: i.type, amount: i.amount, desc: i.desc, createdAt: i.createdAt, method: i.method || '' });
async function offAll() { return offTx(['tx'], 'readonly', (st, pr) => pr(st('tx').getAll())); }
async function offCacheRange(from, to, items) {
  await offTx(['tx'], 'readwrite', async (st, pr) => {
    const have = await pr(st('tx').getAll());
    const keep = new Set(items.map((i) => i.id));
    for (const x of have) if (x.date >= from && x.date <= to && !x.p && !keep.has(x.id)) st('tx').delete(x.id);
    for (const i of items) { const cur = have.find((x) => x.id === i.id); if (!(cur && cur.p)) st('tx').put({ ...i, p: 0 }); }
  });
}
async function offMeta(k, v) {
  return offTx(['meta'], 'readwrite', (st, pr) => (v === undefined ? pr(st('meta').get(k)) : (v === null ? st('meta').delete(k) : st('meta').put(v, k))));
}
async function offCount() { qCount = (await offSafe(offTx(['q'], 'readonly', (st, pr) => pr(st('q').count())))) || 0; paintChip(); }
async function offClear() { await offSafe(offTx(['tx', 'adv', 'q', 'meta'], 'readwrite', (st) => { ['tx', 'adv', 'q', 'meta'].forEach((n) => st(n).clear()); })); qCount = 0; paintChip(); }
// terapkan ke cache lokal + (opsional) masukkan ke antrean
async function offApply(op, queue) {
  await offTx(['tx', 'q'], 'readwrite', async (st, pr) => {
    const p = queue ? 1 : 0;
    if (op.op === 'add') op.items.forEach((i) => st('tx').put({ ...strip(i), p }));
    else if (op.op === 'update') { const cur = await pr(st('tx').get(op.id)); if (cur) st('tx').put({ ...cur, amount: op.amount, desc: op.desc, method: op.method != null ? op.method : cur.method, p: cur.p || p }); }
    else if (op.op === 'delete') st('tx').delete(op.id);
    if (queue) st('q').add(op);
  });
  if (queue) { await offCount(); flushQueue(); }
}
// permintaan server untuk satu operasi antrean: [alamat, isi]
function opReq(o) {
  switch (o.op) {
    case 'add': return ['/api/data', { action: 'add', items: o.items }];
    case 'update': return ['/api/data', { action: 'update', id: o.id, amount: o.amount, desc: o.desc, method: o.method }];
    case 'delete': return ['/api/data', { action: 'delete', id: o.id }];
    case 'g-create': return ['/api/goals', { action: 'create', id: o.goal.id, name: o.goal.name, price: o.goal.price, photo: o.goal.photo, createdAt: o.goal.createdAt }];
    case 'g-entry': return ['/api/goals', { action: 'entry', goalId: o.goalId, entryId: o.entryId, dir: o.dir, amount: o.amount, createdAt: o.createdAt }];
    case 'g-close': return ['/api/goals', { action: 'close', goalId: o.goalId }];
    default: return ['/api/goals', { action: 'remove', goalId: o.goalId }];
  }
}
async function offEnqueue(op) { await offTx(['q'], 'readwrite', (st) => { st('q').add(op); }); await offCount(); flushQueue(); }
// kirim antrean berurutan ke server; berhenti bila offline / sesi habis / server error
async function flushQueue() {
  if (flushing || !state.user) return;
  const first = await offSafe(offTx(['q'], 'readonly', (st, pr) => pr(st('q').count())));
  if (!first) return;
  flushing = true; paintChip();
  let sent = false;
  try {
    for (;;) {
      const row = await offTx(['q'], 'readonly', async (st, pr) => { const ks = await pr(st('q').getAllKeys()); return ks.length ? { k: ks[0], v: await pr(st('q').get(ks[0])) } : null; });
      if (!row) break;
      try { const [pth, bdy] = opReq(row.v); await api(pth, bdy); }
      catch (e) {
        // offline / sesi habis (401) / server error (5xx) / terlalu sering (429): antrean dipertahankan.
        // 4xx lain berarti server menolak operasi itu, jadi dibuang agar antrean tidak macet.
        if (e.offline || !e.status || e.status >= 500 || e.status === 429) break;
      }
      await offTx(['q', 'tx'], 'readwrite', async (st, pr) => {
        st('q').delete(row.k);
        const ids = row.v.op === 'add' ? row.v.items.map((i) => i.id) : row.v.op === 'update' ? [row.v.id] : [];
        for (const id of ids) { const cur = await pr(st('tx').get(id)); if (cur && cur.p) st('tx').put({ ...cur, p: 0 }); }
      });
      sent = true; await offCount();
    }
  } catch (e) { /* IndexedDB bermasalah: coba lagi nanti */ }
  flushing = false; await offCount();
  if (sent && state.user && !document.querySelector('.sheet.open')) { if (state.view === 'goals') loadGoals(); else if (state.view === 'home') render(); else if (state.view === 'stats') loadStats(); }
}
const hasQueue = () => qCount > 0;
const dbRange = async (from, to) => {
  try {
    const items = (await api(`/api/data?from=${from}&to=${to}`)).items;
    await offSafe(offCacheRange(from, to, items));
    const pend = (await offSafe(offAll()) || []).filter((x) => x.p && x.date >= from && x.date <= to);
    return pend.length ? items.filter((i) => !pend.some((x) => x.id === i.id)).concat(pend.map(strip)).sort(byOrder) : items;
  } catch (e) {
    if (!e.offline) throw e;
    return ((await offSafe(offAll())) || []).filter((x) => x.date >= from && x.date <= to).map(strip).sort(byOrder);
  }
};
const dbGetAdvice = async (date) => {
  try {
    const a = (await api(`/api/data?advice=${date}`)).advice;
    if (a) await offSafe(offTx(['adv'], 'readwrite', (st) => { st('adv').put({ ...a }); }));
    return a;
  } catch (e) {
    if (!e.offline) throw e;
    return (await offSafe(offTx(['adv'], 'readonly', (st, pr) => pr(st('adv').get(date))))) || null;
  }
};
const dbPutAdvice = (a) => api('/api/data', { action: 'advice', date: a.date, text: a.text, createdAt: a.createdAt });
// tulis: bila antrean masih ada atau jaringan putus, simpan lokal dulu lalu sinkron otomatis
async function dbWrite(op) {
  if (hasQueue()) return offApply(op, true);
  try { const [pth, bdy] = opReq(op); await api(pth, bdy); await offSafe(offApply(op, false)); }
  catch (e) { if (!e.offline) throw e; await offApply(op, true); }
}
const dbAdd = (items) => dbWrite({ op: 'add', items });
const dbUpdate = (item) => dbWrite({ op: 'update', id: item.id, amount: item.amount, desc: item.desc, method: item.method || '' });
const dbDelete = (id) => dbWrite({ op: 'delete', id });
const dbClear = async () => { await api('/api/data', { action: 'clear' }); await offSafe(offTx(['tx', 'adv', 'q'], 'readwrite', (st) => { ['tx', 'adv', 'q'].forEach((n) => st(n).clear()); })); qCount = 0; paintChip(); };
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
const state = { user: null, view: 'home', mode: 'week', offset: 0, pOffset: 0, selected: todayKey(), lastToday: todayKey(), seq: 0, dir: 0, pending: new Set() };
const MODE_ORDER = { year: 0, month: 1, week: 2 };
const reduceMotion = () => false;
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
          h('span', { class: 't' }, x.type === 'out' ? 'Pengeluaran' : 'Penghasilan', x.method && h('span', { class: 'mtag', text: x.method === 'tunai' ? 'Tunai' : 'Non Tunai' })),
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

/* ================= Dialog kustom (pengganti confirm/alert bawaan browser) ================= */
// ask({ icon, title, text, ok, cancel, danger }) -> Promise<boolean>; cancel:null = hanya satu tombol (info).
// Gerak: kartu muncul dari bawah dengan pegas, ikon tergambar, tombol bergaya tuts; kartu bisa digeser ke bawah untuk menutup.
const DLG_IC = {
  logout: '<path pathLength="1" d="M9 4H5v16h4"/><path pathLength="1" d="M16 8l4 4-4 4"/><path pathLength="1" d="M20 12H9"/>',
  import: '<path pathLength="1" d="M12 3v12"/><path pathLength="1" d="M7 10l5 5 5-5"/><path pathLength="1" d="M4 19h16"/>',
  trash: '<path pathLength="1" d="M4 7h16"/><path pathLength="1" d="M9 7V4h6v3"/><path pathLength="1" d="M6 7l1 13h10l1-13"/>',
  check: '<path pathLength="1" d="M20 12a8 8 0 1 1-4-6.9"/><path pathLength="1" d="M8.5 11.5l3 3L20 6"/>',
  warn: '<path pathLength="1" d="M12 3l10 18H2z"/><path pathLength="1" d="M12 10v5"/><path pathLength="1" d="M12 18v.5"/>',
};
let dlgClosed = Promise.resolve();
function ask(o) {
  return dlgClosed.then(() => new Promise((resolve) => {
    const d = $('dlg'), card = $('dlgCard'), yes = $('dlgYes'), no = $('dlgNo');
    $('dlgIc').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (DLG_IC[o.icon] || DLG_IC.warn) + '</svg>';
    $('dlgTitle').textContent = o.title || '';
    $('dlgText').textContent = o.text || '';
    yes.textContent = o.ok || 'Ya';
    no.textContent = o.cancel || 'Batal';
    no.hidden = o.cancel === null;
    d.classList.toggle('danger', !!o.danger);
    const lockAdded = !document.body.classList.contains('lock');
    const prevFocus = document.activeElement;
    let done = false, drag = null;
    const finish = (val, fromY) => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      card.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      resolve(val);
      dlgClosed = new Promise((r) => {
        const end = () => {
          card.getAnimations().forEach((an) => an.cancel());
          card.style.transform = '';
          d.classList.remove('open');
          d.setAttribute('aria-hidden', 'true');
          if (lockAdded && !document.querySelector('.sheet.open')) document.body.classList.remove('lock');
          if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
          r();
        };
        if (reduceMotion()) end();
        else card.animate([{ transform: `translateY(${fromY || 0}px)` }, { transform: 'translateY(120%)' }],
          { duration: 240, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' }).finished.then(end, end);
      });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(false); return; }
      if (e.key === 'Tab') { // fokus berputar di dalam dialog
        const bt = [no, yes].filter((b) => !b.hidden), i = bt.indexOf(document.activeElement);
        e.preventDefault();
        bt[(i + (e.shiftKey ? bt.length - 1 : 1)) % bt.length].focus();
      }
    };
    const onDown = (e) => { if (e.target.closest('button') || e.button > 0) return; drag = { y: e.clientY, dy: 0 }; card.getAnimations().forEach((an) => an.cancel()); };
    const onMove = (e) => { if (!drag) return; drag.dy = Math.max(0, e.clientY - drag.y); card.style.transform = `translateY(${drag.dy}px)`; };
    const onUp = () => {
      if (!drag) return;
      const dy = drag.dy; drag = null;
      if (dy > 90) { card.style.transform = ''; finish(false, dy); return; }
      card.style.transform = '';
      if (!reduceMotion()) card.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.3,1.6,.5,1)' });
    };
    window.addEventListener('keydown', onKey, true);
    card.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    yes.onclick = () => {
      if (!o.fx || reduceMotion()) { finish(true); return; }
      if (d.classList.contains('hit')) return;
      d.classList.add('hit');
      setTimeout(() => { d.classList.remove('hit'); finish(true); }, 240);
    };
    no.onclick = () => finish(false);
    $('dlgBg').onclick = () => finish(o.cancel === null ? true : false);
    document.body.classList.add('lock');
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
    if (!reduceMotion()) card.animate([
      { transform: 'translateY(115%) scale(.94)' },
      { transform: 'translateY(-8px) scale(1.01)', offset: .72 },
      { transform: 'none' },
    ], { duration: 480, easing: 'cubic-bezier(.2,.8,.2,1)' });
    (o.danger || o.cancel === null ? (o.cancel === null ? yes : no) : yes).focus({ preventScroll: true });
  }));
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
  if (id === 'sheetGoal') { gs.openId = null; if ($('geSave')._disarm) $('geSave')._disarm(); }
  if (id === 'sheetGoalNew' && $('gnSave')._disarm) $('gnSave')._disarm();
}
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]');
  if (c) { const sh = c.closest('.sheet'); if (sh) closeSheet(sh.id); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('dlg').classList.contains('open')) document.querySelectorAll('.sheet.open').forEach((sh) => closeSheet(sh.id));
});

/* ================= Form catatan ================= */
// Tiap jenis punya nominal dan deskripsi sendiri. Hanya satu yang terbuka (radio), tapi yang tertutup tetap tersimpan
// bila nominalnya diisi, dan ringkasannya tampil di barisnya supaya jelas apa yang akan disimpan.
const TYPES = {
  out: { box: 'typeOut', radio: 'rOut', body: 'bodyOut', amt: 'inOut', desc: 'descOut', sum: 'sumOut' },
  in: { box: 'typeIn', radio: 'rIn', body: 'bodyIn', amt: 'inIn', desc: 'descIn', sum: 'sumIn' },
};
let formType = null; // 'out' | 'in' | null (belum memilih)
const fm = { out: '', in: '' }; // metode pembayaran per jenis: 'tunai' | 'nontunai' | ''
const METH_ID = { out: 'methOut', in: 'methIn' };
function paintMeth() {
  Object.keys(METH_ID).forEach((k) => $(METH_ID[k]).querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === fm[k]))));
}

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
  fm.out = ''; fm.in = ''; paintMeth();
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
  fm[item.type] = item.method || ''; paintMeth();
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
      await dbUpdate({ ...editing, amount, desc, method: fm[editing.type] });
    } else {
      const out = read('out'), inc = read('in');
      if (out.amount <= 0 && inc.amount <= 0) {
        setFormError(formType ? 'Isi nominalnya terlebih dahulu.' : 'Pilih Pengeluaran atau Penghasilan, lalu isi nominalnya.');
        return;
      }
      const miss = out.amount > 0 && !fm.out ? 'out' : inc.amount > 0 && !fm.in ? 'in' : null;
      if (miss) {
        if (formType !== miss) setType(miss);
        setFormError(`Pilih Tunai atau Non Tunai untuk ${miss === 'out' ? 'pengeluaran' : 'penghasilan'}.`);
        nudge($(METH_ID[miss]));
        return;
      }
      const date = addDate || todayKey(), now = Date.now();
      const items = [];
      if (out.amount > 0) items.push({ id: uid(), date, type: 'out', amount: out.amount, desc: out.desc, createdAt: now, method: fm.out });
      if (inc.amount > 0) items.push({ id: uid(), date, type: 'in', amount: inc.amount, desc: inc.desc, createdAt: now + 1, method: fm.in });
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
  if (!(await ask({ icon: 'trash', danger: true, title: 'Hapus catatan?', ok: 'Hapus',
    text: `Catatan ${item.type === 'out' ? 'pengeluaran' : 'penghasilan'} ${rupiah(item.amount)} akan dihapus.` }))) return;
  try { await dbDelete(item.id, item.date); } catch (e) { await ask({ icon: 'warn', title: 'Gagal menghapus', text: 'Coba lagi sebentar lagi.', ok: 'Oke', cancel: null }); }
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
    if (!(await ask({ icon: 'import', title: `Impor ${txs.length} catatan?`, ok: 'Impor',
      text: `Catatan akan dimasukkan ke akun @${state.user.username} dan digabung dengan catatan yang sudah ada.` }))) return;
    await dbImport(txs, advices);
    msg.textContent = `Berhasil mengimpor ${txs.length} catatan ke akun ini.`;
    render();
  } catch (e) { msg.textContent = 'Gagal mengimpor: ' + e.message; }
}

/* ================= Target barang ================= */
// Halaman Target: daftar barang yang ditabung, dengan foto (opsional), nama dan harga (wajib). Tiap barang punya catatan tabungan
// (nabung / tarik). Saldo >= harga -> "udah cukup ni bro". Tutup tabungan (sudah beli) atau batal beli (hapus) memakai dua langkah;
// tombol simpan di form memakai konfirmasi tekan-dua-kali (tombol berubah dan menghitung mundur 4 detik).
const GOAL_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8h14l-1.2 11.2a1.5 1.5 0 0 1-1.5 1.3H7.7a1.5 1.5 0 0 1-1.5-1.3z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/></svg>';
const CHECK_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-4-6.9"/><path d="M8.5 11.5l3 3L20 6"/></svg>';
const EMPTY_IC = '<svg viewBox="0 0 84 84" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle pathLength="1" cx="40" cy="44" r="30"/><circle pathLength="1" cx="40" cy="44" r="18"/><circle pathLength="1" cx="40" cy="44" r="6"/><path pathLength="1" d="M42 42 74 10M62 10h12v12"/></svg>';
const RING_C = 2 * Math.PI * 48;
const gs = { list: [], loaded: false, seq: 0, openId: null, entries: [], dir: 'in', photo: null, busy: false };
const gPct = (g) => Math.min(100, Math.floor((g.saved / g.price) * 100));
const gReached = (g) => g.saved >= g.price;
const goalApi = (body) => api('/api/goals', body);
// Tulis ke server; bila antrean masih ada atau jaringan putus, simpan di antrean offline (dikirim otomatis nanti).
async function goalWrite(op) {
  if (hasQueue()) { await offEnqueue(op); return { queued: true }; }
  try { const [pth, bdy] = opReq(op); return await api(pth, bdy); }
  catch (e) { if (!e.offline) throw e; await offEnqueue(op); return { queued: true }; }
}
// cache lokal daftar target + riwayat tabungan per target (dipakai saat offline)
const goalPersist = () => offSafe(offMeta('goals', gs.list));
const entPersist = (id) => offSafe(offMeta('gent:' + id, gs.entries));
const curGoal = () => gs.list.find((x) => x.id === gs.openId) || null;
const withIcon = (cls, svg) => { const e = h('span', { class: cls }); e.innerHTML = svg; return e; }; // svg = konstanta di atas, bukan input pengguna
const fmtStamp = (ms) => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function goalThumb(g, cls) {
  const box = h('span', { class: cls });
  if (g.photo) box.append(h('img', { src: g.photo, alt: '', decoding: 'async' }));
  else box.innerHTML = GOAL_IC;
  return box;
}
function goalCard(g, i, animate) {
  const p = gPct(g), ok = gReached(g);
  const fill = h('div', { class: 'gfill' });
  const card = h('button', {
    type: 'button', class: 'gcard' + (ok ? ' ok' : '') + (animate ? '' : ' still'), style: `--d:${Math.min(i, 8) * 0.06}s`, 'data-id': g.id,
    'aria-label': `${g.name}, ${ok ? 'udah cukup' : p + ' persen'}. Buka detail`, onclick: () => openGoal(g.id),
  },
  goalThumb(g, 'gthumb'),
  h('div', { class: 'gbody' },
    h('div', { class: 'gname', text: g.name }),
    h('div', { class: 'gprice', text: rupiah(g.price) }),
    h('div', { class: 'gbar' }, fill),
    h('div', { class: 'gmeta' },
      h('span', null, h('b', { text: rupiah(g.saved) }), ' terkumpul'),
      ok ? h('span', { class: 'gok' }, withIcon('', CHECK_IC), 'udah cukup ni bro') : h('span', { text: p + '%' }))));
  requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = (ok ? 100 : p) + '%'; }));
  return card;
}
function renderGoals(animate = true, bornId = null) {
  const active = gs.list.filter((g) => g.status === 'active');
  const done = gs.list.filter((g) => g.status === 'done');
  const sum = active.reduce((a, g) => a + g.saved, 0), tot = active.reduce((a, g) => a + g.price, 0);
  const sub = $('gSub');
  sub.replaceChildren();
  if (!active.length) sub.textContent = 'Menabung untuk barang yang kamu incar.';
  else sub.append(`${active.length} target aktif · terkumpul `, h('b', { text: rupiah(sum) }), ` dari ${rupiah(tot)}`);
  const list = $('goalList');
  if (!active.length) {
    const empty = h('div', { class: 'gempty' }, withIcon('', EMPTY_IC), h('strong', { text: 'Belum ada target' }),
      h('span', { text: 'Tekan tombol + untuk menambah barang yang ingin kamu beli, lalu mulai menabung untuknya.' }));
    list.replaceChildren(empty);
  } else {
    list.replaceChildren(...active.map((g, i) => {
      const c = goalCard(g, i, animate);
      if (g.id === bornId) { c.classList.remove('still'); c.classList.add('born'); }
      return c;
    }));
  }
  $('goalDone').hidden = !done.length;
  $('goalDoneN').textContent = String(done.length);
  $('goalDoneList').replaceChildren(...done.map((g) => h('div', { class: 'gditem' },
    goalThumb(g, 'gthumb'),
    h('div', { class: 'gbody' }, h('div', { class: 'gname', text: g.name }),
      h('div', { class: 'gprice', text: `${rupiah(g.price)} · dibeli ${g.closedAt ? fmtStamp(g.closedAt).split(' · ')[0] : ''}` })),
    withIcon('', CHECK_IC))));
}
async function loadGoals() {
  const seq = ++gs.seq;
  if (!gs.loaded) $('goalList').replaceChildren(h('div', { class: 'gskel' }), h('div', { class: 'gskel' }));
  if (hasQueue()) await flushQueue(); // kirim perubahan offline dulu supaya daftar dari server sudah mutakhir
  try {
    if (hasQueue()) throw Object.assign(new Error('antrean'), { offline: true }); // masih ada yang belum terkirim: pakai cache lokal
    const d = await api('/api/goals');
    if (seq !== gs.seq || !state.user) return;
    gs.list = d.goals; gs.loaded = true; goalPersist();
    renderGoals(true);
  } catch (e) {
    if (seq !== gs.seq || !state.user) return;
    if (e.offline) {
      const c = await offSafe(offMeta('goals'));
      if (seq !== gs.seq || !state.user) return;
      if (c) { gs.list = c; gs.loaded = true; renderGoals(true); return; }
      $('goalList').replaceChildren(h('p', { class: 'empty', text: 'Belum ada data target di perangkat ini. Buka halaman Target sekali saat online agar bisa dipakai offline.' }));
      return;
    }
    if (!gs.loaded) $('goalList').replaceChildren(h('p', { class: 'empty', text: 'Gagal memuat target: ' + e.message }));
  }
}

/* ---- tombol konfirmasi tekan-dua-kali ---- */
// Tekan pertama: tombol berubah (hijau/merah) menyebut aksinya dan menghitung mundur 4 detik. Tekan kedua: dijalankan.
function bindArm(btn, prepare, commit, after) {
  let timer = 0, armed = false;
  const reset = () => { armed = false; btn.classList.remove('armed', 'out', 'commit', 'done'); btn.textContent = btn.dataset.label; };
  const disarm = () => { clearTimeout(timer); timer = 0; if (armed) reset(); };
  btn._disarm = disarm;
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    if (!armed) {
      const r = prepare();
      if (!r) return;
      armed = true; btn.textContent = r.label;
      btn.classList.remove('armed'); void btn.offsetWidth; btn.classList.add('armed');
      btn.classList.toggle('out', r.cls === 'out');
      timer = setTimeout(disarm, 4000);
      return;
    }
    // tekan kedua: tombol "tertekan", disapu cahaya, lalu berubah jadi centang sebelum kembali normal
    clearTimeout(timer); timer = 0; armed = false;
    btn.disabled = true;
    btn.classList.remove('armed'); void btn.offsetWidth; btn.classList.add('commit');
    btn.textContent = 'Memproses…';
    let res;
    try { res = await commit(); } catch (er) { res = false; }
    btn.classList.remove('commit');
    if (res !== false) {
      btn.classList.add('done'); btn.textContent = '✓ Berhasil';
      await new Promise((ok) => setTimeout(ok, reduceMotion() ? 0 : 520));
    }
    if (res !== false && after) after(res);
    reset(); btn.disabled = false;
  });
}
function bindMoneyFree(inp, cb) {
  inp.addEventListener('input', () => {
    const d = inp.value.replace(/\D/g, '').slice(0, 12).replace(/^0+(?=\d)/, '');
    inp.value = d === '' ? '' : fmtNum(Number(d));
    if (cb) cb();
  });
}
function nudge(el) { if (el && el.animate && !reduceMotion()) el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-3px)' }, { transform: 'none' }], { duration: 320 }); }

/* ---- target baru ---- */
async function compressImage(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('File harus berupa gambar.');
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {
    bmp = await new Promise((res, rej) => {
      const img = new Image(), u = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(u); res(img); };
      img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('Gambar tidak bisa dibaca.')); };
      img.src = u;
    });
  }
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  if (!w0 || !h0) throw new Error('Gambar tidak bisa dibaca.');
  for (const max of [640, 520, 420, 320]) {
    const k = Math.min(1, max / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    for (const q of [0.82, 0.72, 0.62, 0.52]) {
      const url = c.toDataURL('image/jpeg', q);
      if (url.length <= 70000) return url;
    }
  }
  throw new Error('Foto terlalu besar. Coba foto lain.');
}
function paintNewPhoto() {
  $('gnPick').hidden = !!gs.photo;
  $('gnPrev').hidden = !gs.photo;
  if (gs.photo) $('gnImg').src = gs.photo; else $('gnImg').removeAttribute('src');
}
function openGoalNew() {
  gs.photo = null;
  $('gnName').value = ''; $('gnPrice').value = ''; $('gnErr').textContent = '';
  if ($('gnSave')._disarm) $('gnSave')._disarm();
  paintNewPhoto();
  openSheet('sheetGoalNew');
}
async function pickPhoto(file) {
  $('gnErr').textContent = '';
  try { gs.photo = await compressImage(file); paintNewPhoto(); } catch (e) { $('gnErr').textContent = e.message; }
}
function prepareNewGoal() {
  const name = $('gnName').value.trim().replace(/\s+/g, ' '), price = parseAmount($('gnPrice').value);
  if (!name) { $('gnErr').textContent = 'Nama barang wajib diisi.'; nudge($('gnName')); $('gnName').focus(); return null; }
  if (price <= 0) { $('gnErr').textContent = 'Harga barang wajib diisi.'; nudge($('gnPrice').parentNode); $('gnPrice').focus(); return null; }
  $('gnErr').textContent = '';
  return { label: 'Tekan lagi untuk membuat target' };
}
async function commitNewGoal() {
  const name = $('gnName').value.trim().replace(/\s+/g, ' '), price = parseAmount($('gnPrice').value);
  const goal = { id: rid(), name, price, photo: gs.photo || null, status: 'active', createdAt: Date.now(), closedAt: null, saved: 0 };
  try {
    const d = await goalWrite({ op: 'g-create', goal });
    const g = d && d.goal ? d.goal : goal;
    const at = gs.list.findIndex((x) => x.status === 'done');
    gs.list.splice(at < 0 ? gs.list.length : at, 0, g);
    gs.loaded = true; goalPersist();
    return g.id;
  } catch (e) { $('gnErr').textContent = e.message; return false; }
}
function afterNewGoal(id) { closeSheet('sheetGoalNew'); renderGoals(false, id); }

/* ---- detail target ---- */
function burst(host) {
  const box = h('div', { class: 'gconf' });
  host.append(box);
  const cols = ['#35d07f', '#ff9a4d', '#ffd166', '#7bd8ff', '#ff6b8b'];
  for (let i = 0; i < 18; i++) {
    const p = h('i', { style: `background:${cols[i % cols.length]}` });
    box.append(p);
    const a = (Math.PI * 2 * i) / 18 + Math.random() * 0.4, d = 56 + Math.random() * 56;
    p.animate([{ transform: 'translate(-50%,-50%) scale(1)' },
      { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d + 18}px)) rotate(${Math.random() * 540}deg) scale(.25)` }],
    { duration: 900 + Math.random() * 450, easing: 'cubic-bezier(.1,.7,.3,1)', fill: 'forwards' });
  }
  setTimeout(() => box.remove(), 1600);
}
function paintGoal(g, fromPct) {
  const ok = gReached(g), p = gPct(g);
  $('gdName').textContent = g.name;
  const hero = $('gdHero');
  hero.classList.toggle('has', !!g.photo);
  hero.replaceChildren();
  if (g.photo) hero.append(h('img', { src: g.photo, alt: 'Foto ' + g.name })); else hero.innerHTML = GOAL_IC;
  $('gdSaved').textContent = rupiah(g.saved);
  $('gdPrice').textContent = 'dari ' + rupiah(g.price);
  $('gdPct').textContent = p + '%';
  $('gdRing').classList.toggle('ok', ok);
  const fg = $('gdFg');
  fg.style.strokeDasharray = String(RING_C);
  if (fromPct != null) { fg.style.transition = 'none'; fg.style.strokeDashoffset = String(RING_C * (1 - fromPct / 100)); void fg.getBoundingClientRect(); fg.style.transition = ''; }
  fg.style.strokeDashoffset = String(RING_C * (1 - (ok ? 100 : p) / 100));
  const msg = $('gdMsg');
  const nextText = ok ? 'udah cukup ni bro' : 'Kurang ' + rupiah(g.price - g.saved) + ' lagi';
  if (msg.textContent !== nextText) {
    msg.textContent = nextText;
    msg.className = 'gd-msg ' + (ok ? 'ok' : 'need');
  }
  $('gdBuy').classList.toggle('hot', ok);
  updatePreview();
}
function renderEntries(animate) {
  const ul = $('geList');
  if (!gs.entries.length) { ul.replaceChildren(h('li', { class: 'ge-empty', text: 'Belum ada catatan tabungan.' })); return; }
  ul.replaceChildren(...gs.entries.map((e, i) => h('li', { class: 'ge-item', style: animate ? `--d:${Math.min(i, 6) * 0.05}s` : 'animation:none' },
    h('div', null, h('span', { text: e.amount > 0 ? 'Nabung' : 'Tarik' }), h('small', { text: fmtStamp(e.createdAt) })),
    h('b', { class: e.amount > 0 ? 'in' : 'out', text: (e.amount > 0 ? '+' : '−') + rupiah(Math.abs(e.amount)) }))));
}
async function loadEntries(id) {
  const fromCache = async () => { gs.entries = (await offSafe(offMeta('gent:' + id))) || []; if (gs.openId === id) renderEntries(true); };
  try {
    if (hasQueue()) { await fromCache(); return; }
    const d = await api('/api/goals?entries=' + encodeURIComponent(id));
    if (gs.openId !== id) return;
    gs.entries = d.entries; renderEntries(true); entPersist(id);
  } catch (e) {
    if (gs.openId !== id) return;
    if (e.offline) await fromCache();
    else $('geList').replaceChildren(h('li', { class: 'ge-empty', text: 'Gagal memuat riwayat.' }));
  }
}
function setDir(dir) {
  gs.dir = dir;
  $('geTog').classList.toggle('out', dir === 'out');
  $('geTog').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.dir === dir)));
}
function updatePreview() {
  const g = curGoal(), a = parseAmount($('geAmt').value), el = $('gePrev');
  el.className = 'gprev';
  if (!g || a <= 0) { el.textContent = ''; return; }
  if (gs.dir === 'out' && a > g.saved) { el.textContent = 'Melebihi tabungan (' + rupiah(g.saved) + ').'; el.classList.add('bad'); return; }
  el.textContent = 'Tabungan jadi ' + rupiah(g.saved + (gs.dir === 'in' ? a : -a));
}
function openGoal(id) {
  const g = gs.list.find((x) => x.id === id);
  if (!g) return;
  gs.openId = id; gs.entries = [];
  setDir('in');
  $('geAmt').value = ''; $('geErr').textContent = ''; $('gePrev').textContent = '';
  if ($('geSave')._disarm) $('geSave')._disarm();
  paintGoal(g, 0);
  $('geList').replaceChildren(h('li', { class: 'ge-empty', text: 'Memuat…' }));
  openSheet('sheetGoal');
  loadEntries(id);
}
function prepareEntry() {
  const g = curGoal(), a = parseAmount($('geAmt').value);
  if (!g) return null;
  if (a <= 0) { $('geErr').textContent = 'Masukkan nominal dulu.'; nudge($('geAmt').parentNode); $('geAmt').focus(); return null; }
  if (gs.dir === 'out' && a > g.saved) { $('geErr').textContent = 'Nominal melebihi tabungan yang ada.'; nudge($('geAmt').parentNode); return null; }
  if (gs.dir === 'in' && g.saved + a > MAX_AMOUNT) { $('geErr').textContent = 'Total tabungan terlalu besar.'; return null; }
  $('geErr').textContent = '';
  return { label: `Tekan lagi: ${gs.dir === 'in' ? 'nabung' : 'tarik'} ${rupiah(a)}`, cls: gs.dir };
}
async function commitEntry() {
  const g = curGoal(), a = parseAmount($('geAmt').value), dir = gs.dir;
  if (!g || a <= 0) return false;
  const was = gReached(g), from = gPct(g);
  const signed = dir === 'in' ? a : -a, entryId = rid(), at = Date.now();
  try {
    const d = await goalWrite({ op: 'g-entry', goalId: g.id, entryId, dir, amount: a, createdAt: at });
    g.saved = d && d.saved != null ? d.saved : g.saved + signed;
    gs.entries.unshift(d && d.entry ? d.entry : { id: entryId, amount: signed, createdAt: at });
    goalPersist(); entPersist(g.id);
    $('geAmt').value = ''; $('gePrev').textContent = ''; $('geErr').textContent = '';
    paintGoal(g, from);
    renderEntries(false);
    renderGoals(false);
    if (!was && gReached(g)) burst($('gdRing'));
    return true;
  } catch (e) { $('geErr').textContent = e.message; return false; }
}
// kartu bergeser keluar lalu ruangnya menciut (dipakai saat target dibeli / dibatalkan)
function leaveCard(id, dir) {
  const el = document.querySelector(`.gcard[data-id="${id}"]`);
  if (!el || reduceMotion() || !el.animate) return Promise.resolve();
  const hgt = el.offsetHeight;
  el.style.overflow = 'hidden'; el.style.pointerEvents = 'none';
  return el.animate([{ transform: 'none' }, { transform: `translateX(${dir * 112}%) scale(.96)` }], { duration: 420, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' }).finished
    .then(() => el.animate([{ height: hgt + 'px', marginBottom: '0px' }, { height: '0px', marginBottom: '-12px', paddingTop: '0px', paddingBottom: '0px', borderWidth: '0px' }], { duration: 300, easing: 'cubic-bezier(.3,.8,.3,1)', fill: 'forwards' }).finished)
    .catch(() => {});
}
const wait = (ms) => new Promise((ok) => setTimeout(ok, reduceMotion() ? 0 : ms));
async function buyGoal() {
  const g = curGoal();
  if (!g) return;
  if (!(await ask({ fx: true, icon: 'check', title: 'Sudah beli barangnya?', ok: 'Ya, sudah beli', text: `${g.name} akan ditandai sudah dibeli dan tabungannya ditutup.` }))) return;
  if (!(await ask({ fx: true, icon: 'check', title: 'Tutup tabungan ini?', ok: 'Tutup tabungan', text: 'Setelah ditutup, kamu tidak bisa lagi menambah atau menarik tabungan untuk barang ini.' }))) return;
  try { await goalWrite({ op: 'g-close', goalId: g.id }); } catch (e) {
    await ask({ icon: 'warn', title: 'Gagal menutup tabungan', text: e.message, ok: 'Oke', cancel: null });
    return;
  }
  closeSheet('sheetGoal');
  await wait(320);
  await leaveCard(g.id, 1);
  g.status = 'done'; g.closedAt = Date.now();
  gs.list.sort((a, b) => (a.status === b.status ? (a.status === 'done' ? b.closedAt - a.closedAt : a.createdAt - b.createdAt) : a.status === 'active' ? -1 : 1));
  goalPersist();
  renderGoals(false);
}
async function cancelGoal() {
  const g = curGoal();
  if (!g) return;
  if (!(await ask({ fx: true, icon: 'trash', danger: true, title: 'Batal beli barang ini?', ok: 'Ya, batal beli', text: `Detail ${g.name}, fotonya, dan semua catatan tabungannya akan dihapus.` }))) return;
  if (!(await ask({ fx: true, icon: 'trash', danger: true, title: 'Peringatan terakhir', ok: 'Hapus target', text: 'Target dan seluruh catatan tabungannya dihapus permanen dan tidak bisa dikembalikan. Lanjutkan?' }))) return;
  try { await goalWrite({ op: 'g-remove', goalId: g.id }); } catch (e) {
    await ask({ icon: 'warn', title: 'Gagal menghapus target', text: e.message, ok: 'Oke', cancel: null });
    return;
  }
  closeSheet('sheetGoal');
  await wait(320);
  await leaveCard(g.id, -1);
  gs.list = gs.list.filter((x) => x.id !== g.id);
  goalPersist(); offSafe(offMeta('gent:' + g.id, null));
  renderGoals(false);
}

/* ---- pindah halaman: Beranda / Target / Analitik / Chat AI ---- */
const VIEW_ID = { home: 'app', goals: 'goals', stats: 'stats', chat: 'chat' };
const VIEW_ORD = ['home', 'goals', 'stats', 'chat'];
let viewBusy = false;
function syncNav() {
  const v = state.view, more = v === 'stats' || v === 'chat';
  $('navHome').classList.toggle('on', v === 'home'); $('navGoals').classList.toggle('on', v === 'goals'); $('btnMore').classList.toggle('on', more);
  [['navHome', 'home'], ['navGoals', 'goals']].forEach(([id, k]) => { if (v === k) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current'); });
  $('btnAdd').setAttribute('aria-label', v === 'goals' ? 'Tambah target barang' : 'Tambah catatan');
  $('btnAdd').classList.toggle('away', more);
  $('btnAdd').tabIndex = more ? -1 : 0;
}
function setTray(open) {
  const t = $('tray'), bg = $('trayBg');
  $('btnMore').setAttribute('aria-expanded', String(open));
  if (open) { t.hidden = false; bg.hidden = false; void t.offsetWidth; t.classList.add('open'); bg.classList.add('open'); return; }
  t.classList.remove('open'); bg.classList.remove('open');
  setTimeout(() => { if (!t.classList.contains('open')) { t.hidden = true; bg.hidden = true; } }, reduceMotion() ? 0 : 320);
}
function showView(v) {
  setTray(false);
  if (state.view === v || viewBusy) return;
  const from = $(VIEW_ID[state.view]), to = $(VIEW_ID[v]);
  const dir = VIEW_ORD.indexOf(v) > VIEW_ORD.indexOf(state.view) ? 1 : -1;
  state.view = v; syncNav();
  if (v === 'goals') loadGoals();
  else if (v === 'stats') openStats();
  else if (v === 'chat') openChat();
  window.scrollTo(0, 0);
  to.hidden = false;
  if (reduceMotion()) { from.hidden = true; return; }
  viewBusy = true;
  from.classList.add('vt'); to.classList.add('vt');
  const end = () => {
    from.hidden = true;
    [from, to].forEach((el) => { el.classList.remove('vt'); el.getAnimations().forEach((an) => an.cancel()); });
    viewBusy = false;
  };
  Promise.all([
    from.animate([{ transform: 'none' }, { transform: `translateX(${-dir * 100}%)` }], { duration: 460, easing: 'cubic-bezier(.3,.9,.25,1)', fill: 'forwards' }).finished,
    to.animate([{ transform: `translateX(${dir * 100}%)` }, { transform: 'none' }], { duration: 460, easing: 'cubic-bezier(.3,.9,.25,1)' }).finished,
  ]).then(end, end);
}
function resetGoalsUI() {
  state.view = 'home'; viewBusy = false;
  const all = Object.values(VIEW_ID).map((id) => $(id));
  all.forEach((el) => { el.classList.remove('vt'); el.getAnimations().forEach((an) => an.cancel()); el.hidden = el.id !== 'app'; });
  gs.list = []; gs.loaded = false; gs.openId = null; gs.entries = []; gs.photo = null; gs.seq++;
  $('goalList').replaceChildren(); $('goalDoneList').replaceChildren(); $('goalDone').hidden = true;
  $('goalDoneBtn').setAttribute('aria-expanded', 'false');
  stt.y = 0; stt.seq++; $('stBody').replaceChildren();
  ch.msgs = []; ch.busy = false; ch.seq++; $('chLog').replaceChildren(); $('chIn').value = '';
  setTray(false);
  syncNav();
}

/* ================= Analitik (per bulan, dihitung dari catatan di perangkat) ================= */
const stt = { y: 0, m: 0, seq: 0 };
const ymOf = (d) => ({ y: d.getFullYear(), m: d.getMonth() });
const monthKeys = (y, m) => ({ from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}` });
function shiftMonth(y, m, d) { const x = new Date(y, m + d, 1); return { y: x.getFullYear(), m: x.getMonth() }; }
function openStats() {
  if (!stt.y) { const n = ymOf(new Date()); stt.y = n.y; stt.m = n.m; }
  loadStats();
}
function aggMonth(items) {
  const a = { in: 0, out: 0, n: items.length, cash: 0, bank: 0, none: 0, byDay: new Map(), byDesc: new Map(), weeks: [0, 0, 0, 0, 0], maxIn: null };
  for (const x of items) {
    if (x.type === 'in') { a.in += x.amount; if (!a.maxIn || x.amount > a.maxIn.amount) a.maxIn = x; continue; }
    a.out += x.amount;
    if (x.method === 'tunai') a.cash += x.amount; else if (x.method === 'nontunai') a.bank += x.amount; else a.none += x.amount;
    a.byDay.set(x.date, (a.byDay.get(x.date) || 0) + x.amount);
    const k = (x.desc || '').trim().toLowerCase() || '(tanpa deskripsi)';
    const e = a.byDesc.get(k) || { name: (x.desc || '').trim() || '(tanpa deskripsi)', sum: 0, n: 0 };
    e.sum += x.amount; e.n++; a.byDesc.set(k, e);
    a.weeks[Math.min(4, Math.floor((Number(x.date.slice(8)) - 1) / 7))] += x.amount;
  }
  a.net = a.in - a.out;
  return a;
}
const pctTxt = (cur, prev) => (prev === 0 ? (cur === 0 ? '—' : 'baru') : (cur >= prev ? '+' : '−') + Math.round((Math.abs(cur - prev) / prev) * 100) + '%');
const stRow = (k, v) => h('div', { class: 'strow' }, h('span', { text: k }), h('b', null, v));
function stBar(label, val, max, cls) {
  const f = h('div', { class: 'stbar-f ' + cls });
  requestAnimationFrame(() => requestAnimationFrame(() => { f.style.transform = `scaleX(${max > 0 ? Math.max(val / max, val > 0 ? 0.02 : 0) : 0})`; }));
  return h('div', { class: 'stbar' }, h('div', { class: 'stbar-h' }, h('span', { text: label }), h('b', { text: rupiah(val) })), h('div', { class: 'stbar-t' }, f));
}
async function loadStats() {
  const seq = ++stt.seq, { y, m } = stt;
  const now = ymOf(new Date());
  $('stLabel').textContent = `${MONTHS_LONG[m]} ${y}`;
  $('stNext').disabled = y > now.y || (y === now.y && m >= now.m);
  const p = shiftMonth(y, m, -1), k = monthKeys(y, m), kp = monthKeys(p.y, p.m);
  try {
    const [cur, prev] = await Promise.all([dbRange(k.from, k.to), dbRange(kp.from, kp.to)]);
    if (seq !== stt.seq || !state.user) return;
    drawStats(aggMonth(cur), aggMonth(prev), y, m, p);
  } catch (e) {
    if (seq !== stt.seq || !state.user) return;
    $('stBody').replaceChildren(h('div', { class: 'card stc stempty', text: 'Gagal memuat: ' + e.message }));
  }
}
function drawStats(c, pv, y, m, p) {
  const body = $('stBody');
  const isNow = (() => { const n = new Date(); return n.getFullYear() === y && n.getMonth() === m; })();
  const days = isNow ? new Date().getDate() : new Date(y, m + 1, 0).getDate();
  const pName = MONTHS_LONG[p.m];
  if (!c.n) {
    body.replaceChildren(h('div', { class: 'card stc stempty', text: `Belum ada catatan di ${MONTHS_LONG[m]} ${y}.` + (pv.n ? '' : ' Catatan yang pernah dimuat saat online akan tampil di sini, termasuk saat offline.') }));
    return;
  }
  // --- Ringkasan kondisi keuangan
  let tone, badge, lead;
  if (c.in === 0) { tone = 'down'; badge = 'Belum ada penghasilan tercatat'; lead = `Pengeluaran bulan ini ${rupiah(c.out)} tanpa penghasilan yang dicatat.`; }
  else if (c.net > 0) { tone = 'up'; badge = 'Surplus'; lead = `Penghasilan lebih besar dari pengeluaran. Kamu menyisakan ${rupiah(c.net)}.`; }
  else if (c.net < 0) { tone = 'down'; badge = 'Defisit'; lead = `Pengeluaran melebihi penghasilan sebesar ${rupiah(-c.net)}.`; }
  else { tone = 'flat'; badge = 'Impas'; lead = 'Penghasilan dan pengeluaran sama besar.'; }
  const sum = h('section', { class: 'card stc', style: '--d:0s' }, h('h2', { text: 'Ringkasan kondisi keuangan' }),
    h('span', { class: 'stbadge ' + tone, text: badge }), h('div', { class: 'stbig ' + (c.net < 0 ? 'c-out' : c.net > 0 ? 'c-inc' : ''), text: (c.net < 0 ? '− ' : c.net > 0 ? '+ ' : '') + rupiah(Math.abs(c.net)) }),
    h('p', { class: 'stp', text: lead }));
  if (c.in > 0) {
    const rate = Math.round((c.net / c.in) * 100);
    sum.append(h('p', { class: 'stp' }, 'Pengeluaran memakai ', h('b', { text: Math.round((c.out / c.in) * 100) + '%' }), ' dari penghasilan. ',
      rate >= 20 ? `Rasio sisa ${rate}% tergolong sehat.` : rate >= 0 ? `Rasio sisa ${rate}% masih tipis.` : 'Rasio sisa negatif, perlu perhatian.'));
  }
  if (pv.out > 0) sum.append(h('p', { class: 'stp' }, 'Dibanding ', pName, ', pengeluaran ', h('b', { text: c.out >= pv.out ? `naik ${Math.round(((c.out - pv.out) / pv.out) * 100)}%` : `turun ${Math.round(((pv.out - c.out) / pv.out) * 100)}%` }), '.'));
  // --- Perbandingan pemasukan dan pengeluaran
  const mx = Math.max(c.in, c.out, pv.in, pv.out, 1);
  const delta = (lab, cur, prev, goodUp) => h('div', { class: 'strow' }, h('span', { text: lab }),
    h('b', null, h('span', { class: 'stdelta ' + (cur === prev ? '' : (cur > prev) === goodUp ? 'up' : 'down'), text: pctTxt(cur, prev) }), ` dari ${rupiah(prev)}`));
  const cmp = h('section', { class: 'card stc', style: '--d:.06s' }, h('h2', { text: 'Perbandingan pemasukan dan pengeluaran' }),
    h('div', { class: 'stsub', text: `${MONTHS_LONG[m].toUpperCase()}` }),
    stBar('Pemasukan', c.in, mx, 'in'), stBar('Pengeluaran', c.out, mx, 'out'),
    h('div', { class: 'stsub', text: pName.toUpperCase() }),
    stBar('Pemasukan', pv.in, mx, 'mute'), stBar('Pengeluaran', pv.out, mx, 'mute'),
    h('div', { class: 'stsub', text: `PERUBAHAN DIBANDING ${pName.toUpperCase()}` }),
    delta('Pemasukan', c.in, pv.in, true), delta('Pengeluaran', c.out, pv.out, false));
  // --- Laporan bulanan lengkap
  const topDay = [...c.byDay.entries()].sort((a, b) => b[1] - a[1])[0];
  const top = [...c.byDesc.values()].sort((a, b) => b.sum - a.sum).slice(0, 5);
  const rep = h('section', { class: 'card stc', style: '--d:.12s' }, h('h2', { text: 'Laporan bulanan lengkap' }),
    stRow('Total pemasukan', h('span', { class: 'c-inc', text: rupiah(c.in) })), stRow('Total pengeluaran', h('span', { class: 'c-out', text: rupiah(c.out) })),
    stRow('Selisih', (c.net < 0 ? '− ' : c.net > 0 ? '+ ' : '') + rupiah(Math.abs(c.net))), stRow('Jumlah catatan', String(c.n)),
    stRow(isNow ? `Rata-rata pengeluaran per hari (${days} hari)` : 'Rata-rata pengeluaran per hari', rupiah(Math.round(c.out / days))));
  if (topDay) rep.append(stRow('Hari paling boros', `${fmtLong(topDay[0])} · ${rupiah(topDay[1])}`));
  if (c.maxIn) rep.append(stRow('Pemasukan terbesar', `${rupiah(c.maxIn.amount)}${c.maxIn.desc ? ' · ' + c.maxIn.desc : ''}`));
  if (c.out > 0) {
    rep.append(h('div', { class: 'stsub', text: 'PENGELUARAN TUNAI VS NON TUNAI' }), stBar('Tunai', c.cash, c.out, 'cash'), stBar('Non tunai', c.bank, c.out, 'out'));
    if (c.none > 0) rep.append(stBar('Metode belum dicatat', c.none, c.out, 'mute'));
    rep.append(h('div', { class: 'stsub', text: 'PENGELUARAN PER MINGGU' }));
    const wk = ['Tgl 1–7', 'Tgl 8–14', 'Tgl 15–21', 'Tgl 22–28', 'Tgl 29–akhir'];
    const wmax = Math.max(...c.weeks, 1);
    c.weeks.forEach((v, i) => { if (i < 4 || v > 0) rep.append(stBar(wk[i], v, wmax, 'out')); });
    rep.append(h('div', { class: 'stsub', text: '5 PENGELUARAN TERBESAR' }));
    top.forEach((e) => rep.append(stRow(e.n > 1 ? `${e.name} (${e.n}×)` : e.name, rupiah(e.sum))));
  }
  body.replaceChildren(sum, cmp, rep);
}

/* ================= Chat AI ================= */
const CH_SUG = ['Kebiasaan pengeluaran selama satu bulan', 'Perbandingan pengeluaran bulan ini dan sebelumnya', 'Hal yang paling banyak menghabiskan uang', 'Tren pemasukan dan pengeluaran', 'Perkembangan kebiasaan menabung'];
const ch = { msgs: [], busy: false, seq: 0 };
function chScroll() { requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reduceMotion() ? 'auto' : 'smooth' })); }
function chBubble(m) {
  if (m.role === 'user') return h('div', { class: 'chb me', text: m.text });
  const b = h('div', { class: 'chb ai' + (m.role === 'error' ? ' bad' : '') });
  if (m.role === 'error') b.textContent = m.text; else renderAdvice(b, m.text);
  return b;
}
function chRenderAll() {
  const log = $('chLog');
  if (!ch.msgs.length) {
    log.replaceChildren(h('div', { class: 'chempty' }, h('strong', { text: 'Tanya apa saja soal uangmu' }), 'AI bisa melihat catatan dan tabunganmu, tapi hanya menyebutnya kalau kamu tanya. Pilih contoh di bawah atau ketik sendiri.'));
    return;
  }
  log.replaceChildren(...ch.msgs.map(chBubble));
}
function chBusy(on) {
  ch.busy = on; $('chSend').disabled = on;
  $('chSug').querySelectorAll('button').forEach((b) => { b.disabled = on; });
}
function openChat() {
  if (!$('chSug').children.length) $('chSug').replaceChildren(...CH_SUG.map((q, i) => h('button', { type: 'button', style: `--d:${i * 0.05}s`, text: q, onclick: () => chSend(q) })));
  chRenderAll();
}
async function chSend(text) {
  text = String(text || '').trim();
  if (!text || ch.busy) return;
  const seq = ch.seq;
  const first = !ch.msgs.length;
  ch.msgs.push({ role: 'user', text });
  if (first) $('chLog').replaceChildren(chBubble(ch.msgs[0])); else $('chLog').append(chBubble(ch.msgs[ch.msgs.length - 1]));
  $('chIn').value = ''; $('chIn').style.height = '';
  const typing = h('div', { class: 'chb ai typing', 'aria-label': 'AI sedang mengetik' }, h('i'), h('i'), h('i'));
  $('chLog').append(typing); chBusy(true); chScroll();
  const hist = ch.msgs.filter((x) => x.role !== 'error').slice(-12).map((x) => ({ role: x.role, text: x.text }));
  let msg;
  try { msg = { role: 'assistant', text: (await api('/api/chat', { messages: hist })).reply }; }
  catch (e) { msg = { role: 'error', text: e.offline ? 'Chat AI butuh koneksi internet. Coba lagi saat online.' : e.message }; }
  if (seq !== ch.seq || !state.user) return;
  typing.remove(); ch.msgs.push(msg); $('chLog').append(chBubble(msg)); chBusy(false); chScroll();
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
  resetGoalsUI();
  $('detail').replaceChildren();
  admSeq++; clearTimeout(admTimer);
  $('admList').replaceChildren(); $('admQ').value = '';
  ['acMail', 'acUser', 'acCur', 'acNew'].forEach((id) => { $(id).value = ''; });
  paintChip();
}
// masuk ke aplikasi: layar loading tetap tampil sampai data pertama selesai dimuat
async function startApp(user) {
  resetAppState();
  // data offline milik satu akun: bila yang masuk akun lain, buang cache + antrean akun sebelumnya
  const prev = await offSafe(offMeta('user'));
  if (prev && user.id && prev.id !== user.id) await offClear();
  await offSafe(offMeta('user', { id: user.id, username: user.username, email: user.email, isAdmin: !!user.isAdmin }));
  await offCount();
  state.user = user;
  paintChip();
  applyRole();
  try { await render(); } catch (e) {
    $('detail').replaceChildren(h('p', { class: 'empty', text: 'Gagal memuat data: ' + e.message }));
  }
  document.body.classList.remove('gated');
  movePill(false);
  gateToken++;
  heroStop();
  gateDrops = true;
  flushQueue();
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
  let user = null, down = false, noNet = false;
  try {
    const r = await fetch('/api/auth', { cache: 'no-store' });
    if (r.ok) { user = (await r.json()).user; setNet(true); }
    else if (r.status !== 401) down = true;
  } catch (e) { down = true; noNet = true; setNet(false); }
  if (user) return startApp(user);
  // tanpa internet: buka dengan identitas yang tersimpan dari login sebelumnya (sesi di server tetap berlaku)
  if (noNet) {
    const cu = await offSafe(offMeta('user'));
    if (cu && cu.id) return startApp(cu);
  }
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
  if (!(await ask({ icon: 'logout', title: 'Keluar dari akun?', ok: 'Keluar',
    text: `@${state.user.username} akan keluar dari perangkat ini. Catatanmu tetap tersimpan dan bisa dibuka lagi dengan login.` +
      (qCount ? ` Ada ${qCount} perubahan offline yang belum tersinkron dan akan hilang bila kamu keluar sekarang.` : '') }))) return;
  try { await api('/api/auth', { action: 'logout' }); }
  catch (e) {
    if (e.offline) { await ask({ icon: 'warn', title: 'Perlu internet', text: 'Keluar akun butuh koneksi internet. Sambungkan dulu lalu coba lagi.', ok: 'Oke', cancel: null }); return; }
    /* galat lain: tetap keluar di sisi aplikasi */
  }
  await offClear();
  resetAppState();
  showGate('login');
}
// Hapus akun: dua konfirmasi, lalu lembar khusus yang meminta username dan password.
async function startDeleteAccount() {
  if (!(await ask({ icon: 'warn', danger: true, title: 'Hapus akun?', ok: 'Lanjutkan',
    text: 'Akun beserta SEMUA catatan dan saran AI di dalamnya akan dihapus permanen dan tidak bisa dikembalikan.' }))) return;
  if (!(await ask({ icon: 'warn', danger: true, title: 'Peringatan terakhir', ok: 'Ya, lanjut',
    text: 'Setelah dihapus, akun ini tidak bisa dipakai masuk lagi. Sudah ekspor backup bila perlu?' }))) return;
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
    await offClear();
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
  if (state.user.id) offSafe(offMeta('user', { id: state.user.id, username: state.user.username, email: state.user.email, isAdmin: state.user.isAdmin }));
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
  $('btnAdd').addEventListener('click', () => { if (state.view === 'goals') openGoalNew(); else openAdd(); });
  $('navHome').addEventListener('click', () => showView('home'));
  $('navGoals').addEventListener('click', () => showView('goals'));
  $('btnMore').addEventListener('click', () => setTray($('tray').hidden || !$('tray').classList.contains('open')));
  $('trayBg').addEventListener('click', () => setTray(false));
  $('trayStats').addEventListener('click', () => showView('stats'));
  $('trayChat').addEventListener('click', () => showView('chat'));
  $('btnDev').addEventListener('click', () => setTray(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('tray').hidden && !$('dlg').classList.contains('open')) setTray(false); });
  $('stPrev').addEventListener('click', () => { const s = shiftMonth(stt.y, stt.m, -1); stt.y = s.y; stt.m = s.m; loadStats(); });
  $('stNext').addEventListener('click', () => { const s = shiftMonth(stt.y, stt.m, 1); stt.y = s.y; stt.m = s.m; loadStats(); });
  $('chForm').addEventListener('submit', (e) => { e.preventDefault(); chSend($('chIn').value); });
  $('chIn').addEventListener('input', (e) => { const el = e.target; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 96) + 'px'; });
  $('chIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer:fine)').matches) { e.preventDefault(); chSend($('chIn').value); } });
  document.querySelectorAll('.meth').forEach((box) => box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]'); if (!b) return;
    const k = box.id === 'methOut' ? 'out' : 'in';
    fm[k] = fm[k] === b.dataset.m && !editing ? '' : b.dataset.m; paintMeth(); setFormError('');
  }));
  $('goalDoneBtn').addEventListener('click', () => { const b = $('goalDoneBtn'); b.setAttribute('aria-expanded', String(b.getAttribute('aria-expanded') !== 'true')); });
  $('gnPick').addEventListener('click', () => $('gnFile').click());
  $('gnChange').addEventListener('click', () => $('gnFile').click());
  $('gnRm').addEventListener('click', () => { gs.photo = null; paintNewPhoto(); });
  $('gnFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) pickPhoto(f); });
  bindMoneyFree($('gnPrice'), () => { $('gnErr').textContent = ''; $('gnSave')._disarm(); });
  $('gnName').addEventListener('input', () => { $('gnErr').textContent = ''; $('gnSave')._disarm(); });
  bindArm($('gnSave'), prepareNewGoal, commitNewGoal, afterNewGoal);
  $('formGoal').addEventListener('submit', (e) => e.preventDefault());
  bindMoneyFree($('geAmt'), () => { $('geErr').textContent = ''; $('geSave')._disarm(); updatePreview(); });
  $('geTog').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { setDir(b.dataset.dir); $('geErr').textContent = ''; $('geSave')._disarm(); updatePreview(); }));
  bindArm($('geSave'), prepareEntry, commitEntry);
  $('formEntry').addEventListener('submit', (e) => e.preventDefault());
  $('gdBuy').addEventListener('click', buyGoal);
  $('gdCancel').addEventListener('click', cancelGoal);
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
    if (!(await ask({ icon: 'trash', danger: true, title: 'Hapus semua catatan?', ok: 'Hapus semua',
      text: `Semua catatan di akun @${state.user.username} akan dihapus. Tindakan ini tidak bisa dibatalkan.` }))) return;
    if (!(await ask({ icon: 'trash', danger: true, title: 'Yakin?', ok: 'Ya, hapus', text: 'Pastikan sudah ekspor backup bila perlu.' }))) return;
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
  window.addEventListener('online', () => { setNet(true); flushQueue(); });
  window.addEventListener('offline', () => setNet(false));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) flushQueue(); });
  setInterval(flushQueue, 30000);
  boot();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}
init();
})();
