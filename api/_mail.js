// Pengiriman email lewat Gmail SMTP (nodemailer). File berawalan "_" tidak dijadikan endpoint oleh Vercel.
// Environment variable di Vercel:
//   GMAIL_USER          alamat Gmail pengirim, mis. calapp@gmail.com
//   GMAIL_APP_PASSWORD  App Password 16 huruf dari akun Google itu (bukan password login Gmail)
//   MAIL_FROM_NAME      (opsional) nama pengirim yang tampil, bawaan "Cal"
const nodemailer = require('nodemailer');

let transport = null;

function configured() {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function getTransport() {
  if (!configured()) {
    const e = new Error('Pengiriman email belum dikonfigurasi (GMAIL_USER dan GMAIL_APP_PASSWORD belum diisi di Vercel).');
    e.config = true;
    throw e;
  }
  if (!transport) {
    transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: String(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, '') },
    });
  }
  return transport;
}

async function sendResetCode(to, code, minutes) {
  const name = (process.env.MAIL_FROM_NAME || 'Cal').replace(/["\r\n]/g, '');
  const text =
    `Kode untuk mengatur ulang password akun Cal kamu:\n\n${code}\n\n` +
    `Kode berlaku ${minutes} menit dan hanya bisa dipakai sekali. ` +
    `Jika kamu tidak merasa memintanya, abaikan email ini; password kamu tetap aman.`;
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px;background:#111;color:#f1ede6;border-radius:14px">` +
    `<div style="font-size:20px;font-weight:700;color:#ff7a1a;margin-bottom:14px">Cal</div>` +
    `<p style="margin:0 0 14px;color:#cfc9bf">Kode untuk mengatur ulang password akun Cal kamu:</p>` +
    `<div style="font-size:34px;letter-spacing:10px;font-weight:700;color:#fff;background:#1c1c1c;border:1px solid #333;border-radius:12px;padding:14px 0;text-align:center">${code}</div>` +
    `<p style="margin:14px 0 0;color:#9a948a;font-size:13px;line-height:1.5">Kode berlaku ${minutes} menit dan hanya bisa dipakai sekali. ` +
    `Jika kamu tidak merasa memintanya, abaikan email ini; password kamu tetap aman.</p></div>`;
  await getTransport().sendMail({
    from: { name, address: process.env.GMAIL_USER },
    to,
    subject: `Kode reset password Cal: ${code}`,
    text,
    html,
  });
}

module.exports = { sendResetCode, configured };
