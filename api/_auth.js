// Pembantu akun: hash password, sesi (cookie), dan pembatas percobaan.
const crypto = require('crypto');
const { query } = require('./_db');

const COOKIE = 'cal_sess';
const SESSION_MS = 400 * 24 * 3600 * 1000; // batas maksimum cookie di browser modern
const RENEW_BELOW_MS = 300 * 24 * 3600 * 1000;

/* ---------- password (scrypt bawaan Node, tanpa dependensi) ---------- */
function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(key)));
  });
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
const DUMMY = crypto.randomBytes(16);
async function verifyPassword(password, stored) {
  // bila akun tidak ada, tetap hitung hash agar waktu responsnya sama
  if (!stored) { await scrypt(password, DUMMY); return false; }
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'));
  const want = Buffer.from(keyHex, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}

/* ---------- sesi ---------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function cookieString(req, value, maxAgeSec) {
  const https = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${https ? '; Secure' : ''}`;
}
function setSessionCookie(req, res, token) { res.setHeader('Set-Cookie', cookieString(req, token, Math.floor(SESSION_MS / 1000))); }
function clearSessionCookie(req, res) { res.setHeader('Set-Cookie', cookieString(req, '', 0)); }

async function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2::bigint, $3::bigint, $4::bigint)',
    [sha(token), userId, now, now + SESSION_MS]);
  setSessionCookie(req, res, token);
}

// kembalikan { id, username, token, expiresAt } atau null
async function getSession(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token || token.length > 200) return null;
  const rows = await query(
    `SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > $2::bigint`, [sha(token), Date.now()]);
  if (!rows.length) return null;
  return { id: Number(rows[0].id), username: rows[0].username, token, expiresAt: Number(rows[0].expires_at) };
}

async function destroySession(token) {
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
}

// perpanjang sesi yang sudah lama agar pengguna tetap masuk sampai logout
async function renewIfOld(req, res, sess) {
  if (sess.expiresAt - Date.now() > RENEW_BELOW_MS) return;
  await query('UPDATE sessions SET expires_at = $2::bigint WHERE token_hash = $1', [sha(sess.token), Date.now() + SESSION_MS]);
  setSessionCookie(req, res, sess.token);
}

/* ---------- pembatas percobaan per IP (best-effort, memori instance) ---------- */
const hits = new Map();
function tooMany(req, max, windowMs) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  const limited = arr.length >= max;
  if (!limited) arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 500) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  return limited;
}

module.exports = {
  hashPassword, verifyPassword, getSession, createSession, destroySession,
  renewIfOld, clearSessionCookie, tooMany,
};
