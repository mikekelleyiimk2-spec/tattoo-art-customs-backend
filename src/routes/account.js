// Member account: profile, tattoo-photo uploads.
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { requireLogin } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { registerPayoutRoutes, payoutDashboardData } = require('../lib/payoutRoutes');
const credits = require('../lib/credits');

const router = express.Router();
registerPayoutRoutes(router, 'customer');

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.assetDir, 'uploads', 'photos');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 5) || '.jpg';
    cb(null, `${req.user.id}-${Date.now()}${ext}`);
  },
});
const uploadPhoto = multer({
  storage: photoStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, or WebP images are allowed.'));
  },
});

router.get('/', requireLogin, async (req, res) => {
  const photos = await db.all('SELECT * FROM member_photos WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
  const subs = await db.all(
    `SELECT s.*, p.name AS plan_name, p.slug AS plan_slug FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id WHERE s.user_id = ? ORDER BY s.created_at DESC`, [req.user.id]);
  const orders = await db.all('SELECT * FROM orders WHERE buyer_id = ? ORDER BY created_at DESC LIMIT 10', [req.user.id]);
  const creditBalance = await credits.getCreditBalance(req.user.id);
  const creditTxns = await credits.creditHistory(req.user.id, 15);
  const { listDestinations } = require('../lib/cashout');
  const destinations = await listDestinations(req.user.id);
  const withdrawals = await db.all(
    "SELECT * FROM cashout_requests WHERE user_id = ? AND kind = 'withdrawal' ORDER BY created_at DESC LIMIT 10",
    [req.user.id]);
  const uploads = await db.all('SELECT id, title, status, created_at FROM designs WHERE artist_id = ? ORDER BY created_at DESC LIMIT 20', [req.user.id]);
  res.render('account/dashboard', {
    title: 'My Account — Tattoo Art Customs', photos, subs, orders,
    metaDescription: 'Your Tattoo Art Customs account.',
    creditBalance, creditTxns, destinations, withdrawals, uploads,
    destTypes: require('../lib/cashout').DEST_TYPES,
  });
});

router.post('/profile', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const displayName = String(req.body.display_name || '').trim().slice(0, 60);
  if (displayName) await db.update('users', req.user.id, { display_name: displayName });
  req.session.flash = 'Profile updated.';
  res.redirect('/account');
});

// --- Change password (self-service; needed for temp-password logins) ---
router.post('/password', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  const user = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!user || !(await bcrypt.compare(current, user.password_hash))) {
    req.session.flash = 'Current password is incorrect.';
    return res.redirect('/account');
  }
  if (next.length < 8) {
    req.session.flash = 'New password must be at least 8 characters.';
    return res.redirect('/account');
  }
  await db.update('users', req.user.id, { password_hash: await bcrypt.hash(next, 12) });
  req.session.flash = 'Password changed.';
  res.redirect('/account');
});
router.post('/topup', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const dollars = parseFloat(String(req.body.amount || ''));
  if (!isFinite(dollars) || dollars <= 0) {
    req.session.flash = 'Enter a top-up amount.';
    return res.redirect('/account');
  }
  try {
    const { approveUrl } = await credits.createTopup({ userId: req.user.id, amountCents: Math.round(dollars * 100) });
    res.redirect(approveUrl);
  } catch (e) {
    req.session.flash = 'Top-up failed: ' + e.message;
    res.redirect('/account');
  }
});

router.get('/topup/approve/:topupId', requireLogin, async (req, res) => {
  try {
    await credits.completeTopup({ userId: req.user.id, topupId: req.params.topupId });
    req.session.flash = 'Site credit added — ready to spend.';
  } catch (e) {
    req.session.flash = 'Top-up failed: ' + e.message;
  }
  res.redirect('/account');
});

// --- Withdraw site credit to a payout destination (3% auto-withheld) ---
router.post('/withdraw', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const dollars = parseFloat(String(req.body.amount || ''));
  try {
    const result = await credits.requestWithdrawal({
      userId: req.user.id,
      destinationId: String(req.body.destination_id || ''),
      amountCents: isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : null,
    });
    const net = (result.net_cents / 100).toFixed(2);
    const fee = (result.penalty_cents / 100).toFixed(2);
    req.session.flash = result.status === 'completed'
      ? `Withdrew $${net} (3% fee $${fee} withheld).`
      : `Withdrawal of $${net} requested (3% fee $${fee} withheld) — the admin will send it shortly.`;
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect('/account');
});

router.post('/photos', requireLogin, formLimiter, (req, res, next) => {
  uploadPhoto.single('photo')(req, res, (err) => {
    if (err) { req.session.flash = err.message; return res.redirect('/account'); }
    next();
  });
}, checkHoneypot, async (req, res) => {
  if (!req.file) { req.session.flash = 'Choose a photo to upload.'; return res.redirect('/account'); }
  const caption = String(req.body.caption || '').trim().slice(0, 140);
  await db.insert('member_photos', {
    user_id: req.user.id,
    path: `/img/photos/${req.file.filename}`,
    caption, created_at: db.now(),
  });
  req.session.flash = 'Photo added to your profile.';
  res.redirect('/account');
});

router.post('/photos/:id/delete', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const photo = await db.get('SELECT * FROM member_photos WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (photo) {
    const abs = path.join(config.assetDir, 'uploads', 'photos', path.basename(photo.path));
    fs.unlink(abs, () => {});
    await db.query('DELETE FROM member_photos WHERE id = ?', [photo.id]);
    req.session.flash = 'Photo removed.';
  }
  res.redirect('/account');
});

// --- Free art uploads: ANY logged-in user (no subscription required).
// Every upload requires administrator approval before it appears in the
// gallery or can be sold. Only active designer-subscription members earn
// the designer commission on their art; customer subscriptions never
// earn commission.
const { screenText } = require('../lib/screening');
const designStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.assetDir, 'uploads', 'designs');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 5) || '.jpg';
    cb(null, `${req.user.id}-${Date.now()}-${file.fieldname}${ext}`);
  },
});
const uploadDesign = multer({
  storage: designStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, or WebP images are allowed.'));
  },
}).fields([{ name: 'color', maxCount: 1 }, { name: 'linework', maxCount: 1 }]);

router.get('/upload', requireLogin, (req, res) => res.render('account/upload', {
  title: 'Upload your art — Tattoo Art Customs', metaDescription: '',
}));

router.post('/upload', requireLogin, formLimiter, (req, res, next) => {
  uploadDesign(req, res, (err) => {
    if (err) { req.session.flash = err.message; return res.redirect('/account/upload'); }
    next();
  });
}, checkHoneypot, async (req, res) => {
  const files = req.files || {};
  if (!files.color || !files.linework) {
    req.session.flash = 'Both a full-color image and a clean linework image are required.';
    return res.redirect('/account/upload');
  }
  const title = String(req.body.title || '').trim().slice(0, 120);
  if (!title) { req.session.flash = 'Give your design a title.'; return res.redirect('/account/upload'); }
  const description = String(req.body.description || '').trim().slice(0, 2000);
  const categories = String(req.body.categories || '').split(',')
    .map((c) => c.trim().toLowerCase().replace(/[^a-z0-9- ]/g, '').slice(0, 40))
    .filter(Boolean).slice(0, 12);

  // Contact-info screening on title/description — flagged items go to the
  // admin review queue; nothing goes live without an admin's approval.
  const screen = screenText(`${title}\n${description}`);
  const id = await db.insert('designs', {
    title, description, categories: JSON.stringify(categories),
    color_path: path.relative(config.assetDir, files.color[0].path),
    linework_path: path.relative(config.assetDir, files.linework[0].path),
    linework_wm_path: '', // set by the watermarking step before approval
    price_cents: 7500, artist_id: req.user.id,
    status: screen.ok ? 'pending' : 'flagged', created_at: db.now(), sale_count: 0,
  });
  if (!screen.ok) {
    await db.insert('review_queue', {
      item_type: 'design', item_id: id,
      reason: 'Contact info detected in title/description: ' + screen.flags.map((f) => f.label).join(', '),
      status: 'open', created_at: db.now(),
    });
  }
  req.session.flash = screen.ok
    ? 'Art uploaded — it goes live after admin approval.'
    : 'Art uploaded but flagged for review (possible contact info). An admin will review it.';
  res.redirect('/account');
});

module.exports = router;
