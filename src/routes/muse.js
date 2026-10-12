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

// GET /api/muse/all-sales?since=<paid_at ms>
// Returns ALL paid orders (any order_type) with paid_at newer than `since`
// (unix ms), newest first, max 100. Also includes refunded orders so the
// money watcher can catch refunds/chargebacks.
// Powers the owner's unified money watcher ("watch all incoming and outgoing").
// Uses paid_at (not id) because order ids are random hex, not sequential.
// Same service-token auth as /notify; 404s when MUSE_SERVICE_TOKEN unset.
router.get('/all-sales', async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const since = parseInt(req.query.since, 10) || 0;
  let rows = [];
  try {
    rows = await db.all(
      `SELECT o.id, o.order_type, o.amount_cents, o.amount_paid_cents, o.fee_cents,
              o.paid_at, o.status, o.payment_method, u.email AS buyer_email
       FROM orders o LEFT JOIN users u ON u.id = o.buyer_id
       WHERE o.paid_at IS NOT NULL AND o.paid_at > ?
         AND o.status IN ('paid', 'refunded', 'chargedback')
       ORDER BY o.paid_at DESC LIMIT 100`,
      [since]
    );
  } catch (e) {
    console.error('[muse/all-sales] query failed:', e.message);
    return res.status(500).json({ ok: false, error: 'query failed' });
  }
  return res.json({ ok: true, sales: rows });
});

// GET /api/muse/money-stats
// Returns production money totals for the owner's daily sweep: gross revenue,
// order counts, commissions owed, and signups. Read-only.
// Powers the daily money sweep so it reads PRODUCTION state over HTTPS
// instead of the empty local dev SQLite DB.
// Same service-token auth as /notify; 404s when MUSE_SERVICE_TOKEN unset.
router.get('/money-stats', async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const q = async (sql, col) => {
    try { const r = await db.get(sql); return r ? Number(r[col] ?? 0) : 0; }
    catch (e) { return 0; }
  };
  try {
    const stats = {
      users: await q('SELECT COUNT(*) AS n FROM users', 'n'),
      designs: await q('SELECT COUNT(*) AS n FROM designs', 'n'),
      orders: await q('SELECT COUNT(*) AS n FROM orders', 'n'),
      paidOrders: await q("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'", 'n'),
      grossCents: await q("SELECT COALESCE(SUM(amount_paid_cents),0) AS t FROM orders WHERE status = 'paid'", 't'),
      payableCents: await q("SELECT COALESCE(SUM(amount_cents),0) AS t FROM commission_ledger WHERE status = 'payable'", 't'),
      paidOutCents: await q("SELECT COALESCE(SUM(amount_cents),0) AS t FROM commission_ledger WHERE status = 'paid'", 't'),
      raffleEntries: await q('SELECT COUNT(*) AS n FROM raffle_entries', 'n'),
    };
    return res.json({ ok: true, stats });
  } catch (e) {
    console.error('[muse/money-stats] query failed:', e.message);
    return res.status(500).json({ ok: false, error: 'query failed' });
  }
});

// POST /api/muse/owner-sweep
// Runs the daily owner sweep ON PRODUCTION: finalizes newly-cleared sales
// (paid 24h+, no holds) by marking the site's ledger rows cleared, and returns
// the summary. Powers the owner-daily-sweep cron over HTTPS instead of the
// empty local dev SQLite DB. Idempotent — only touches uncleared rows.
// Same service-token auth as /notify; 404s when MUSE_SERVICE_TOKEN unset.
router.post('/owner-sweep', async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const { runOwnerSweep } = require('../lib/ownerSweep');
    const summary = await runOwnerSweep({ now: Date.now(), sendEmail: false });
    return res.json({ ok: true, summary });
  } catch (e) {
    console.error('[muse/owner-sweep] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'sweep failed' });
  }
});

// GET /api/muse/raffle-entrants
// Read-only feed for the owner's raffle-entrant watcher: opening-raffle
// entrants with the engagement signals the site actually stores (entry date,
// signup date, referred_by, email_verified) plus purchase state, so the
// watcher can rank warm signups without guessing. Returns { ok, total_entries,
// entrants: [{ user_id, email, display_name, entered_at, signup_at,
// email_verified, referred_by, order_count, last_order_at }] }.
// Read-only — writes nothing. Same service-token auth as /owner-sweep; 404s
// when MUSE_SERVICE_TOKEN unset.
router.get('/raffle-entrants', async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 2000);
    const total = await db.get('SELECT COUNT(*) AS n FROM raffle_entries');
    const entrants = await db.all(
      `SELECT r.user_id, r.entered_at, r.drawn_at,
              u.email, u.display_name, u.created_at AS signup_at,
              u.email_verified, u.referred_by,
              (SELECT COUNT(*) FROM orders o WHERE o.buyer_id = u.id AND o.status != 'canceled') AS order_count,
              (SELECT MAX(o2.created_at) FROM orders o2 WHERE o2.buyer_id = u.id AND o2.status != 'canceled') AS last_order_at
         FROM raffle_entries r
         JOIN users u ON u.id = r.user_id
        ORDER BY r.entered_at DESC
        LIMIT ?`,
      [limit]
    );
    return res.json({ ok: true, total_entries: total ? total.n : 0, entrants });
  } catch (e) {
    console.error('[muse/raffle-entrants] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'entrant feed failed' });
  }
});

// POST /api/muse/grant-admin
// body: { email, role, population_admin }
//   email: the user's login email (required)
//   role: 'admin' or 'head_admin' (default 'admin')
//   population_admin: true/false — sets the population_admin flag (default false)
// Grants an admin role + optionally the population-admin flag to an existing
// user. Same service-token auth as /owner-sweep; 404s when MUSE_SERVICE_TOKEN unset.
router.post('/grant-admin', express.json(), async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = String(req.body?.role || 'admin').trim();
    const popAdmin = !!req.body?.population_admin;
    if (!email || !['admin', 'head_admin'].includes(role)) {
      return res.status(400).json({ ok: false, error: 'email and valid role required' });
    }
    const user = await db.get('SELECT id, email, role, population_admin FROM users WHERE lower(email) = ?', [email]);
    if (!user) return res.status(404).json({ ok: false, error: 'user not found' });
    await db.update('users', user.id, { role, population_admin: popAdmin ? 1 : 0 });
    const updated = await db.get('SELECT id, email, role, population_admin FROM users WHERE id = ?', [user.id]);
    return res.json({ ok: true, user: updated });
  } catch (e) {
    console.error('[muse/grant-admin] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'grant failed' });
  }
});

// body: { email }
// Revokes admin access: sets role to 'customer' and clears population_admin.
// Same service-token auth as /grant-admin; 404s when MUSE_SERVICE_TOKEN unset.
router.post('/revoke-admin', express.json(), async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ ok: false, error: 'email required' });
    }
    const user = await db.get('SELECT id, email, role, population_admin FROM users WHERE lower(email) = ?', [email]);
    if (!user) return res.status(404).json({ ok: false, error: 'user not found' });
    if (user.role === 'head_admin') {
      return res.status(400).json({ ok: false, error: 'cannot revoke head_admin via this endpoint' });
    }
    await db.update('users', user.id, { role: 'customer', population_admin: 0 });
    const updated = await db.get('SELECT id, email, role, population_admin FROM users WHERE id = ?', [user.id]);
    return res.json({ ok: true, user: updated });
  } catch (e) {
    console.error('[muse/revoke-admin] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'revoke failed' });
  }
});

// POST /api/muse/rewatermark-missing — regenerate watermarked linework for
// pending designs stuck without it (service-token auth). Idempotent: skips
// designs that already have linework_wm_path unless {force:true}.
// Fixes the admin approval page showing broken thumbnails for un-watermarked
// pending designs (2026-10-12: Chris Jones report).
router.post('/rewatermark-missing', express.json(), async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const { applyWatermarkedLinework } = require('../lib/watermark');
    const { resolveStoredPath } = require('../lib/storage');
    const force = req.body?.force === true;
    const rows = await db.all(
      "SELECT id, title, linework_path, linework_wm_path FROM designs WHERE status = 'pending' AND (linework_wm_path IS NULL OR linework_wm_path = '')"
    );
    const results = [];
    for (const d of rows) {
      if (d.linework_wm_path && !force) { results.push({ id: d.id, title: d.title, result: 'skipped' }); continue; }
      const lwAbs = resolveStoredPath(d.linework_path);
      if (!lwAbs) { results.push({ id: d.id, title: d.title, result: 'no-file' }); continue; }
      try {
        const wmRel = await applyWatermarkedLinework({ designId: d.id, lineworkAbs: lwAbs, choice: 'site' });
        await db.update('designs', d.id, { linework_wm_path: wmRel });
        results.push({ id: d.id, title: d.title, result: 'ok', wm: wmRel });
      } catch (e) {
        results.push({ id: d.id, title: d.title, result: 'error', error: e.message });
      }
    }
    return res.json({ ok: true, count: rows.length, results });
  } catch (e) {
    console.error('[muse/rewatermark-missing] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'rewatermark failed' });
  }
});

router.post('/upload-ipa', (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  ipaUpload(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: 'no ipa file' });
    try {
      // Verify zip magic (PK\x03\x04) — extension alone is not enough.
      const fd = fs.openSync(req.file.path, 'r');
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      if (head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 0x03 || head[3] !== 0x04) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ ok: false, error: 'not a valid ipa (zip) file' });
      }
      const destDir = path.join(config.uploadDir, 'ios-app');
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, 'tattoo-art-customs.ipa');
      // copy+unlink: staged file may sit on a different filesystem (tmpfs)
      // than the upload dir — renameSync throws EXDEV across devices.
      fs.copyFileSync(req.file.path, dest);
      fs.unlinkSync(req.file.path);
      return res.json({ ok: true, size: fs.statSync(dest).size, path: 'uploads/ios-app/tattoo-art-customs.ipa' });
    } catch (e) {
      console.error('[muse/upload-ipa] failed:', e.message);
      return res.status(500).json({ ok: false, error: 'store failed' });
    }
  });
});

// POST /api/muse/upload-sideload
// Uploads a free/paid sideload build (IPA or APK) to production storage
// (uploads/sideload/). Lets the owner's automation publish new sideload builds
// without shell access. Body: `app` (allowlisted key) + single `file` field.
// Accepts .ipa (iOS) or .apk (Android); zip magic verified; max 300MB.
// Same service-token auth as /notify; 404s when MUSE_SERVICE_TOKEN unset.
// (Upload middleware defined next to ipaUpload below, after the requires.)
router.post('/upload-sideload', (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  sideloadUpload(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: 'no file' });
    const slot = SIDELOAD_UPLOAD_APPS[req.body.app];
    if (!slot) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ ok: false, error: 'unknown app key' });
    }
    if (!req.file.originalname.toLowerCase().endsWith(slot.ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ ok: false, error: `expected a ${slot.ext} file for ${req.body.app}` });
    }
    try {
      // Verify zip magic (PK\x03\x04) — both IPA and APK are zips.
      const fd = fs.openSync(req.file.path, 'r');
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      if (head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 0x03 || head[3] !== 0x04) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ ok: false, error: 'not a valid ipa/apk (zip) file' });
      }
      const dest = path.join(config.uploadDir, slot.dest);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // One-time cleanup (2026-10-08): the pre-fix handler wrote uploads to
      // <uploadDir>/sideload/<basename> (missing the uploads/ segment). Remove
      // that orphan if present so the 1GB Render disk doesn't fill up.
      try {
        const orphan = path.join(config.uploadDir, 'sideload', path.basename(slot.dest));
        if (orphan !== dest && fs.existsSync(orphan)) fs.unlinkSync(orphan);
      } catch { /* best effort */ }
      // copy+unlink: staged file may sit on a different filesystem (tmpfs)
      // than the upload dir — renameSync throws EXDEV across devices.
      fs.copyFileSync(req.file.path, dest);
      fs.unlinkSync(req.file.path);
      return res.json({ ok: true, size: fs.statSync(dest).size, path: slot.dest });
    } catch (e) {
      console.error('[muse/upload-sideload] failed:', e.message);
      return res.status(500).json({ ok: false, error: 'store failed' });
    }
  });
});

// POST /api/muse/pro-apk-download-link
// Mints a direct-install download link for the TAC Android Pro sideload APK
// (uploaded via /upload-sideload, app=tac-android-pro) so the owner can
// install the current build on his own phone without buying his own app.
// Reuses the paid-order download machinery: find-or-creates a $0 comp order
// (payment_method 'comp', status 'paid') owned by the head_admin account and
// issues a standard 24h bearer download token for it — the APK itself is
// served by GET /orders/download/:token like any paid Pro order.
// Same service-token auth as the other /api/muse routes; 404 when unset.
router.post('/pro-apk-download-link', express.json(), async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const { resolveStoredPath } = require('../lib/storage');
    const apkRel = process.env.TAC_ANDROID_PRO_APK_PATH || 'uploads/sideload/tac-android-pro.apk';
    const apkAbs = resolveStoredPath(apkRel);
    if (!apkAbs) return res.status(404).json({ ok: false, error: 'pro apk not uploaded' });
    let owner = await db.get(
      "SELECT id FROM users WHERE role = 'head_admin' ORDER BY created_at ASC LIMIT 1"
    );
    if (!owner && process.env.ADMIN_EMAIL) {
      owner = await db.get('SELECT id FROM users WHERE email = ?', [process.env.ADMIN_EMAIL]);
    }
    if (!owner) return res.status(500).json({ ok: false, error: 'owner account not found' });
    let order = await db.get(
      "SELECT * FROM orders WHERE buyer_id = ? AND order_type = 'tac_android_pro' AND payment_method = 'comp' AND status = 'paid' ORDER BY created_at DESC LIMIT 1",
      [owner.id]
    );
    if (!order) {
      const orderId = await db.insert('orders', {
        buyer_id: owner.id, order_type: 'tac_android_pro',
        amount_cents: 0, fee_cents: 0, status: 'paid', payment_method: 'comp',
        created_at: db.now(), paid_at: db.now(),
      });
      order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    }
    const { issueDownloadToken } = require('../lib/fulfillment');
    const dl = await issueDownloadToken(order.id);
    return res.json({
      ok: true,
      url: `${config.baseUrl}/orders/download/${dl.token}`,
      expires_at: dl.expires_at,
      size: fs.statSync(apkAbs).size,
    });
  } catch (e) {
    console.error('[muse/pro-apk-download-link] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'link failed' });
  }
});

// GET /api/muse/disk
// Read-only disk probe (service-token auth): free/total bytes for the
// upload dir's filesystem and the OS tmpdir, plus the sideload + ios-app
// file inventory. Exists because the 1GB Render disk is shared by every
// upload pipe and an ENOSPC otherwise surfaces only as a bare
// 'store failed' on upload.
router.get('/disk', async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const fsInfo = (dir) => {
      try {
        const s = fs.statfsSync(dir);
        return { dir, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
      } catch (e) { return { dir, error: e.message }; }
    };
    const listDir = (rel) => {
      const abs = path.join(config.uploadDir, rel);
      try {
        return fs.readdirSync(abs).map((name) => {
          const st = fs.statSync(path.join(abs, name));
          return { name, size: st.size, mtime: st.mtimeMs };
        });
      } catch { return []; }
    };
    // Bounded recursive size of one directory (entry-capped walk).
    const dirSize = (abs, cap = 50000) => {
      let total = 0; let count = 0;
      const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (count > cap) return;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else { try { total += fs.statSync(p).size; count++; } catch { /* vanished */ } }
        }
      };
      walk(abs);
      return { bytes: total, files: count };
    };
    const topLevel = {};
    try {
      for (const e of fs.readdirSync(config.uploadDir, { withFileTypes: true })) {
        const p = path.join(config.uploadDir, e.name);
        topLevel[e.name] = e.isDirectory() ? dirSize(p) : { bytes: fs.statSync(p).size, files: 1 };
      }
    } catch { /* uploadDir unreadable — filesystems block already reports */ }
    return res.json({
      ok: true,
      filesystems: [fsInfo(config.uploadDir), fsInfo(os.tmpdir())],
      uploadDir: config.uploadDir,
      topLevel,
      sideload: listDir('uploads/sideload'),
      legacySideload: listDir('sideload'),
      iosApp: listDir('ios-app'),
    });
  } catch (e) {
    console.error('[muse/disk] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'disk probe failed' });
  }
});

// ── Cosmos handoff ZIP receiver ─────────────────────────────────────
// POST /api/muse/handoff-zips — receive ONE handoff ZIP (multipart form
// field "file", .zip, max 512 MB), streamed to disk, never memory. The
// ZIP lands in the ephemeral tmp staging area (os.tmpdir) — NOT the 1 GB
// persistent disk, which cannot hold even one ~390 MB handoff ZIP.
// Optional form fields: "name" (final filename; defaults to the uploaded
// filename) and "sha256" (the sender's hash — a mismatch deletes the
// staged file and returns 422, so a corrupted transfer never imports).
// Auth: Authorization: Bearer <MUSE_SERVICE_TOKEN>. Support code:
// src/lib/handoffImport.js (capacity design documented there).
router.post('/handoff-zips', (req, res) => {
  const token = serviceToken();
  if (!token) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  // A ~390 MB transfer from a phone can run for minutes; Node's default
  // request timeout would kill it mid-upload. This route only.
  req.setTimeout(0);
  handoffUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: 'no file uploaded' });
    const handoff = require('../lib/handoffImport');
    const stagedAbs = req.file.path;
    const discard = () => { try { fs.unlinkSync(stagedAbs); } catch { /* already gone */ } };
    try {
      // Same zip-magic check as upload-ipa: PK\x03\x04 local file header.
      const head = Buffer.alloc(4);
      const fd = fs.openSync(stagedAbs, 'r');
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      if (!(head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)) {
        discard();
        return res.status(400).json({ ok: false, error: 'uploaded file is not a ZIP (missing PK header)' });
      }
      const name = handoff.sanitizeZipName(req.body.name || req.file.originalname);
      if (!name) {
        discard();
        return res.status(400).json({ ok: false, error: 'bad zip name (letters/digits/dot/dash/underscore only, must end .zip)' });
      }
      // Collision → suffix (-2, -3, …) instead of overwriting an
      // un-imported ZIP that arrived earlier under the same name.
      let finalName = name;
      for (let i = 2; fs.existsSync(path.join(handoff.stageDir(), finalName)); i++) {
        finalName = name.replace(/\.zip$/i, `-${i}.zip`);
      }
      const finalAbs = path.join(handoff.stageDir(), finalName);
      fs.renameSync(stagedAbs, finalAbs); // same directory — instant
      const bytes = fs.statSync(finalAbs).size;
      const sha256 = await handoff.sha256File(finalAbs);
      const declared = String(req.body.sha256 || '').trim().toLowerCase();
      if (declared && declared !== sha256) {
        try { fs.unlinkSync(finalAbs); } catch { /* ignore */ }
        return res.status(422).json({ ok: false, error: 'sha256 mismatch — staged copy deleted, please re-send', bytes, sha256 });
      }
      handoff.recordArrival(finalName, bytes, sha256);
      return res.json({ ok: true, name: finalName, bytes, sha256 });
    } catch (e) {
      console.error('muse handoff upload failed:', e);
      discard();
      return res.status(500).json({ ok: false, error: 'store failed' });
    }
  });
});

// GET /api/muse/handoff-zips — what has arrived: every staged/imported
// ZIP with filename, bytes, sha256, status, plus the storage state the
// import will use (R2 relocation when configured). Auth: Bearer token.
router.get('/handoff-zips', async (req, res) => {
  const token = serviceToken();
  if (!token) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const handoff = require('../lib/handoffImport');
    const storage = require('../lib/storage');
    const data = await handoff.listHandoffs();
    return res.json({
      ok: true,
      stage: data.stage,
      storage: { provider: storage.provider(), r2_configured: storage.r2Configured() },
      zips: data.zips,
    });
  } catch (e) {
    console.error('muse handoff list failed:', e);
    return res.status(500).json({ ok: false, error: 'list failed' });
  }
});

// POST /api/muse/handoff-zips/:name/import — import one staged ZIP into
// the gallery through the canonical population path (see
// lib/handoffImport.js). JSON body (all optional): attributed_email,
// style (a design style slug; anything else → "other"), categories
// (comma-separated), description. On success the staged ZIP is deleted
// and the manifest entry is marked imported with the counts; on failure
// the ZIP stays staged for a retry. Long-running for big ZIPs (a few
// minutes for ~373 pairs) — callers should use a generous timeout.
router.post('/handoff-zips/:name/import', express.json(), async (req, res) => {
  const token = serviceToken();
  if (!token) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  req.setTimeout(0);
  const handoff = require('../lib/handoffImport');
  const name = handoff.sanitizeZipName(req.params.name);
  if (!name) return res.status(400).json({ ok: false, error: 'bad zip name' });
  try {
    const body = req.body || {};
    const report = await handoff.importHandoffZip(name, {
      attributedEmail: body.attributed_email,
      style: body.style,
      categories: body.categories,
      description: body.description,
    });
    handoff.markImported(name, report);
    return res.json({ ok: true, name, report });
  } catch (e) {
    console.error('muse handoff import failed:', e);
    handoff.markImportError(name, e.message);
    const status = e.code === 'not_found' ? 404 : e.code === 'insufficient_storage' ? 422 : 500;
    return res.status(status).json({ ok: false, error: e.message, code: e.code || 'import_failed' });
  }
});

// DELETE /api/muse/handoff-zips/:name — remove a staged ZIP (and its
// manifest entry). Used to discard test/duplicate transfers; imported
// entries are already deleted from disk by the import itself.
router.delete('/handoff-zips/:name', (req, res) => {
  const token = serviceToken();
  if (!token) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const handoff = require('../lib/handoffImport');
  const name = handoff.sanitizeZipName(req.params.name);
  if (!name) return res.status(400).json({ ok: false, error: 'bad zip name' });
  const deleted = handoff.deleteHandoff(name);
  return res.json({ ok: true, name, deleted });
});

// POST /api/muse/publish-lil-bundle
// Publishes a Little Inkers weekly coloring-page bundle to production over
// HTTPS — lets the owner's automation publish the weekly bundle without shell
// access (same rationale as /upload-sideload). Multipart body:
//   id          text, bundle id, format YYYY-Www (e.g. 2026-W42)
//   title       text, e.g. "Spooky Friends"
//   theme       text, e.g. "Halloween"
//   publishedAt text, epoch millis (13 digits)
//   designs     text, JSON array of {id, title, file}
//   pages       files (field "pages", up to 50): the page images, JPG/PNG/WebP,
//               magic-byte sniffed, each <= 2MB
// Server-side: uploads each page to the R2 public bucket under
// lil-bundles/<id>/, writes + uploads bundle.json, inserts the lil_bundles
// manifest row (skipped when the id already exists), then GETs every public
// URL to verify 200 + non-empty body. Returns the manifest + public URLs.
// Same service-token auth as /notify; 404s when MUSE_SERVICE_TOKEN unset.
router.post('/publish-lil-bundle', (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  lilBundleUpload(req, res, async (err) => {
    const staged = (req.files || []).map((f) => f.path);
    const cleanup = () => { for (const p of staged) { try { fs.unlinkSync(p); } catch { /* best effort */ } } };
    if (err) { cleanup(); return res.status(400).json({ ok: false, error: err.message }); }
    try {
      const { id, title, theme, publishedAt, designs } = req.body || {};
      if (!/^\d{4}-W\d{2}$/.test(id || '')) { cleanup(); return res.status(400).json({ ok: false, error: 'bad bundle id (want YYYY-Www)' }); }
      if (!title || !theme) { cleanup(); return res.status(400).json({ ok: false, error: 'title and theme required' }); }
      if (!/^\d{13}$/.test(publishedAt || '')) { cleanup(); return res.status(400).json({ ok: false, error: 'publishedAt must be 13-digit epoch millis' }); }
      let list;
      try { list = JSON.parse(designs || ''); } catch { list = null; }
      if (!Array.isArray(list) || !list.length || list.length > 50) { cleanup(); return res.status(400).json({ ok: false, error: 'designs must be a JSON array of 1-50' }); }
      const seenIds = new Set(), seenFiles = new Set();
      for (const d of list) {
        if (!d || typeof d.id !== 'string' || typeof d.title !== 'string' || typeof d.file !== 'string' ||
            !/^[a-z0-9][a-z0-9_-]*$/.test(d.id) || !d.title.trim() ||
            !/^[a-z0-9][a-z0-9_-]*\.(jpg|jpeg|png|webp)$/.test(d.file) ||
            seenIds.has(d.id) || seenFiles.has(d.file)) {
          cleanup(); return res.status(400).json({ ok: false, error: 'bad designs entry (ids/files must be unique, file names safe)' });
        }
        seenIds.add(d.id); seenFiles.add(d.file);
      }
      // Every declared file must have exactly one uploaded page, and vice versa.
      const byName = new Map();
      for (const f of (req.files || [])) {
        const name = (f.originalname || '').toLowerCase();
        if (byName.has(name)) { cleanup(); return res.status(400).json({ ok: false, error: `duplicate upload: ${name}` }); }
        byName.set(name, f);
      }
      for (const d of list) {
        if (!byName.has(d.file)) { cleanup(); return res.status(400).json({ ok: false, error: `missing upload for ${d.file}` }); }
      }
      if (byName.size !== list.length) { cleanup(); return res.status(400).json({ ok: false, error: 'uploaded files must match designs exactly' }); }
      // Magic-byte sniff every staged file (mimetype/extension can lie).
      const contentTypes = new Map();
      for (const d of list) {
        const buf = fs.readFileSync(byName.get(d.file).path);
        const kind = sniffImageType(buf);
        if (!kind) { cleanup(); return res.status(400).json({ ok: false, error: `${d.file} is not a real image` }); }
        contentTypes.set(d.file, kind === 'png' ? 'image/png' : kind === 'webp' ? 'image/webp' : 'image/jpeg');
      }
      for (const v of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_BUCKET', 'R2_PUBLIC_URL']) {
        if (!process.env[v]) { cleanup(); return res.status(500).json({ ok: false, error: 'r2 not configured' }); }
      }
      const bucket = process.env.R2_PUBLIC_BUCKET;
      const base = process.env.R2_PUBLIC_URL.replace(/\/$/, '');
      const prefix = `lil-bundles/${id}/`;
      const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
      const s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
      });
      const urlFor = (file) => `${base}/${prefix}${file}`;
      // Upload page images (skip objects already present — re-runs are safe).
      const { HeadObjectCommand } = require('@aws-sdk/client-s3');
      for (const d of list) {
        const key = prefix + d.file;
        let exists = false;
        try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); exists = true; }
        catch (e) { if (!(e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404)) throw e; }
        if (!exists) {
          await s3.send(new PutObjectCommand({
            Bucket: bucket, Key: key,
            Body: fs.readFileSync(byName.get(d.file).path),
            ContentType: contentTypes.get(d.file),
          }));
        }
      }
      // Bundle JSON (always re-uploaded; PUT is idempotent).
      const bundle = {
        id, title, theme,
        publishedAt: Number(publishedAt),
        designs: list.map((d) => ({ id: d.id, title: d.title, file: d.file, imageUrl: urlFor(d.file) })),
      };
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: prefix + 'bundle.json',
        Body: Buffer.from(JSON.stringify(bundle, null, 2)),
        ContentType: 'application/json',
      }));
      // Manifest row (skip when the id already exists).
      const fileUrl = urlFor('bundle.json');
      const existing = await db.get('SELECT id FROM lil_bundles WHERE id = ?', [id]);
      if (!existing) {
        await db.insert('lil_bundles', {
          id, title, theme,
          design_count: list.length,
          published_at: Number(publishedAt),
          file_url: fileUrl,
          active: 1,
        });
      }
      // Verify every public URL.
      const urls = [...list.map((d) => urlFor(d.file)), fileUrl];
      const failed = [];
      for (const u of urls) {
        const r = await lilFetchOk(u);
        if (!(r.status === 200 && r.bytes > 0)) failed.push(`${r.status}/${r.bytes}b ${u}`);
      }
      cleanup();
      if (failed.length) {
        console.error('[muse/publish-lil-bundle] URL verification failed:', failed.join(' | '));
        return res.status(500).json({ ok: false, error: 'url verification failed', failed });
      }
      return res.json({
        ok: true, alreadyPublished: !!existing,
        id, title, theme,
        designCount: list.length,
        publishedAt: Number(publishedAt),
        fileUrl,
        designs: bundle.designs,
      });
    } catch (e) {
      cleanup();
      console.error('[muse/publish-lil-bundle] failed:', e.message);
      return res.status(500).json({ ok: false, error: 'publish failed' });
    }
  });
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

// POST /api/muse/custom-orders/:id/drafts
// PRODUCTION fulfillment: the owner's draft worker generates 3-5 draft images
// on the VM (media pipeline), then POSTs them here as multipart field "drafts"
// (+ optional text field "note"). Files land in the order's drafts dir and the
// row flips to drafts_ready — exactly what scripts/generate-custom-drafts.js
// --record does locally, but against production so the 48h SLA can actually
// close. Same service-token auth as the other /api/muse endpoints; 404s when
// MUSE_SERVICE_TOKEN is unset.
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { draftsDir } = require('../lib/customFulfillment');

const draftStageDir = path.join(os.tmpdir(), 'tac-draft-stage');
try { fs.mkdirSync(draftStageDir, { recursive: true }); } catch { /* best effort */ }

const draftUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, draftStageDir),
    filename: (req, file, cb) => cb(null, `stg-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`),
  }),
  limits: { fileSize: 12 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, or WebP draft images are allowed.'));
  },
}).array('drafts', 5);

// POST /api/muse/upload-ipa
// Uploads the iOS sideload IPA to production storage (uploads/ios-app/).
// Lets the owner's automation publish new IPA builds without shell access.
// Accepts a single .ipa file (zip magic verified), max 300MB, and stores it
// as uploads/ios-app/tattoo-art-customs.ipa under config.uploadDir.
// Same service-token auth as /notify; 404s when MUSE_SERVICE_TOKEN unset.
const ipaStageDir = path.join(os.tmpdir(), 'tac-ipa-stage');
try { fs.mkdirSync(ipaStageDir, { recursive: true }); } catch { /* best effort */ }

const ipaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ipaStageDir),
    filename: (req, file, cb) => cb(null, `stg-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.ipa`),
  }),
  limits: { fileSize: 300 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/\.ipa$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only .ipa files are allowed.'));
  },
}).single('ipa');

// Sideload build upload allowlist + middleware (used by POST /upload-sideload
// defined above; kept here next to ipaUpload so multer/fs/path/os/crypto are
// initialized).
const SIDELOAD_UPLOAD_APPS = {
  'little-inkers-ios': { ext: '.ipa', dest: 'uploads/sideload/little-inkers.ipa' },
  'little-inkers-android': { ext: '.apk', dest: 'uploads/sideload/little-inkers.apk' },
  'tac-android-free': { ext: '.apk', dest: 'uploads/sideload/tac-android-free.apk' },
  'tac-android-pro': { ext: '.apk', dest: 'uploads/sideload/tac-android-pro.apk' },
};

const sideloadUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ipaStageDir),
    filename: (req, file, cb) => cb(null, `stg-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.bin`),
  }),
  limits: { fileSize: 300 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/\.(ipa|apk)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only .ipa or .apk files are allowed.'));
  },
}).single('file');

// Handoff ZIP upload middleware (used by POST /handoff-zips defined
// above; kept here next to the other upload middlewares so multer/fs/
// path/os/crypto are initialized). Disk-streamed into the handoff
// staging area on the ephemeral tmp filesystem under an stg- prefix;
// the route renames it to its final name after the zip-magic and
// sha256 checks. 512 MB cap (handoff ZIPs run ~390 MB).
const handoffUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try { cb(null, require('../lib/handoffImport').stageDir()); } catch (e) { cb(e); }
    },
    filename: (req, file, cb) => cb(null, `stg-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.zip`),
  }),
  limits: { fileSize: require('../lib/handoffImport').HANDOFF_MAX_ZIP_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/\.zip$/i.test(file.originalname || '')) cb(null, true);
    else cb(new Error('Only .zip files are accepted.'));
  },
}).single('file');

// Little Inkers bundle upload middleware (used by POST /publish-lil-bundle
// defined above; kept here next to the other upload middlewares so
// multer/fs/path/os/crypto are initialized).
const lilStageDir = path.join(os.tmpdir(), 'tac-lil-bundle-stage');
try { fs.mkdirSync(lilStageDir, { recursive: true }); } catch { /* best effort */ }

const lilBundleUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, lilStageDir),
    filename: (req, file, cb) => cb(null, `stg-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.img`),
  }),
  limits: { fileSize: 2 * 1024 * 1024, files: 50 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, or WebP page images are allowed.'));
  },
}).array('pages', 50);

function lilFetchOk(url, redirects = 3) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? require('https') : require('http');
    lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(lilFetchOk(res.headers.location, redirects - 1));
      }
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes }));
      res.on('error', () => resolve({ status: 0, bytes: 0 }));
    }).on('error', () => resolve({ status: 0, bytes: 0 }));
  });
}


// Magic-byte sniff: mimetype/extension can lie; read the real file header.
function sniffImageType(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

router.post('/custom-orders/:id/drafts', messageLimiter, (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const orderId = String(req.params.id || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) return res.status(400).json({ ok: false, error: 'bad order id' });
  draftUpload(req, res, async (err) => {
    const staged = (req.files || []).map((f) => f.path);
    const cleanup = () => { for (const p of staged) { try { fs.unlinkSync(p); } catch {} } };
    if (err) { cleanup(); return res.status(400).json({ ok: false, error: 'upload failed' }); }
    try {
      const order = await db.get(
        'SELECT id, order_type, status, custom_status FROM orders WHERE id = ?', [orderId]);
      if (!order || order.order_type !== 'custom') {
        cleanup();
        return res.status(404).json({ ok: false, error: 'custom order not found' });
      }
      if (order.status !== 'paid' || order.custom_status !== 'needs_drafts') {
        cleanup();
        return res.status(422).json({ ok: false, error: 'order is not awaiting drafts' });
      }
      const files = req.files || [];
      if (files.length < 3 || files.length > 5) {
        cleanup();
        return res.status(422).json({ ok: false, error: 'need 3-5 draft images' });
      }
      const note = String(req.body.note || '').slice(0, 500);
      // Validate real image content BEFORE anything touches the drafts dir.
      const kinds = [];
      for (const f of files) {
        const head = Buffer.alloc(12);
        const fd = fs.openSync(f.path, 'r');
        fs.readSync(fd, head, 0, 12, 0);
        fs.closeSync(fd);
        const kind = sniffImageType(head);
        if (!kind) { cleanup(); return res.status(422).json({ ok: false, error: 'draft is not a real image' }); }
        kinds.push(kind);
      }
      const dir = draftsDir(order.id);
      fs.mkdirSync(dir, { recursive: true });
      const drafts = files.map((f, i) => {
        const ext = kinds[i] === 'jpg' ? '.jpg' : '.' + kinds[i];
        const name = `draft-${i + 1}${ext}`;
        fs.renameSync(f.path, path.join(dir, name));
        return { file: name, note };
      });
      await db.update('orders', order.id, {
        drafts_json: JSON.stringify(drafts),
        custom_status: 'drafts_ready',
      });
      return res.json({ ok: true, order_id: order.id, count: drafts.length });
    } catch (e) {
      console.error('[muse/custom-orders-drafts] failed:', e.message);
      return res.status(500).json({ ok: false, error: 'fulfillment failed' });
    } finally {
      cleanup();
    }
  });
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

// GET /api/muse/pending-designs?artist=<name-or-email-fragment>&since=<ms-epoch>
// Lists pending (unapproved) designs, optionally filtered to one uploader.
// Powers the Chris Jones auto-approve watcher: his by-request uploads get
// approved and filed into the by-request catalog without owner taps.
// Same service-token auth as /notify; 404s when MUSE_SERVICE_TOKEN unset.
router.get('/pending-designs', async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const q = String(req.query.artist || '').toLowerCase();
  const since = Number(req.query.since || 0) || 0;
  try {
    const { rows } = await db.query(
      `SELECT d.id, d.title, d.description, d.color_path, d.linework_path,
              d.linework_wm_path, d.status AS design_status, d.created_at,
              d.artist_id, u.display_name AS artist_name, u.email AS artist_email,
              rq.id AS review_id
         FROM designs d
         LEFT JOIN users u ON u.id = d.artist_id
         LEFT JOIN review_queue rq ON rq.item_type = 'design' AND rq.item_id = d.id AND rq.status = 'open'
        WHERE d.status = 'pending' AND d.created_at >= ?
        ORDER BY d.created_at DESC LIMIT 200`,
      [since]
    );
    const designs = q
      ? rows.filter(r => String(r.artist_name || '').toLowerCase().includes(q) ||
                         String(r.artist_email || '').toLowerCase().includes(q))
      : rows;
    return res.json({ ok: true, count: designs.length, designs });
  } catch (e) {
    console.error('[muse/pending-designs] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'query failed', detail: e.message });
  }
});

// POST /api/muse/pending-designs/:id/approve
// Approves one pending design — mirrors the admin applyReviewDecision path
// for designs (requires the watermarked linework, marks the review closed,
// runs completeOnApproval). Owner standing order: Chris Jones's uploads are
// auto-approved; this is the machine endpoint the watcher uses.
// Same service-token auth as /notify; 404s when MUSE_SERVICE_TOKEN unset.
router.post('/pending-designs/:id/approve', express.json(), async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const design = await db.get('SELECT * FROM designs WHERE id = ?', [req.params.id]);
    if (!design) return res.status(404).json({ ok: false, error: 'not found' });
    if (design.status !== 'pending') return res.json({ ok: true, already: design.status, design });
    if (!design.linework_wm_path) {
      return res.status(400).json({ ok: false, error: 'blocked-no-watermark' });
    }
    await db.update('designs', design.id, { status: 'approved' });
    await db.query(
      "UPDATE review_queue SET status = 'approved', reviewed_at = ? WHERE item_type = 'design' AND item_id = ? AND status = 'open'",
      [db.now(), design.id]
    );
    try {
      const { completeOnApproval } = require('../lib/replacements');
      await completeOnApproval(design.id);
    } catch (e) {
      console.error('[muse/pending-designs-approve] completeOnApproval failed:', e.message);
    }
    return res.json({ ok: true, design });
  } catch (e) {
    console.error('[muse/pending-designs-approve] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'approve failed' });
  }
});

module.exports = router;

// POST /api/muse/designs/:id/delete
// Permanently deletes a design and its asset files. Blocked when the piece
// has sales (same rule as the admin UI). Owner-authorized moderation action
// for the owner's own assistant — e.g. removing third-party art uploaded by
// mistake. Same service-token auth as /notify; 404s when MUSE_SERVICE_TOKEN unset.
router.post('/designs/:id/delete', express.json(), async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const design = await db.get('SELECT * FROM designs WHERE id = ?', [req.params.id]);
    if (!design) return res.status(404).json({ ok: false, error: 'not found' });
    const paid = await db.get("SELECT id FROM orders WHERE design_id = ? AND status = 'paid' LIMIT 1", [design.id]);
    if (paid || (design.sale_count || 0) > 0) {
      return res.status(400).json({ ok: false, error: 'blocked-has-sales' });
    }
    const fs = require('fs');
    const { resolveStoredPath } = require('../lib/storage');
    for (const p of [design.color_path, design.linework_path, design.linework_wm_path, design.custom_watermark_path]) {
      const abs = p ? resolveStoredPath(p) : null;
      if (abs) { try { fs.unlinkSync(abs); } catch { /* already gone */ } }
    }
    await db.query('DELETE FROM designs WHERE id = ?', [design.id]);
    return res.json({ ok: true, deleted: design.id });
  } catch (e) {
    console.error('[muse/designs-delete] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'delete failed' });
  }
});
