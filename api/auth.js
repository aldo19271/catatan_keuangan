// Akun: daftar, masuk, keluar, cek sesi, hapus akun.
//   GET  /api/auth                 -> { user } bila sudah masuk, 401 bila belum
//   POST /api/auth {action:'register', email, username, password}
//   POST /api/auth {action:'login', username, password}
//   POST /api/auth {action:'logout'}
//   POST /api/auth {action:'delete', password}   (hapus akun + semua catatan)
const { query } = require('./_db');
const A = require('./_auth');

const USER_RE = /^[A-Za-z0-9_.]{3,20}$/;
const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(res, code, msg) { return res.status(code).json({ error: msg }); }

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const sess = await A.getSession(req);
      if (!sess) return fail(res, 401, 'Belum masuk.');
      await A.renewIfOld(req, res, sess);
      return res.status(200).json({ user: { username: sess.username } });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return fail(res, 405, 'Metode tidak diizinkan.');
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object') return fail(res, 400, 'Permintaan tidak valid.');
    const action = body.action;

    if (action === 'logout') {
      const sess = await A.getSession(req);
      if (sess) await A.destroySession(sess.token);
      A.clearSessionCookie(req, res);
      return res.status(200).json({ ok: true });
    }

    if (action === 'register') {
      if (A.tooMany(req, 10, 60000)) return fail(res, 429, 'Terlalu banyak percobaan. Tunggu sebentar.');
      const email = String(body.email || '').trim();
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!MAIL_RE.test(email) || email.length > 254) return fail(res, 400, 'Gmail tidak valid.');
      if (!USER_RE.test(username)) return fail(res, 400, 'Username 3-20 karakter: huruf, angka, titik, atau garis bawah.');
      if (password.length < 6 || password.length > 100) return fail(res, 400, 'Password minimal 6 karakter.');
      const dup = await query('SELECT username_lc, email_lc FROM users WHERE username_lc = $1 OR email_lc = $2',
        [username.toLowerCase(), email.toLowerCase()]);
      if (dup.some((r) => r.username_lc === username.toLowerCase())) return fail(res, 409, 'Username sudah dipakai.');
      if (dup.length) return fail(res, 409, 'Gmail sudah terdaftar.');
      const hash = await A.hashPassword(password);
      let rows;
      try {
        rows = await query(
          `INSERT INTO users (username, username_lc, email, email_lc, pass_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::bigint) RETURNING id`,
          [username, username.toLowerCase(), email, email.toLowerCase(), hash, Date.now()]);
      } catch (e) {
        if (/unique|duplicate/i.test(String(e && e.message))) return fail(res, 409, 'Username atau Gmail sudah terdaftar.');
        throw e;
      }
      await A.createSession(req, res, Number(rows[0].id));
      return res.status(200).json({ user: { username } });
    }

    if (action === 'login') {
      if (A.tooMany(req, 10, 60000)) return fail(res, 429, 'Terlalu banyak percobaan. Tunggu sebentar.');
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!username || !password || username.length > 40 || password.length > 100) return fail(res, 400, 'Isi username dan password.');
      const rows = await query('SELECT id, username, pass_hash FROM users WHERE username_lc = $1', [username]);
      const ok = await A.verifyPassword(password, rows[0] && rows[0].pass_hash);
      if (!ok) return fail(res, 401, 'Username atau password salah.');
      await A.createSession(req, res, Number(rows[0].id));
      return res.status(200).json({ user: { username: rows[0].username } });
    }

    if (action === 'delete') {
      const sess = await A.getSession(req);
      if (!sess) return fail(res, 401, 'Belum masuk.');
      if (A.tooMany(req, 10, 60000)) return fail(res, 429, 'Terlalu banyak percobaan. Tunggu sebentar.');
      const rows = await query('SELECT pass_hash FROM users WHERE id = $1::bigint', [sess.id]);
      const ok = await A.verifyPassword(String(body.password || ''), rows[0] && rows[0].pass_hash);
      if (!ok) return fail(res, 403, 'Password salah.');
      await query('DELETE FROM users WHERE id = $1::bigint', [sess.id]); // sesi, catatan, dan saran ikut terhapus (CASCADE)
      A.clearSessionCookie(req, res);
      return res.status(200).json({ ok: true });
    }

    return fail(res, 400, 'Aksi tidak dikenal.');
  } catch (e) {
    if (e && e.config) return fail(res, 500, e.message);
    console.error('auth error:', e && e.message);
    return fail(res, 500, 'Terjadi kesalahan di server. Coba lagi.');
  }
};
