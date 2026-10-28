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

function init() {
  if (!ready) {
    ready = (async () => {
      const c = client();
      for (const stmt of SCHEMA) await c.query(stmt, []);
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
