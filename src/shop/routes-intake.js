// Intake form routes (mounted at /intake by the coordinator).
//
// Customer: GET /:bookingId (form, prefilled) + POST /:bookingId (upsert,
// up to 5 reference photos). Shop: GET /view/:bookingId (the shop that owns
// the booking, or an admin).
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const config = require('../config');
const db = require('../db');
const { MAX_PHOTOS, saveIntake, getIntakeForBooking } = require('./intake');

const router = express.Router();

// Stage uploads in a temp dir; saveIntake() moves them into the intake dir
// on success (so a failed save never leaves orphaned intake photos).
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(config.assetDir, 'uploads', 'intake-tmp');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 5) || '.jpg';
      cb(null, `tmp-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, or WebP images are allowed.'));
  },
}).array('photos', MAX_PHOTOS);

// Customer form (must own the booking).
router.get('/:bookingId', requireLogin, async (req, res) => {
  const booking = await db.get(
    `SELECT b.*, u.display_name AS shop_name FROM bookings b
     JOIN users u ON u.id = b.shop_user_id WHERE b.id = ?`, [req.params.bookingId]);
  if (!booking || booking.customer_user_id !== req.user.id) {
    return res.status(404).render('error', { title: 'Not found', message: 'Booking not found.' });
  }
  const intake = await getIntakeForBooking(booking.id);
  let photos = [];
  if (intake && intake.reference_photos_json) {
    try { photos = JSON.parse(intake.reference_photos_json) || []; } catch (_) { /* ignore */ }
  }
  res.render('intake/form', {
    title: `Intake Form — ${booking.shop_name} — Tattoo Art Customs`,
    booking, intake, photos, maxPhotos: MAX_PHOTOS, metaDescription: '',
  });
});

router.post('/:bookingId', requireLogin, (req, res, next) => {
  upload(req, res, (err) => {
    if (err) {
      req.session.flash = err.message || 'Upload failed.';
      return res.redirect(`/intake/${req.params.bookingId}`);
    }
    next();
  });
}, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const { flagged } = await saveIntake({
      bookingId: req.params.bookingId,
      customerUserId: req.user.id,
      fields: {
        placement: req.body.placement, size_text: req.body.size_text,
        cover_up: req.body.cover_up, details: req.body.details,
      },
      files: req.files || [],
    });
    req.session.flash = flagged
      ? 'Intake form saved — it was flagged for a quick admin review.'
      : 'Intake form saved.';
    // Notify the shop that the intake form is in.
    const booking = await db.get('SELECT shop_user_id FROM bookings WHERE id = ?', [req.params.bookingId]);
    if (booking) {
      const { notifyUser } = require('../lib/notify');
      await notifyUser(booking.shop_user_id, {
        kind: 'intake-submitted', title: 'Intake form submitted',
        body: 'A customer submitted their intake form — review it before the appointment.',
        link: `/intake/view/${req.params.bookingId}`,
      });
    }
    res.redirect(`/intake/${req.params.bookingId}`);
  } catch (e) {
    // Clean up staged uploads on failure.
    for (const f of req.files || []) { try { fs.unlinkSync(f.path); } catch (_) { /* ignore */ } }
    req.session.flash = e.message;
    res.redirect(`/intake/${req.params.bookingId}`);
  }
});

// Shop view (the shop that owns the booking, or an admin).
router.get('/view/:bookingId', requireLogin, async (req, res) => {
  const booking = await db.get(
    `SELECT b.*, s.display_name AS shop_name, c.display_name AS customer_name, c.email AS customer_email
     FROM bookings b
     JOIN users s ON s.id = b.shop_user_id
     JOIN users c ON c.id = b.customer_user_id
     WHERE b.id = ?`, [req.params.bookingId]);
  if (!booking) return res.status(404).render('error', { title: 'Not found', message: 'Booking not found.' });
  const isShop = booking.shop_user_id === req.user.id;
  const isAdmin = req.user.role === 'admin' || req.user.role === 'head_admin';
  if (!isShop && !isAdmin) {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Only the shop can view this intake form.' });
  }
  const intake = await getIntakeForBooking(booking.id);
  let photos = [];
  if (intake && intake.reference_photos_json) {
    try { photos = JSON.parse(intake.reference_photos_json) || []; } catch (_) { /* ignore */ }
  }
  res.render('intake/view', {
    title: `Intake — ${booking.customer_name} — Tattoo Art Customs`,
    booking, intake, photos, metaDescription: '',
  });
});

// Serve a reference photo (booking customer, owning shop, or admin only).
router.get('/photo/:bookingId/:idx', requireLogin, async (req, res) => {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [req.params.bookingId]);
  if (!booking) return res.status(404).send('Not found.');
  const allowed = booking.customer_user_id === req.user.id ||
    booking.shop_user_id === req.user.id ||
    req.user.role === 'admin' || req.user.role === 'head_admin';
  if (!allowed) return res.status(403).send('Forbidden.');
  const intake = await getIntakeForBooking(booking.id);
  let photos = [];
  if (intake && intake.reference_photos_json) {
    try { photos = JSON.parse(intake.reference_photos_json) || []; } catch (_) { /* ignore */ }
  }
  const rel = photos[parseInt(req.params.idx, 10)];
  if (!rel) return res.status(404).send('Not found.');
  const abs = path.resolve(config.assetDir, rel);
  const root = path.resolve(config.assetDir, 'uploads', 'intake');
  if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) return res.status(404).send('Not found.');
  res.sendFile(abs);
});

module.exports = router;
