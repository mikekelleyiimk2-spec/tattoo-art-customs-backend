// Transactional email (password resets, order confirmations).
// If SMTP is not configured, messages are logged to the console (dev mode).
const nodemailer = require('nodemailer');
const config = require('../config');

let transporter = null;
function getTransporter() {
  if (!config.smtpConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) {
    console.log(`[mail:dev] To: ${to}\nSubject: ${subject}\n${text}\n`);
    return { dev: true };
  }
  return t.sendMail({ from: config.smtp.from, to, subject, text, html });
}

module.exports = { sendMail };
