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
//   to: user id, email address, "team" (the five population-team members —
//       the Muse-to-Muse channel; Adolfo and any other admins excluded), or
//       "admins" (every admin/head_admin — broadcasts only, owner approves each use)
//   kind: notification kind, defaults to "muse"
//   sendEmail: also deliver via the site's transactional mailer
//
// Population team: the five admins whose Muse assistants are on the special
// Muse-to-Muse channel. Adolfo is deliberately excluded from this channel.
const POPULATION_TEAM_EMAILS = [
  'caylicradic@gmail.com',             // Cayli
  'christopherstclairjones@yahoo.com', // Chris
  'alieshak85@gmail.com',              // Lesha
  'darkguitar6769@gmail.com',          // Aiden
  'c0rruptc0rtexx03@gmail.com',        // Carina
];
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
    if (to === 'team') {
      const placeholders = POPULATION_TEAM_EMAILS.map(() => '?').join(',');
      users = await db.all(
        `SELECT id, email FROM users WHERE lower(email) IN (${placeholders})`,
        POPULATION_TEAM_EMAILS
      );
    } else if (to === 'admins') {
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

// GET /api/muse/ios-sales?since=<order id>
// Returns paid ios_app orders newer than `since` (newest first, max 50).
// Powers the owner's "notify me on every iOS app sale" watcher.
// Same service-token auth as /notify; 404s when MUSE_SERVICE_TOKEN unset.
router.get('/ios-sales', async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const since = parseInt(req.query.since, 10) || 0;
  let rows = [];
  try {
    rows = await db.all(
      `SELECT o.id, o.amount_cents, o.fee_cents, o.paid_at, u.email AS buyer_email
       FROM orders o LEFT JOIN users u ON u.id = o.buyer_id
       WHERE o.order_type = 'ios_app' AND o.status = 'paid' AND o.id > ?
       ORDER BY o.id DESC LIMIT 50`,
      [since]
    );
  } catch (e) {
    console.error('[muse/ios-sales] query failed:', e.message);
    return res.status(500).json({ ok: false, error: 'query failed' });
  }
  return res.json({ ok: true, sales: rows });
});

// GET /api/muse/custom-orders-needing-drafts
// Returns paid custom orders with custom_status='needs_drafts' (oldest due first, max 50).
// Powers the owner's custom-draft worker so it can see PRODUCTION state over HTTPS
// instead of only the local dev SQLite DB.
// Same service-token auth as /notify; 404s when MUSE_SERVICE_TOKEN unset.
router.get('/custom-orders-needing-drafts', async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  let rows = [];
  try {
    rows = await db.all(
      `SELECT o.id, o.custom_brief, o.delivery_due, o.rush_fee_cents, o.custom_status,
              u.email AS buyer_email, u.display_name AS buyer_name
       FROM orders o JOIN users u ON u.id = o.buyer_id
       WHERE o.order_type = 'custom' AND o.status = 'paid' AND o.custom_status = 'needs_drafts'
       ORDER BY (o.rush_fee_cents > 0) DESC, o.delivery_due ASC LIMIT 50`
    );
  } catch (e) {
    console.error('[muse/custom-orders-needing-drafts] query failed:', e.message);
    return res.status(500).json({ ok: false, error: 'query failed' });
  }
  return res.json({ ok: true, orders: rows });
});

// POST /api/muse/fix-design-title
// One-off data repair: correct a design's title (e.g. the ingest.js
// double-prefix bug). body: { id, title }.
// Same service-token auth as /notify; 404s when MUSE_SERVICE_TOKEN unset.
router.post('/fix-design-title', express.json(), async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const id = String(req.body.id || '').trim();
  const title = String(req.body.title || '').trim().slice(0, 120);
  if (!id || !title) return res.status(422).json({ ok: false, error: 'id and title required' });
  try {
    await db.update('designs', id, { title });
  } catch (e) {
    console.error('[muse/fix-design-title] update failed:', e.message);
    return res.status(500).json({ ok: false, error: 'update failed' });
  }
  return res.json({ ok: true, id, title });
});

module.exports = router;
