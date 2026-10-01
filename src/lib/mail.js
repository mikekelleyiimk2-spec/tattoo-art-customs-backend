// Transactional email (password resets, order confirmations).
// If SMTP is not configured, messages are logged to the console (dev mode).
// SMTP sends retry with exponential backoff (3 attempts total). Every
// attempt is logged with to/subject/attempt count, and a final failure is
// logged with the last error and re-thrown so callers can handle it —
// failures are never silently swallowed.
const nodemailer = require('nodemailer');
const config = require('../config');

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

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

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

async function sendMail({ to, subject, text, html }) {
  // An injected test transporter wins over the configured one.
  const t = transporter || getTransporter();
  if (!t) {
    console.log(`[mail:dev] To: ${to}\nSubject: ${subject}\n${text}\n`);
    return { dev: true };
  }
  let attempt = 0;
  let lastErr = null;
  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    try {
      const info = await t.sendMail({ from: config.smtp.from, to, subject, text, html });
      if (attempt > 1) console.log(`[mail] delivered after ${attempt} attempts`, { to, subject });
      return info;
    } catch (e) {
      lastErr = e;
      console.error(`[mail] attempt ${attempt}/${MAX_ATTEMPTS} failed`, {
        to, subject, attempt, error: e && e.message,
      });
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }
  console.error('[mail] FAILED after all attempts', {
    to, subject, attempts: MAX_ATTEMPTS, error: lastErr && lastErr.message,
  });
  throw lastErr;
}

// Test seam: inject (or clear, with null) a fake transporter for unit tests.
function __setTransporter(t) { transporter = t || null; }

module.exports = { sendMail, __setTransporter };
