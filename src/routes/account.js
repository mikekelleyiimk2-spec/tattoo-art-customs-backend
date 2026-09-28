// Member account: profile, tattoo-photo uploads.
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
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
  res.render('account/dashboard', {
    title: 'My Account — Tattoo Art Customs', photos, subs, orders,
    metaDescription: 'Your Tattoo Art Customs account.',
    creditBalance, creditTxns, destinations, withdrawals,
    destTypes: require('../lib/cashout').DEST_TYPES,
  });
});

router.post('/profile', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const displayName = String(req.body.display_name || '').trim().slice(0, 60);
  if (displayName) await db.update('users', req.user.id, { display_name: displayName });
  req.session.flash = 'Profile updated.';
  res.redirect('/account');
});

// --- Site credit: top up with PayPal ---
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

module.exports = router;
