// Customer journal. Mounted at /journal by the coordinator — all routes
// here are relative to that mount. All routes require login.
const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');
const { formLimiter } = require('../middleware/rateLimit');
const { screenText } = require('../lib/screening');
const { handlePhotoUpload, photoRelPath } = require('../lib/socialUpload');

const router = express.Router();
// API-style clients get a 401 JSON body instead of the login-page redirect.
router.use((req, res, next) => {
  if (!req.user && (req.headers.accept || '').includes('application/json')) {
    return res.status(401).json({ ok: false, error: 'Login required.' });
  }
  requireLogin(req, res, next);
});

function wantsJson(req) {
  return (req.headers.accept || '').includes('application/json');
}

// The customer's timeline: bookings (read-only), journal entries, healed
// posts they authored, and designs saved on their boards — chronological,
// newest first.
router.get('/', async (req, res) => {
  const me = req.user.id;

  const entries = await db.all(
    `SELECT * FROM journal_entries WHERE customer_user_id = ?
     ORDER BY COALESCE(happened_at, created_at) DESC, created_at DESC LIMIT 100`, [me]);
  const bookings = await db.all(
    `SELECT b.*, u.display_name AS shop_name
     FROM bookings b JOIN users u ON u.id = b.shop_user_id
     WHERE b.customer_user_id = ? ORDER BY b.start_at DESC LIMIT 50`, [me]);
  const posts = await db.all(
    `SELECT * FROM healed_posts WHERE customer_user_id = ?
     ORDER BY created_at DESC LIMIT 100`, [me]);
  const boards = await db.all(
    `SELECT b.id, b.name,
            (SELECT COUNT(*) FROM board_items bi WHERE bi.board_id = b.id) AS item_count
     FROM design_boards b WHERE b.owner_user_id = ? ORDER BY b.created_at DESC`, [me]);

  const timeline = [
    ...entries.map((e) => ({ kind: 'journal', at: e.happened_at || e.created_at, entry: e })),
    ...bookings.map((b) => ({ kind: 'booking', at: b.start_at, booking: b })),
    ...posts.map((p) => ({ kind: 'healed', at: p.created_at, post: p })),
  ].sort((a, b) => b.at - a.at);

  const payload = { ok: true, timeline, boards };
  if (wantsJson(req)) return res.json(payload);
  res.render('journal/index', { title: 'My tattoo journal', timeline, boards });
});

router.post('/entries', formLimiter, async (req, res) => {
  const err = await handlePhotoUpload(req, res);
  if (wantsJson(req) && err) return res.status(422).json({ ok: false, error: err.message });
  if (err) {
    req.session.flash = err.message;
    return res.redirect('/journal');
  }
  const caption = String(req.body.caption || '').trim().slice(0, 2000);
  if (wantsJson(req) && !caption && !req.file) {
    return res.status(422).json({ ok: false, error: 'Add a photo or a caption.' });
  }
  if (!caption && !req.file) {
    req.session.flash = 'Add a photo or a caption to your journal entry.';
    return res.redirect('/journal');
  }
  if (caption) {
    const screen = screenText(caption);
    if (!screen.ok) {
      const msg = 'That caption looks like it contains contact or payment info (' +
        screen.flags.map((f) => f.label).join(', ') +
        ') — all contact stays through the site, so we could not save it.';
      if (wantsJson(req)) return res.status(422).json({ ok: false, error: msg });
      req.session.flash = msg;
      return res.redirect('/journal');
    }
  }
  // Optional booking link — must be the customer's own booking.
  let bookingId = null;
  if (req.body.booking_id) {
    const b = await db.get(
      'SELECT id FROM bookings WHERE id = ? AND customer_user_id = ?',
      [String(req.body.booking_id), req.user.id]);
    if (!b) {
      const msg = 'That booking is not yours.';
      if (wantsJson(req)) return res.status(422).json({ ok: false, error: msg });
      req.session.flash = msg;
      return res.redirect('/journal');
    }
    bookingId = b.id;
  }
  // Optional design link — must exist.
  let designId = null;
  if (req.body.design_id) {
    const d = await db.get('SELECT id FROM designs WHERE id = ?', [String(req.body.design_id)]);
    if (!d) {
      const msg = 'That design was not found.';
      if (wantsJson(req)) return res.status(422).json({ ok: false, error: msg });
      req.session.flash = msg;
      return res.redirect('/journal');
    }
    designId = d.id;
  }
  let happenedAt = null;
  if (req.body.happened_at) {
    const t = /^\d+$/.test(String(req.body.happened_at).trim())
      ? parseInt(req.body.happened_at, 10)
      : Date.parse(req.body.happened_at);
    if (Number.isFinite(t) && t > 0) happenedAt = t;
  }
  const id = await db.insert('journal_entries', {
    customer_user_id: req.user.id,
    booking_id: bookingId,
    design_id: designId,
    photo_path: req.file ? photoRelPath(req.file) : null,
    caption: caption || null,
    happened_at: happenedAt,
    created_at: db.now(),
  });
  if (wantsJson(req)) return res.status(201).json({ ok: true, entry_id: id });
  req.session.flash = 'Journal entry saved.';
  res.redirect('/journal');
});

module.exports = router;
