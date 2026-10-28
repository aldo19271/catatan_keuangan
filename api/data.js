// Catatan dan saran milik akun yang sedang masuk (semua kueri dibatasi user_id sesi).
//   GET  /api/data?from=YYYY-MM-DD&to=YYYY-MM-DD   -> { items }
//   GET  /api/data?advice=YYYY-MM-DD               -> { advice }
//   GET  /api/data?export=1                        -> { tx, advice }
//   POST /api/data {action:'add', items}           tambah (dan buang saran hari itu)
//   POST /api/data {action:'update', id, amount, desc}
//   POST /api/data {action:'delete', id}
//   POST /api/data {action:'advice', date, text}   simpan saran
//   POST /api/data {action:'import', tx, advice}   gabung (id sama ditimpa)
//   POST /api/data {action:'clear'}                hapus semua catatan + saran akun ini
const { query } = require('./_db');
const A = require('./_auth');

const MAX_AMOUNT = 999999999999;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BATCH = 1000;

const fail = (res, code, msg) => res.status(code).json({ error: msg });
const toItem = (r) => ({ id: r.id, date: r.date, type: r.type, amount: Number(r.amount), desc: r.descr || '', createdAt: Number(r.created_at) });

function cleanTx(x) {
  if (!x || typeof x.id !== 'string' || !x.id || x.id.length > 64) return null;
  if (typeof x.date !== 'string' || !DATE_RE.test(x.date)) return null;
  if (x.type !== 'out' && x.type !== 'in') return null;
  const amount = Math.round(Number(x.amount));
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return null;
  return { id: x.id, date: x.date, type: x.type, amount, desc: typeof x.desc === 'string' ? x.desc.slice(0, 200) : '', createdAt: Math.max(0, Math.round(Number(x.createdAt) || 0)) };
}
function cleanAdvice(a) {
  if (!a || typeof a.date !== 'string' || !DATE_RE.test(a.date) || typeof a.text !== 'string' || !a.text) return null;
  return { date: a.date, text: a.text.slice(0, 4000), createdAt: Math.max(0, Math.round(Number(a.createdAt) || 0)) };
}

const UPSERT_TX = `INSERT INTO tx (user_id, id, date, type, amount, descr, created_at)
  SELECT $1::bigint, * FROM unnest($2::text[], $3::text[], $4::text[], $5::bigint[], $6::text[], $7::bigint[])
  ON CONFLICT (user_id, id) DO UPDATE SET date = EXCLUDED.date, type = EXCLUDED.type, amount = EXCLUDED.amount,
    descr = EXCLUDED.descr, created_at = EXCLUDED.created_at`;
const txArgs = (uid, list) => [uid, list.map((t) => t.id), list.map((t) => t.date), list.map((t) => t.type), list.map((t) => t.amount), list.map((t) => t.desc), list.map((t) => t.createdAt)];

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sess = await A.getSession(req);
    if (!sess) return fail(res, 401, 'Sesi berakhir. Silakan masuk lagi.');
    const uid = sess.id;

    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.export) {
        const [tx, adv] = await Promise.all([
          query('SELECT id, date, type, amount, descr, created_at FROM tx WHERE user_id = $1::bigint ORDER BY date, created_at, id', [uid]),
          query('SELECT date, text, created_at FROM advice WHERE user_id = $1::bigint ORDER BY date', [uid]),
        ]);
        return res.status(200).json({ tx: tx.map(toItem), advice: adv.map((a) => ({ date: a.date, text: a.text, createdAt: Number(a.created_at) })) });
      }
      if (q.advice) {
        if (!DATE_RE.test(String(q.advice))) return fail(res, 400, 'Tanggal tidak valid.');
        const r = await query('SELECT date, text, created_at FROM advice WHERE user_id = $1::bigint AND date = $2', [uid, String(q.advice)]);
        return res.status(200).json({ advice: r[0] ? { date: r[0].date, text: r[0].text, createdAt: Number(r[0].created_at) } : null });
      }
      const from = String(q.from || ''), to = String(q.to || '');
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) return fail(res, 400, 'Rentang tanggal tidak valid.');
      const r = await query('SELECT id, date, type, amount, descr, created_at FROM tx WHERE user_id = $1::bigint AND date >= $2 AND date <= $3 ORDER BY date, created_at, id', [uid, from, to]);
      return res.status(200).json({ items: r.map(toItem) });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return fail(res, 405, 'Metode tidak diizinkan.');
    }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object') return fail(res, 400, 'Permintaan tidak valid.');

    switch (body.action) {
      case 'add': {
        const list = (Array.isArray(body.items) ? body.items : []).map(cleanTx);
        if (!list.length || list.length > 50 || list.includes(null)) return fail(res, 400, 'Catatan tidak valid.');
        await query(`WITH ins AS (${UPSERT_TX} RETURNING date) DELETE FROM advice WHERE user_id = $1::bigint AND date IN (SELECT date FROM ins)`, txArgs(uid, list));
        return res.status(200).json({ ok: true });
      }
      case 'update': {
        const amount = Math.round(Number(body.amount));
        if (typeof body.id !== 'string' || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return fail(res, 400, 'Nominal tidak valid.');
        const desc = typeof body.desc === 'string' ? body.desc.slice(0, 200) : '';
        const r = await query(
          `WITH u AS (UPDATE tx SET amount = $3::bigint, descr = $4 WHERE user_id = $1::bigint AND id = $2 RETURNING date),
                d AS (DELETE FROM advice WHERE user_id = $1::bigint AND date IN (SELECT date FROM u) RETURNING 1)
           SELECT count(*) AS n FROM u`, [uid, body.id, amount, desc]);
        if (!Number(r[0].n)) return fail(res, 404, 'Catatan tidak ditemukan.');
        return res.status(200).json({ ok: true });
      }
      case 'delete': {
        if (typeof body.id !== 'string') return fail(res, 400, 'Catatan tidak valid.');
        await query(
          `WITH d AS (DELETE FROM tx WHERE user_id = $1::bigint AND id = $2 RETURNING date)
           DELETE FROM advice WHERE user_id = $1::bigint AND date IN (SELECT date FROM d)`, [uid, body.id]);
        return res.status(200).json({ ok: true });
      }
      case 'advice': {
        const a = cleanAdvice(body);
        if (!a) return fail(res, 400, 'Saran tidak valid.');
        await query(`INSERT INTO advice (user_id, date, text, created_at) VALUES ($1::bigint, $2, $3, $4::bigint)
                     ON CONFLICT (user_id, date) DO UPDATE SET text = EXCLUDED.text, created_at = EXCLUDED.created_at`,
          [uid, a.date, a.text, a.createdAt || Date.now()]);
        return res.status(200).json({ ok: true });
      }
      case 'import': {
        const txs = (Array.isArray(body.tx) ? body.tx : []).map(cleanTx).filter(Boolean);
        const advs = (Array.isArray(body.advice) ? body.advice : []).map(cleanAdvice).filter(Boolean);
        if (txs.length > MAX_BATCH || advs.length > MAX_BATCH) return fail(res, 413, 'Data terlalu besar untuk satu permintaan.');
        if (!txs.length && !advs.length) return res.status(200).json({ ok: true });
        await query(
          `WITH t AS (${UPSERT_TX} RETURNING 1)
           INSERT INTO advice (user_id, date, text, created_at)
           SELECT $1::bigint, * FROM unnest($8::text[], $9::text[], $10::bigint[])
           ON CONFLICT (user_id, date) DO UPDATE SET text = EXCLUDED.text, created_at = EXCLUDED.created_at`,
          [...txArgs(uid, txs), advs.map((a) => a.date), advs.map((a) => a.text), advs.map((a) => a.createdAt)]);
        return res.status(200).json({ ok: true });
      }
      case 'clear': {
        await query(`WITH a AS (DELETE FROM advice WHERE user_id = $1::bigint) DELETE FROM tx WHERE user_id = $1::bigint`, [uid]);
        return res.status(200).json({ ok: true });
      }
      default:
        return fail(res, 400, 'Aksi tidak dikenal.');
    }
  } catch (e) {
    if (e && e.config) return fail(res, 500, e.message);
    console.error('data error:', e && e.message);
    return fail(res, 500, 'Terjadi kesalahan di server. Coba lagi.');
  }
};
