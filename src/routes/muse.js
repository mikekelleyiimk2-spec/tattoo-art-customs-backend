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
