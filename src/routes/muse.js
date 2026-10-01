// Muse service pipe: lets the owner's Muse assistant drop messages into any
// user's in-app notification inbox (and optionally email them) THROUGH THE
// PRODUCT ITSELF. This is the machine-to-machine channel: the owner's Muse
// writes briefs here, and collaborators' assistants read them from the
// product when they work.
//
// Auth: Authorization: Bearer <token>, compared timing-safe against the
// MUSE_SERVICE_TOKEN env var. The endpoint 404s when the env var is unset,
// so it is inert by default. The token is read live from process.env (not the
// config snapshot) so tests can toggle it. Never log the token.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { notifyUser } = require('../lib/notify');
const { sendMail } = require('../lib/mail');
const { messageLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Live env read (see header): keeps the pipe test-toggleable.
function serviceToken() {
  return process.env.MUSE_SERVICE_TOKEN || '';
}

function authorized(req) {
  const expected = serviceToken();
  if (!expected) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = Buffer.from(m[1], 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// POST /api/muse/notify
// body: { to, kind, title, body, link, sendEmail }
//   to: user id, email address, or "admins" (every admin/head_admin —
//       broadcasts only, owner approves each use)
//   kind: notification kind, defaults to "muse"
//   sendEmail: also deliver via the site's transactional mailer
router.post('/notify', messageLimiter, async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const to = String(req.body?.to || '').trim().slice(0, 200);
  const kind = String(req.body?.kind || 'muse').slice(0, 40);
  const title = String(req.body?.title || '').trim().slice(0, 160);
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  const link = String(req.body?.link || '').trim().slice(0, 300);
  const sendEmail = req.body?.sendEmail === true;
  if (!to || !title) return res.status(400).json({ ok: false, error: 'to and title required' });

  let users = [];
  try {
    if (to === 'admins') {
      users = await db.all("SELECT id, email FROM users WHERE role IN ('admin','head_admin')");
    } else {
      const u = await db.get(
        'SELECT id, email FROM users WHERE id = ? OR lower(email) = lower(?)', [to, to]
      );
      if (u) users = [u];
    }
  } catch (e) {
    console.error('[muse/notify] recipient lookup failed:', e.message);
    return res.status(500).json({ ok: false, error: 'lookup failed' });
  }
  if (!users.length) return res.status(404).json({ ok: false, error: 'no such user' });

  const notified = [];
  for (const u of users) {
    await notifyUser(u.id, { kind, title, body, link });
    if (sendEmail && u.email) {
      try {
        await sendMail({
          to: u.email,
          subject: title,
          text: body + (link ? `\n\nSee it here: ${config.baseUrl}${link}` : ''),
        });
      } catch (e) {
        console.error('[muse/notify] email failed:', e.message);
      }
    }
    notified.push(u.id);
  }
  return res.json({ ok: true, notified });
});

module.exports = router;
