// Koneksi ke Neon (Postgres) dan pembuatan tabel otomatis.
// File berawalan "_" tidak dijadikan endpoint oleh Vercel; ini hanya modul pendukung.
const { neon } = require('@neondatabase/serverless');

let sql = null;
let ready = null;

function client() {
  if (!sql) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) {
      const e = new Error('Database belum dikonfigurasi (DATABASE_URL belum diisi di Vercel).');
      e.config = true;
      throw e;
    }
    sql = neon(url);
  }
  return sql;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id BIGSERIAL PRIMARY KEY,
     username TEXT NOT NULL,
     username_lc TEXT NOT NULL UNIQUE,
     email TEXT NOT NULL,
     email_lc TEXT NOT NULL UNIQUE,
     pass_hash TEXT NOT NULL,
     created_at BIGINT NOT NULL
   )`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at BIGINT NOT NULL,
     expires_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)`,
  `CREATE TABLE IF NOT EXISTS tx (
     user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     id TEXT NOT NULL,
     date TEXT NOT NULL,
     type TEXT NOT NULL,
     amount BIGINT NOT NULL,
     descr TEXT NOT NULL DEFAULT '',
     created_at BIGINT NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS tx_user_date_idx ON tx (user_id, date)`,
  `CREATE TABLE IF NOT EXISTS advice (
     user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     date TEXT NOT NULL,
     text TEXT NOT NULL,
     created_at BIGINT NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, date)
   )`,
];

// Akun admin bawaan (username "admin", password "admin") dibuat sekali, hanya bila belum ada akun admin.
// Setelah dibuat, username/password-nya boleh diganti lewat menu Kelola dan tidak akan di-reset lagi.
async function seedAdmin(c) {
  const have = await c.query('SELECT 1 FROM users WHERE is_admin LIMIT 1', []);
  if (have.length) return;
  // bila ada pengguna biasa yang sudah memakai username "admin", namanya diganti agar tidak bentrok
  await c.query(`UPDATE users SET username = 'user_' || id, username_lc = 'user_' || id WHERE username_lc = 'admin' AND NOT is_admin`, []);
  const hash = await require('./_auth').hashPassword('admin');
  await c.query(
    `INSERT INTO users (username, username_lc, email, email_lc, pass_hash, created_at, is_admin)
     VALUES ('admin', 'admin', 'admin@cal.local', 'admin@cal.local', $1, $2::bigint, true) ON CONFLICT DO NOTHING`,
    [hash, Date.now()]);
}

function init() {
  if (!ready) {
    ready = (async () => {
      const c = client();
      for (const stmt of SCHEMA) await c.query(stmt, []);
      await seedAdmin(c);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// semua kueri lewat sini; hasilnya selalu array baris (kolom BIGINT bisa berupa string, ubah dengan Number())
async function query(text, params = []) {
  await init();
  return client().query(text, params);
}

module.exports = { query };
