// Target barang + tabungan per barang (semua kueri dibatasi user_id sesi).
//   GET  /api/goals                      -> { goals: [{id,name,price,photo,status,createdAt,closedAt,saved}] }  (aktif + yang sudah terbeli)
//   GET  /api/goals?entries=<id>         -> { entries: [{id,amount,createdAt}] }  (50 terbaru)
//   POST /api/goals {action:'create', name, price, photo?, id?, createdAt?}   id/createdAt dari klien (antrean offline, aman dikirim ulang)
//   POST /api/goals {action:'entry', goalId, dir:'in'|'out', amount, entryId?, createdAt?}   nabung / tarik (saldo tidak boleh minus)
//   POST /api/goals {action:'close', goalId}    sudah dibeli -> status 'done' (data tetap disimpan)
//   POST /api/goals {action:'remove', goalId}   batal beli -> semua detail + catatan tabungannya dihapus
const crypto = require('crypto');
const { query } = require('./_db');
const A = require('./_auth');

const MAX_AMOUNT = 999999999999;
const MAX_ACTIVE = 20;        // target aktif per akun
const MAX_DONE_SHOWN = 20;    // riwayat "sudah terbeli" yang dikirim
const MAX_ENTRIES = 1000;     // catatan tabungan per target
const MAX_PHOTO = 90000;      // panjang data-URL foto (klien mengecilkan ke sekitar 70 KB)
const PHOTO_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const fail = (res, code, msg) => res.status(code).json({ error: msg });
const newId = () => crypto.randomBytes(9).toString('hex');
const ID_RE = /^[a-z0-9]{8,32}$/;
// id dan waktu boleh dikirim klien (antrean offline): kirim ulang dengan id sama tidak menggandakan data
const pickId = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : newId());
const pickTime = (v, now) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > now - 400 * 864e5 && n <= now + 6e4 ? n : now; };
const toGoal = (r) => ({
  id: r.id, name: r.name, price: Number(r.price), photo: r.photo || null, status: r.status,
  createdAt: Number(r.created_at), closedAt: r.closed_at == null ? null : Number(r.closed_at), saved: Number(r.saved),
});
const SELECT_GOALS = `SELECT g.id, g.name, g.price, g.photo, g.status, g.created_at, g.closed_at,
    COALESCE((SELECT SUM(e.amount) FROM goal_entries e WHERE e.user_id = g.user_id AND e.goal_id = g.id), 0) AS saved
  FROM goals g WHERE g.user_id = $1::bigint`;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sess = await A.getSession(req);
    if (!sess) return fail(res, 401, 'Sesi berakhir. Silakan masuk lagi.');
    const uid = sess.id;

    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.entries) {
        const r = await query(
          `SELECT id, amount, created_at FROM goal_entries WHERE user_id = $1::bigint AND goal_id = $2 ORDER BY created_at DESC, id DESC LIMIT 50`,
          [uid, String(q.entries).slice(0, 64)]);
        return res.status(200).json({ entries: r.map((e) => ({ id: e.id, amount: Number(e.amount), createdAt: Number(e.created_at) })) });
      }
      const [active, done] = await Promise.all([
        query(SELECT_GOALS + ` AND g.status = 'active' ORDER BY g.created_at, g.id`, [uid]),
        query(SELECT_GOALS + ` AND g.status = 'done' ORDER BY g.closed_at DESC NULLS LAST, g.id LIMIT ${MAX_DONE_SHOWN}`, [uid]),
      ]);
      return res.status(200).json({ goals: active.map(toGoal).concat(done.map(toGoal)) });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return fail(res, 405, 'Metode tidak diizinkan.');
    }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object') return fail(res, 400, 'Permintaan tidak valid.');
    const now = Date.now();
    const goalId = typeof body.goalId === 'string' ? body.goalId.slice(0, 64) : '';

    switch (body.action) {
      case 'create': {
        const name = String(body.name == null ? '' : body.name).trim().replace(/\s+/g, ' ');
        const price = Math.round(Number(body.price));
        if (!name) return fail(res, 400, 'Nama barang wajib diisi.');
        if (name.length > 60) return fail(res, 400, 'Nama barang maksimal 60 karakter.');
        if (!Number.isFinite(price) || price <= 0) return fail(res, 400, 'Harga barang wajib diisi.');
        if (price > MAX_AMOUNT) return fail(res, 400, 'Harga terlalu besar.');
        let photo = null;
        if (body.photo != null && body.photo !== '') {
          if (typeof body.photo !== 'string' || body.photo.length > MAX_PHOTO || !PHOTO_RE.test(body.photo)) return fail(res, 400, 'Foto tidak valid atau terlalu besar.');
          photo = body.photo;
        }
        // batas jumlah target aktif dicek di pernyataan yang sama dengan insert
        const gid = pickId(body.id);
        const r = await query(
          `INSERT INTO goals (user_id, id, name, price, photo, status, created_at)
           SELECT $1::bigint, $2, $3, $4::bigint, $5, 'active', $6::bigint
           WHERE (SELECT COUNT(*) FROM goals WHERE user_id = $1::bigint AND status = 'active') < ${MAX_ACTIVE}
           ON CONFLICT (user_id, id) DO NOTHING
           RETURNING id`, [uid, gid, name, price, photo, pickTime(body.createdAt, now)]);
        const g = await query(SELECT_GOALS + ' AND g.id = $2', [uid, gid]);
        if (!r.length && !g.length) return fail(res, 400, `Maksimal ${MAX_ACTIVE} target aktif. Tutup atau batalkan salah satu dulu.`);
        return res.status(200).json({ goal: toGoal(g[0]) });
      }

      case 'entry': {
        const amount = Math.round(Number(body.amount));
        if (!goalId) return fail(res, 400, 'Target tidak valid.');
        if (body.dir !== 'in' && body.dir !== 'out') return fail(res, 400, 'Jenis catatan tidak valid.');
        if (!Number.isFinite(amount) || amount <= 0) return fail(res, 400, 'Masukkan nominal lebih dari 0.');
        if (amount > MAX_AMOUNT) return fail(res, 400, 'Nominal terlalu besar.');
        const signed = body.dir === 'in' ? amount : -amount;
        const eid = pickId(body.entryId), at = pickTime(body.createdAt, now);
        // satu pernyataan: target harus aktif, saldo tidak boleh minus, dan jumlah catatan dibatasi
        const r = await query(
          `WITH g AS (SELECT 1 FROM goals WHERE user_id = $1::bigint AND id = $2 AND status = 'active'),
                s AS (SELECT COALESCE(SUM(amount), 0) AS t, COUNT(*) AS n FROM goal_entries WHERE user_id = $1::bigint AND goal_id = $2)
           INSERT INTO goal_entries (user_id, goal_id, id, amount, created_at)
           SELECT $1::bigint, $2, $3, $4::bigint, $5::bigint FROM g, s
           WHERE s.t + $4::bigint >= 0 AND s.t + $4::bigint <= ${MAX_AMOUNT} AND s.n < ${MAX_ENTRIES}
           ON CONFLICT (user_id, id) DO NOTHING
           RETURNING id`, [uid, goalId, eid, signed, at]);
        const cur = await query(SELECT_GOALS + ' AND g.id = $2', [uid, goalId]);
        const dup = !r.length ? await query('SELECT 1 FROM goal_entries WHERE user_id = $1::bigint AND id = $2 AND goal_id = $3', [uid, eid, goalId]) : [];
        if (dup.length) return res.status(200).json({ saved: Number(cur[0].saved), entry: { id: eid, amount: signed, createdAt: at } });
        if (!r.length) {
          if (!cur.length || cur[0].status !== 'active') return fail(res, 404, 'Target tidak ditemukan atau sudah ditutup.');
          const saved = Number(cur[0].saved);
          if (signed < 0 && saved + signed < 0) return fail(res, 400, 'Nominal melebihi tabungan yang ada.');
          return fail(res, 400, 'Catatan tabungan sudah mencapai batas.');
        }
        return res.status(200).json({ saved: Number(cur[0].saved), entry: { id: eid, amount: signed, createdAt: at } });
      }

      case 'close': {
        if (!goalId) return fail(res, 400, 'Target tidak valid.');
        const r = await query(
          `UPDATE goals SET status = 'done', closed_at = $3::bigint WHERE user_id = $1::bigint AND id = $2 AND status = 'active' RETURNING id`,
          [uid, goalId, now]);
        if (!r.length) return fail(res, 404, 'Target tidak ditemukan atau sudah ditutup.');
        return res.status(200).json({ ok: true });
      }

      case 'remove': {
        if (!goalId) return fail(res, 400, 'Target tidak valid.');
        const r = await query(`DELETE FROM goals WHERE user_id = $1::bigint AND id = $2 AND status = 'active' RETURNING id`, [uid, goalId]);
        if (!r.length) return fail(res, 404, 'Target tidak ditemukan atau sudah ditutup.');
        return res.status(200).json({ ok: true });
      }

      default:
        return fail(res, 400, 'Aksi tidak dikenal.');
    }
  } catch (e) {
    console.error('goals error:', e && e.message);
    return fail(res, 500, 'Terjadi kesalahan di server.');
  }
};
