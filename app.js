(() => {
'use strict';

/* ================= Konstanta & helper ================= */
const DAYS_SHORT = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
const DAYS_LONG = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
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

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
};

/* ================= IndexedDB ================= */
let dbPromise;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('catatan-keuangan', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const tx = db.createObjectStore('tx', { keyPath: 'id' });
        tx.createIndex('date', 'date');
        db.createObjectStore('advice', { keyPath: 'date' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
function withTx(names, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    let result;
    const req = fn(t);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaksi database dibatalkan'));
  }));
}
const dbRange = (from, to) => withTx('tx', 'readonly', (t) => t.objectStore('tx').index('date').getAll(IDBKeyRange.bound(from, to)));
const dbGetAdvice = (date) => withTx('advice', 'readonly', (t) => t.objectStore('advice').get(date));
const dbPutAdvice = (a) => withTx('advice', 'readwrite', (t) => t.objectStore('advice').put(a));
function dbAdd(items) {
  return withTx(['tx', 'advice'], 'readwrite', (t) => {
    items.forEach((it) => { t.objectStore('tx').put(it); t.objectStore('advice').delete(it.date); });
  });
}
function dbUpdate(item) {
  return withTx(['tx', 'advice'], 'readwrite', (t) => {
    t.objectStore('tx').put(item); t.objectStore('advice').delete(item.date);
  });
}
function dbDelete(id, date) {
  return withTx(['tx', 'advice'], 'readwrite', (t) => {
    t.objectStore('tx').delete(id); t.objectStore('advice').delete(date);
  });
}
async function dbExport() {
  const [tx, advice] = await Promise.all([
    withTx('tx', 'readonly', (t) => t.objectStore('tx').getAll()),
    withTx('advice', 'readonly', (t) => t.objectStore('advice').getAll()),
  ]);
  return { app: 'catatan-keuangan', version: 1, exportedAt: new Date().toISOString(), tx, advice };
}
function dbImport(txs, advices) {
  return withTx(['tx', 'advice'], 'readwrite', (t) => {
    txs.forEach((x) => t.objectStore('tx').put(x));
    advices.forEach((a) => t.objectStore('advice').put(a));
  });
}
const dbClear = () => withTx(['tx', 'advice'], 'readwrite', (t) => {
  t.objectStore('tx').clear(); t.objectStore('advice').clear();
});

/* ================= State ================= */
const state = { offset: 0, selected: todayKey(), lastToday: todayKey(), seq: 0, pending: new Set() };
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
  if (v >= 1e6) { const x = v / 1e6; return (Number.isInteger(x) ? String(x) : x.toFixed(1).replace('.', ',')) + ' jt'; }
  if (v >= 1e3) return Math.round(v / 1e3) + ' rb';
  return String(Math.round(v));
}
function drawChart(days, selIdx) {
  const svg = $('chart');
  svg.replaceChildren();
  const W = 340, H = 170, L = 44, R = 14, T = 14, B = 26;
  const iw = W - L - R, ih = H - T - B;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const peak = Math.max(0, ...days.map((d) => Math.max(d.out, d.inc)));
  const max = niceMax(peak);
  const x = (i) => L + (iw * i) / 6;
  const y = (v) => T + ih - (v / max) * ih;

  [0, 0.5, 1].forEach((f) => {
    const yy = T + ih - ih * f;
    svg.append(
      s('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: 'grid' }),
      s('text', { x: L - 6, y: yy + 3, class: 'ylab', 'text-anchor': 'end' }, short(max * f)),
    );
  });
  days.forEach((d, i) => svg.append(
    s('text', { x: x(i), y: H - 8, class: 'xlab' + (i === selIdx ? ' sel' : ''), 'text-anchor': 'middle' }, DAYS_SHORT[i]),
  ));
  if (selIdx >= 0) svg.append(s('line', { x1: x(selIdx), x2: x(selIdx), y1: T, y2: T + ih, class: 'selline' }));

  const draw = (key, cls) => {
    svg.append(s('polyline', { points: days.map((d, i) => `${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' '), class: 'ln ' + cls }));
    days.forEach((d, i) => svg.append(s('circle', { cx: x(i).toFixed(1), cy: y(d[key]).toFixed(1), r: i === selIdx ? 4.5 : 2.6, class: 'dot ' + cls })));
  };
  draw('out', 'out');
  draw('inc', 'inc');

  days.forEach((d, i) => {
    const r = s('rect', { x: (x(i) - iw / 12).toFixed(1), y: T, width: (iw / 6).toFixed(1), height: ih + B, fill: 'transparent', class: 'hit' });
    r.addEventListener('click', () => selectDay(d.key));
    svg.append(r);
  });
}

/* ================= Render ================= */
async function render() {
  const seq = ++state.seq;
  const dates = weekDates(state.offset);
  const keys = dates.map(keyOf);
  if (!keys.includes(state.selected)) state.selected = state.offset === 0 ? todayKey() : keys[0];
  const sel = state.selected;
  const [list, adv] = await Promise.all([dbRange(keys[0], keys[6]), dbGetAdvice(sel)]);
  if (seq !== state.seq) return;

  const by = {};
  keys.forEach((k) => { by[k] = []; });
  list.forEach((t) => { if (by[t.date]) by[t.date].push(t); });
  const days = keys.map((k) => ({
    key: k,
    out: by[k].filter((t) => t.type === 'out').reduce((a, t) => a + t.amount, 0),
    inc: by[k].filter((t) => t.type === 'in').reduce((a, t) => a + t.amount, 0),
  }));
  const selIdx = keys.indexOf(sel);

  drawChart(days, selIdx);
  $('totOut').textContent = rupiah(days.reduce((a, d) => a + d.out, 0));
  $('totIn').textContent = rupiah(days.reduce((a, d) => a + d.inc, 0));
  const sameMonth = dates[0].getMonth() === dates[6].getMonth();
  const startLabel = sameMonth ? String(dates[0].getDate()) : fmtMini(dates[0]);
  $('weekLabel').textContent = `${startLabel} – ${fmtMini(dates[6])} ${dates[6].getFullYear()}` + (state.offset === 0 ? ' · minggu ini' : '');
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

  drawDetail(sel, by[sel].slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)), adv);
}

function drawDetail(key, txs, adv) {
  const box = $('detail');
  const t = todayKey();
  const isToday = key === t, isPast = key < t, hasData = txs.length > 0;
  const out = txs.filter((x) => x.type === 'out').reduce((a, x) => a + x.amount, 0);
  const inc = txs.filter((x) => x.type === 'in').reduce((a, x) => a + x.amount, 0);

  let hint = '';
  if (!isPast) hint = 'Beri Saran tersedia setelah hari ini berlalu.';
  else if (!hasData) hint = 'Tidak ada catatan di hari ini untuk dianalisis.';
  const canAdvise = isPast && hasData;
  const label = canAdvise && adv ? 'Lihat Saran' : 'Beri Saran';

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
  box.style.animation = 'none';
  void box.offsetWidth;
  box.style.animation = '';
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
function bindMoney(inp) {
  inp.addEventListener('input', () => {
    const d = inp.value.replace(/\D/g, '').slice(0, 12).replace(/^0+(?=\d)/, '');
    inp.value = d === '' ? '' : fmtNum(Number(d));
  });
  inp.addEventListener('focus', () => { if (parseAmount(inp.value) === 0) inp.value = ''; });
  inp.addEventListener('blur', () => { if (!inp.value) inp.value = '0'; });
}
function setFormError(msg) { $('formErr').textContent = msg || ''; }

function openAdd() {
  editing = null;
  $('formTitle').textContent = 'Catatan';
  $('inOut').value = '0'; $('inIn').value = '0'; $('inDesc').value = '';
  $('inOut').disabled = false; $('inIn').disabled = false;
  setFormError('');
  openSheet('sheetForm');
}
function openEdit(item) {
  editing = item;
  $('formTitle').textContent = 'Ubah Catatan';
  $('inOut').value = item.type === 'out' ? fmtNum(item.amount) : '0';
  $('inIn').value = item.type === 'in' ? fmtNum(item.amount) : '0';
  $('inOut').disabled = item.type !== 'out';
  $('inIn').disabled = item.type !== 'in';
  $('inDesc').value = item.desc || '';
  setFormError('');
  openSheet('sheetForm');
}
async function submitForm(e) {
  e.preventDefault();
  const btn = $('btnConfirm');
  if (btn.disabled) return;
  const out = parseAmount($('inOut').value), inc = parseAmount($('inIn').value);
  const desc = $('inDesc').value.trim().slice(0, 200);
  btn.disabled = true;
  try {
    if (editing) {
      const amount = editing.type === 'out' ? out : inc;
      if (amount <= 0) { setFormError('Nominal harus lebih dari 0. Untuk membuang catatan, gunakan tombol hapus.'); return; }
      await dbUpdate({ ...editing, amount, desc });
    } else {
      if (out <= 0 && inc <= 0) { setFormError('Isi pengeluaran atau penghasilan terlebih dahulu.'); return; }
      const date = todayKey(), now = Date.now();
      const items = [];
      if (out > 0) items.push({ id: uid(), date, type: 'out', amount: out, desc, createdAt: now });
      if (inc > 0) items.push({ id: uid(), date, type: 'in', amount: inc, desc, createdAt: now + 1 });
      await dbAdd(items);
      state.offset = 0;
      state.selected = date;
      requestPersist();
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
    body.replaceChildren(h('div', { class: 'spin' }), h('p', { class: 'center', text: 'Gemini sedang menganalisis catatanmu…' }));
  } else if (kind === 'ok') {
    renderAdvice(body, text);
  } else {
    body.replaceChildren(h('p', { class: 'msg' + (kind === 'error' ? ' bad' : ''), text }));
  }
}
async function fetchSaran(date, txs) {
  const code = store.get('ck_code');
  if (!code) throw new Error('Masukkan kode akses di Pengaturan (ikon gerigi) terlebih dahulu.');
  let res;
  try {
    res = await fetch('/api/saran', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-code': code },
      body: JSON.stringify({ date, items: txs.map((x) => ({ type: x.type, amount: x.amount, desc: x.desc || '' })) }),
    });
  } catch (e) {
    throw new Error('Tidak ada koneksi internet. Coba lagi saat online.');
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* abaikan */ }
  if (res.status === 401) throw new Error('Kode akses salah. Periksa lagi di Pengaturan.');
  if (res.status === 429) throw new Error(data.error || 'Terlalu banyak permintaan atau kuota Gemini habis. Coba lagi nanti.');
  if (!res.ok || !data.saran) throw new Error(data.error || 'Gagal mendapatkan saran. Coba lagi nanti.');
  return data.saran;
}
async function openAdvice(key) {
  if (key >= todayKey()) return;
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
function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* abaikan */ }
}
async function refreshPersist() {
  const el = $('persistMsg');
  try {
    if (navigator.storage && navigator.storage.persisted) {
      const p = await navigator.storage.persisted();
      el.textContent = p
        ? 'Penyimpanan dilindungi: browser tidak akan menghapus data otomatis.'
        : 'Penyimpanan belum dikunci. Browser bisa menghapus data saat memori penuh, jadi tetap ekspor backup berkala. Memasang aplikasi ke layar utama membantu.';
    } else { el.textContent = 'Browser ini tidak mendukung pengecekan penyimpanan.'; }
  } catch (e) { el.textContent = ''; }
}
function openSettings() {
  $('inCode').value = store.get('ck_code') || '';
  $('codeMsg').textContent = ''; $('backupMsg').textContent = '';
  refreshPersist();
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
    if (!confirm(`Impor ${txs.length} catatan? Data akan digabung dengan data yang sudah ada.`)) return;
    await dbImport(txs, advices);
    msg.textContent = `Berhasil mengimpor ${txs.length} catatan.`;
    render();
  } catch (e) { msg.textContent = 'Gagal mengimpor: ' + e.message; }
}

/* ================= Rollover tengah malam ================= */
function checkRollover() {
  const t = todayKey();
  if (t !== state.lastToday) {
    state.lastToday = t; state.offset = 0; state.selected = t;
    render();
  }
}

/* ================= Init ================= */
function init() {
  bindMoney($('inOut')); bindMoney($('inIn'));
  $('btnAdd').addEventListener('click', openAdd);
  $('form').addEventListener('submit', submitForm);
  $('btnSettings').addEventListener('click', openSettings);
  $('prevWeek').addEventListener('click', () => { state.offset -= 1; render(); });
  $('nextWeek').addEventListener('click', () => { if (state.offset < 0) { state.offset += 1; render(); } });
  $('btnSaveCode').addEventListener('click', () => {
    const v = $('inCode').value.trim();
    const ok = v ? store.set('ck_code', v) : (() => { try { localStorage.removeItem('ck_code'); return true; } catch (e) { return false; } })();
    $('codeMsg').textContent = ok ? (v ? 'Kode akses disimpan.' : 'Kode akses dihapus.') : 'Gagal menyimpan (penyimpanan browser diblokir).';
  });
  $('btnExport').addEventListener('click', doExport);
  $('btnImport').addEventListener('click', () => $('fileImport').click());
  $('fileImport').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) doImport(f); });
  $('btnClear').addEventListener('click', async () => {
    if (!confirm('Hapus SEMUA catatan di perangkat ini? Tindakan ini tidak bisa dibatalkan.')) return;
    if (!confirm('Yakin? Pastikan sudah ekspor backup bila perlu.')) return;
    await dbClear();
    closeSheet('sheetSettings');
    render();
  });
  setInterval(checkRollover, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkRollover(); render(); } });
  render().catch((e) => {
    $('detail').replaceChildren(h('p', { class: 'empty', text: 'Database tidak bisa dibuka: ' + e.message + '. Coba keluar dari mode privat.' }));
  });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}
init();
})();
