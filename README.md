# Catatan Keuangan (PWA)

Pencatat pengeluaran dan penghasilan harian. Data tersimpan di HP masing-masing (IndexedDB). Fitur **Beri Saran** memakai Gemini lewat satu serverless function di Vercel.

## Struktur

```
index.html  style.css  app.js     -> aplikasi (frontend)
sw.js  manifest.json  icons/      -> PWA (bisa dipasang & jalan offline)
api/saran.js                      -> endpoint Gemini (API key aman di server)
vercel.json  package.json
```

## Deploy

1. Unggah semua file ini ke repository GitHub (folder `api/` dan `icons/` harus ikut).
2. Di Vercel: **Add New → Project** → pilih repository → **Deploy** (Framework Preset: *Other*, tanpa build command).
3. Di **Settings → Environment Variables**, tambahkan:

   | Nama | Isi |
   |---|---|
   | `GEMINI_API_KEY` | API key dari Google AI Studio |
   | `ACCESS_CODE` | kode rahasia bebas (bagikan ke teman saja) |
   | `GEMINI_MODEL` | *(opsional)* default `gemini-2.5-flash` |

4. **Redeploy** agar variabel terbaca.
5. Buka link Vercel di HP → menu browser → **Tambahkan ke layar utama**.
6. Di aplikasi: ikon gerigi → isi **Kode akses** → Simpan.

## Cara kerja singkat

- Catatan dibuat hanya untuk **hari ini**; catatan lama bisa diubah (ketuk) atau dihapus (✕).
- **Beri Saran** aktif hanya untuk hari yang sudah lewat dan punya catatan. Hasilnya disimpan di HP, jadi tidak memanggil Gemini lagi untuk hari yang sama. Mengubah atau menghapus catatan hari itu menghapus saran lamanya.
- Kalender selalu Senin–Minggu dan otomatis pindah ke minggu baru setelah lewat tengah malam hari Minggu. Panah ‹ › untuk melihat minggu lalu.

## Catatan penting

- **Backup**: data hilang bila data situs dihapus atau ganti HP. Pakai Pengaturan → Ekspor JSON secara berkala.
- **Privasi**: saat Beri Saran, nominal dan deskripsi catatan hari itu dikirim ke Gemini lewat server. Beri tahu teman, dan sarankan tidak menulis data sensitif di deskripsi. Pada paket gratis, Google dapat memakai data untuk pengembangan produk.
- **Pembatas**: server membatasi 6 permintaan/menit per IP (best-effort). Kuota Gemini gratis dipakai bersama semua pengguna kode akses yang sama.
- Ganti `ACCESS_CODE` di Vercel (lalu redeploy) bila kode bocor.
