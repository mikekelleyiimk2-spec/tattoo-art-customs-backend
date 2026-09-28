// Design artist area (requires active design_artist subscription).
// Uploads, bio editor (screened), commission dashboard (splits visible
// here ONLY — never to customers), payout email setup.
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { screenText } = require('../lib/screening');
const { payableBalance } = require('../lib/commissions');
const { registerPayoutRoutes, payoutDashboardData } = require('../lib/payoutRoutes');

const router = express.Router();
router.use(requireLogin, requireSubscription('design_artist'));
registerPayoutRoutes(router, 'artist');

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

router.get('/', async (req, res) => {
  const designs = await db.all('SELECT * FROM designs WHERE artist_id = ? ORDER BY created_at DESC', [req.user.id]);
  const profile = await db.get('SELECT * FROM artist_profiles WHERE user_id = ?', [req.user.id]) || {};
  const balance = await payableBalance('artist', req.user.id);
  const payouts = await db.all(
    "SELECT * FROM payouts WHERE recipient_type = 'artist' AND recipient_id = ? ORDER BY created_at DESC LIMIT 10",
    [req.user.id]);
  const ledger = await db.all(
    'SELECT * FROM commission_ledger WHERE recipient_type = ? AND recipient_id = ? ORDER BY created_at DESC LIMIT 25',
    ['artist', req.user.id]);
  const payout = await payoutDashboardData(req.user.id, 'artist');
  res.render('artist/dashboard', {
    title: 'Artist Dashboard — Tattoo Art Customs',
    designs: designs.map((d) => ({ ...d, categories: JSON.parse(d.categories || '[]') })),
    profile, balance, payouts, ledger, metaDescription: '',
    ...payout,
  });
});

router.get('/upload', (req, res) => res.render('artist/upload', {
  title: 'Upload a design — Tattoo Art Customs', metaDescription: '',
}));

router.post('/upload', formLimiter, (req, res, next) => {
  uploadDesign(req, res, (err) => {
    if (err) { req.session.flash = err.message; return res.redirect('/artist/upload'); }
    next();
  });
}, checkHoneypot, async (req, res) => {
  const files = req.files || {};
  if (!files.color || !files.linework) {
    req.session.flash = 'Both a full-color image and a clean linework image are required.';
    return res.redirect('/artist/upload');
  }
  const title = String(req.body.title || '').trim().slice(0, 120);
  if (!title) { req.session.flash = 'Give your design a title.'; return res.redirect('/artist/upload'); }
  const description = String(req.body.description || '').trim().slice(0, 2000);
  const categories = String(req.body.categories || '').split(',')
    .map((c) => c.trim().toLowerCase().replace(/[^a-z0-9- ]/g, '').slice(0, 40))
    .filter(Boolean).slice(0, 12);

  // Contact-info screening on title/description.
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
    ? 'Design uploaded — it goes live after admin review.'
    : 'Design uploaded but flagged for review (possible contact info).';
  res.redirect('/artist');
});

// Bio editor — screened; blocked on contact info, flagged for review.
router.post('/bio', formLimiter, checkHoneypot, async (req, res) => {
  const bio = String(req.body.bio || '').trim().slice(0, 2000);
  const screen = screenText(bio);
  const existing = await db.get('SELECT user_id FROM artist_profiles WHERE user_id = ?', [req.user.id]);
  const data = { bio, bio_status: screen.ok ? 'ok' : 'flagged' };
  if (existing) await db.updateWhere('artist_profiles', data, 'user_id', req.user.id);
  else await db.insert('artist_profiles', { user_id: req.user.id, ...data, created_at: db.now() });
  if (!screen.ok) {
    await db.insert('review_queue', {
      item_type: 'bio', item_id: req.user.id,
      reason: 'Contact info detected in bio: ' + screen.flags.map((f) => f.label).join(', '),
      status: 'open', created_at: db.now(),
    });
    req.session.flash = 'Bio saved but flagged for review — remove any contact info or off-site links.';
  } else {
    req.session.flash = 'Bio updated.';
  }
  res.redirect('/artist');
});

// Payout method (PayPal email).
router.post('/payout-email', formLimiter, checkHoneypot, async (req, res) => {
  const email = String(req.body.paypal_email || '').trim().toLowerCase().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    req.session.flash = 'Enter a valid PayPal email.';
    return res.redirect('/artist');
  }
  const existing = await db.get('SELECT user_id FROM artist_profiles WHERE user_id = ?', [req.user.id]);
  if (existing) await db.updateWhere('artist_profiles', { payout_paypal_email: email }, 'user_id', req.user.id);
  else await db.insert('artist_profiles', { user_id: req.user.id, payout_paypal_email: email, created_at: db.now() });
  req.session.flash = 'Payout email saved. You become payable once registered, subscribed, and this is set.';
  res.redirect('/artist');
});

module.exports = router;
