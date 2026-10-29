// Akun: daftar, masuk, keluar, cek sesi, ubah akun sendiri, hapus akun, dan pengelolaan semua akun oleh admin.
//   GET  /api/auth                          -> { user } bila sudah masuk, 401 bila belum
//   POST /api/auth {action:'register', email, username, password}
//   POST /api/auth {action:'login', username, password}
//   POST /api/auth {action:'logout'}
//   POST /api/auth {action:'admin_list', q}                      daftar + cari akun (hanya admin; q mencari Gmail, username, atau password)
//   POST /api/auth {action:'profile', email?, username?, password?, currentPassword?}   ubah akun sendiri
//   POST /api/auth {action:'admin_update', id, email?, username?, password?}            admin mengubah akun siapa pun
//   POST /api/auth {action:'delete', password}   (hapus akun + semua catatan; akun admin tidak bisa dihapus)
const { query } = require('./_db');
const A = require('./_auth');

const USER_RE = /^[A-Za-z0-9_.]{3,20}$/;
const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LIST = 500;

function fail(res, code, msg) { return res.status(code).json({ error: msg }); }
const userOut = (r) => ({ username: r.username, email: r.email, isAdmin: A.isTrue(r.is_admin) });

// validasi bidang akun; kembalikan pesan kesalahan atau null
function checkFields(f) {
  if (f.email !== undefined && (!MAIL_RE.test(f.email) || f.email.length > 254)) return 'Gmail tidak valid.';
  if (f.username !== undefined && !USER_RE.test(f.username)) return 'Username 3-20 karakter: huruf, angka, titik, atau garis bawah.';
  if (f.password !== undefined && (f.password.length < 6 || f.password.length > 100)) return 'Password minimal 6 karakter.';
  return null;
}
const str = (v) => (typeof v === 'string' ? v : undefined);

// pastikan username/Gmail belum dipakai akun lain (exceptId = akun yang sedang diubah)
async function dupError(username, email, exceptId, allowAdminName) {
  if (username !== undefined && username.toLowerCase() === 'admin' && !allowAdminName) return 'Username itu tidak tersedia.';
  const rows = await query(
    `SELECT id, username_lc, email_lc FROM users WHERE (username_lc = $1 OR email_lc = $2) AND id <> $3::bigint`,
    [username === undefined ? '' : username.toLowerCase(), email === undefined ? '' : email.toLowerCase(), exceptId]);
  if (username !== undefined && rows.some((r) => r.username_lc === username.toLowerCase())) return 'Username sudah dipakai.';
  if (email !== undefined && rows.some((r) => r.email_lc === email.toLowerCase())) return 'Gmail sudah terdaftar.';
  return null;
}

// terapkan perubahan (bidang yang undefined tidak diubah) dan kembalikan baris terbaru
async function applyUpdate(id, { username, email, password }) {
  const hash = password !== undefined ? await A.hashPassword(password) : null;
  const rows = await query(
    `UPDATE users SET
       username = COALESCE($2, username), username_lc = COALESCE($3, username_lc),
       email = COALESCE($4, email), email_lc = COALESCE($5, email_lc),
       pass_hash = COALESCE($6, pass_hash)
     WHERE id = $1::bigint RETURNING id, username, email, is_admin`,
    [id, username === undefined ? null : username, username === undefined ? null : username.toLowerCase(),
      email === undefined ? null : email, email === undefined ? null : email.toLowerCase(), hash]);
  return rows[0];
}

async function adminList(q, selfId) {
  const rows = await query(
    `SELECT id, username, email, is_admin, created_at, pass_hash FROM users ORDER BY is_admin DESC, created_at, id LIMIT ${MAX_LIST + 1}`, []);
  const truncated = rows.length > MAX_LIST;
  const list = rows.slice(0, MAX_LIST).map((r) => ({
    id: Number(r.id), username: r.username, email: r.email, isAdmin: A.isTrue(r.is_admin), createdAt: Number(r.created_at), self: Number(r.id) === selfId, hash: r.pass_hash, match: [],
  }));
  const text = q.trim().toLowerCase();
  if (q) {
    list.forEach((u) => {
      if (text && u.username.toLowerCase().includes(text)) u.match.push('username');
      if (text && u.email.toLowerCase().includes(text)) u.match.push('gmail');
    });
    // Password disimpan sebagai hash sehingga tidak bisa dibaca; pencarian password = cocok persis dengan teks yang diketik.
    const todo = list.filter((u) => !u.match.length);
    for (let i = 0; i < todo.length; i += 8) {
      await Promise.all(todo.slice(i, i + 8).map(async (u) => { if (await A.verifyPassword(q, u.hash)) u.match.push('password'); }));
    }
  }
  const out = (q ? list.filter((u) => u.match.length) : list).map(({ hash, ...u }) => u);
  return { users: out, total: list.length, truncated };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const sess = await A.getSession(req);
      if (!sess) return fail(res, 401, 'Belum masuk.');
      await A.renewIfOld(req, res, sess);
      return res.status(200).json({ user: { username: sess.username, email: sess.email, isAdmin: sess.isAdmin } });
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
      const bad = checkFields({ email, username, password });
      if (bad) return fail(res, 400, bad);
      const dup = await dupError(username, email, 0, false);
      if (dup) return fail(res, dup.includes('Gmail') ? 409 : dup.includes('tersedia') ? 400 : 409, dup);
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
      return res.status(200).json({ user: { username, email, isAdmin: false } });
    }

    if (action === 'login') {
      if (A.tooMany(req, 10, 60000)) return fail(res, 429, 'Terlalu banyak percobaan. Tunggu sebentar.');
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!username || !password || username.length > 40 || password.length > 100) return fail(res, 400, 'Isi username dan password.');
      const rows = await query('SELECT id, username, email, is_admin, pass_hash FROM users WHERE username_lc = $1', [username]);
      const ok = await A.verifyPassword(password, rows[0] && rows[0].pass_hash);
      if (!ok) return fail(res, 401, 'Username atau password salah.');
      await A.createSession(req, res, Number(rows[0].id));
      return res.status(200).json({ user: userOut(rows[0]) });
    }

    const sess = await A.getSession(req);
    if (!sess) return fail(res, 401, 'Belum masuk.');

    if (action === 'admin_list') { // daftar + pencarian semua akun (POST agar teks pencarian, yang bisa berupa password, tidak masuk URL/log)
      if (!sess.isAdmin) return fail(res, 403, 'Hanya admin yang boleh membuka ini.');
      const q = typeof body.q === 'string' ? body.q.slice(0, 100) : '';
      if (q && A.tooMany(req, 30, 60000)) return fail(res, 429, 'Terlalu banyak pencarian. Tunggu sebentar.');
      return res.status(200).json(await adminList(q, sess.id));
    }

    if (action === 'profile') { // ubah akun sendiri
      const f = { email: str(body.email) && body.email.trim(), username: str(body.username) && body.username.trim(), password: str(body.password) || undefined };
      Object.keys(f).forEach((k) => { if (f[k] === undefined || f[k] === '' || f[k] === false) delete f[k]; });
      if (f.email !== undefined && f.email.toLowerCase() === sess.email.toLowerCase() && f.email === sess.email) delete f.email;
      if (f.username !== undefined && f.username === sess.username) delete f.username;
      if (!Object.keys(f).length) return fail(res, 400, 'Tidak ada perubahan untuk disimpan.');
      const bad = checkFields(f);
      if (bad) return fail(res, 400, bad);
      if (A.tooMany(req, 20, 60000)) return fail(res, 429, 'Terlalu banyak percobaan. Tunggu sebentar.');
      if (f.password !== undefined) {
        const cur = await query('SELECT pass_hash FROM users WHERE id = $1::bigint', [sess.id]);
        if (!(await A.verifyPassword(String(body.currentPassword || ''), cur[0] && cur[0].pass_hash))) return fail(res, 403, 'Password saat ini salah.');
      }
      const dup = await dupError(f.username, f.email, sess.id, sess.isAdmin);
      if (dup) return fail(res, 409, dup);
      const row = await applyUpdate(sess.id, f);
      if (f.password !== undefined) await A.destroyUserSessions(sess.id, sess.token); // perangkat lain harus login ulang
      return res.status(200).json({ user: userOut(row) });
    }

    if (action === 'admin_update') { // admin mengubah akun siapa pun
      if (!sess.isAdmin) return fail(res, 403, 'Hanya admin yang boleh mengubah akun lain.');
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Akun tidak valid.');
      const f = { email: str(body.email) && body.email.trim(), username: str(body.username) && body.username.trim(), password: str(body.password) || undefined };
      Object.keys(f).forEach((k) => { if (f[k] === undefined || f[k] === '' || f[k] === false) delete f[k]; });
      if (!Object.keys(f).length) return fail(res, 400, 'Tidak ada perubahan untuk disimpan.');
      const bad = checkFields(f);
      if (bad) return fail(res, 400, bad);
      const target = await query('SELECT id, is_admin FROM users WHERE id = $1::bigint', [id]);
      if (!target.length) return fail(res, 404, 'Akun tidak ditemukan.');
      const dup = await dupError(f.username, f.email, id, A.isTrue(target[0].is_admin));
      if (dup) return fail(res, 409, dup);
      const row = await applyUpdate(id, f);
      if (f.password !== undefined) await A.destroyUserSessions(id, id === sess.id ? sess.token : null);
      return res.status(200).json({ user: { id, ...userOut(row) } });
    }

    if (action === 'delete') {
      if (sess.isAdmin) return fail(res, 403, 'Akun admin tidak bisa dihapus.');
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
