// Shop toolkit routes (mounted at /toolkit).
//
// Shop pages require an active tattoo_shop subscription. Customer pages
// (waiver signing, autofill claim, aftercare response/photo) require login
// and ownership of the booking/checkin. Push + email only — no SMS anywhere.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const config = require('../config');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { money } = require('../lib/pricing');
const flow = require('./bookingFlow');
const waivers = require('./waivers');
const aftercare = require('./aftercare');
const autofill = require('./autofill');
const blasts = require('./blasts');
const attribution = require('./attribution');

const router = express.Router();
const shopOnly = [requireLogin, requireSubscription('tattoo_shop')];

function flash(req, msg) { req.session.flash = msg; }
function back(req, res, fallback, msg) {
  if (msg) flash(req, msg);
  res.redirect(req.get('referer') || fallback);
}
function fmtWhen(ms) {
  return new Date(Number(ms)).toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// Staged uploads for ID photos + healed photos.
function stagedUpload(dir, maxMb) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const d = path.join(config.uploadDir, dir);
        fs.mkdirSync(d, { recursive: true });
        cb(null, d);
      },
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 5) || '.jpg';
        cb(null, `tmp-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
      },
    }),
    limits: { fileSize: maxMb * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
      else cb(new Error('Only JPG, PNG, or WebP images are allowed.'));
    },
  });
}
const idUpload = stagedUpload('waiver-id-tmp', 5);
const healedUpload = stagedUpload('healed-tmp', 15);

// --- Waivers (shop) ----------------------------------------------------------
router.get('/waivers', ...shopOnly, async (req, res) => {
  const list = await waivers.getWaiversForShop(req.user.id);
  res.render('toolkit/waivers', {
    title: 'Waivers — Tattoo Art Customs',
    waivers: list, idCaptureConfigured: waivers.idCaptureConfigured(),
    flash: req.session.flash, money,
  });
  req.session.flash = null;
});

router.post('/waivers', ...shopOnly, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await waivers.createWaiver(req.user.id, {
      title: req.body.title, legalText: req.body.legal_text,
    });
    flash(req, 'Waiver template created.');
  } catch (e) { flash(req, 'Could not create waiver: ' + e.message); }
  res.redirect('/toolkit/waivers');
});

router.post('/waivers/:id', ...shopOnly, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const patch = { active: !!req.body.active };
    if (String(req.body.title || '').trim()) patch.title = req.body.title;
    if (String(req.body.legal_text || '').trim()) patch.legalText = req.body.legal_text;
    await waivers.updateWaiver(req.user.id, req.params.id, patch);
    flash(req, 'Waiver updated.');
  } catch (e) { flash(req, 'Could not update waiver: ' + e.message); }
  res.redirect('/toolkit/waivers');
});

// --- Waivers (customer signing) ----------------------------------------------
router.get('/waivers/sign/:bookingId', requireLogin, async (req, res) => {
  const booking = await db.get(
    `SELECT b.*, u.display_name AS shop_name FROM bookings b
     JOIN users u ON u.id = b.shop_user_id WHERE b.id = ?`, [req.params.bookingId]);
  if (!booking || String(booking.customer_user_id) !== String(req.user.id)) {
    return res.status(404).render('error', { title: 'Not found', message: 'Booking not found.' });
  }
  const waiver = await waivers.getActiveWaiver(booking.shop_user_id);
  if (!waiver) {
    return res.render('error', { title: 'No waiver', message: 'This shop has no active waiver to sign.' });
  }
  res.render('toolkit/waiver-sign', {
    title: `Sign waiver — ${booking.shop_name} — Tattoo Art Customs`,
    waiver, booking, idCaptureConfigured: waivers.idCaptureConfigured(), error: null, money,
  });
});

router.post('/waivers/sign/:bookingId', requireLogin, (req, res) => {
  idUpload.single('id_photo')(req, res, async (err) => {
    const booking = await db.get(
      `SELECT b.*, u.display_name AS shop_name FROM bookings b
       JOIN users u ON u.id = b.shop_user_id WHERE b.id = ?`, [req.params.bookingId]);
    const fail = async (message) => {
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
      const waiver = booking ? await waivers.getActiveWaiver(booking.shop_user_id) : null;
      if (!booking || !waiver) {
        return res.status(404).render('error', { title: 'Not found', message: 'Booking or waiver not found.' });
      }
      return res.status(400).render('toolkit/waiver-sign', {
        title: `Sign waiver — ${booking.shop_name} — Tattoo Art Customs`,
        waiver, booking, idCaptureConfigured: waivers.idCaptureConfigured(), error: message, money,
      });
    };
    try {
      if (err) throw err;
      if (!booking || String(booking.customer_user_id) !== String(req.user.id)) {
        return res.status(404).render('error', { title: 'Not found', message: 'Booking not found.' });
      }
      const waiver = await waivers.getActiveWaiver(booking.shop_user_id);
      if (!waiver) throw new Error('This shop has no active waiver to sign.');
      let idPhotoBuffer = null;
      if (req.file) idPhotoBuffer = fs.readFileSync(req.file.path);
      await waivers.signWaiver({
        waiverId: waiver.id, bookingId: booking.id, customerUserId: req.user.id,
        signerName: req.body.signer_name, signatureSvg: req.body.signature_svg,
        idPhotoBuffer,
      });
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
      flash(req, 'Waiver signed — see you at your appointment!');
      res.redirect('/bookings/manage');
    } catch (e) { await fail(e.message); }
  });
});

// --- Waivers (shop viewing a signature) ---------------------------------------
router.get('/waivers/s/:id', ...shopOnly, async (req, res) => {
  try {
    const sig = await waivers.getSignatureForShop(req.user.id, req.params.id);
    const booking = await db.get('SELECT start_at FROM bookings WHERE id = ?', [sig.booking_id]);
    res.render('toolkit/waiver-view', {
      title: 'Signed waiver — Tattoo Art Customs',
      sig, bookingStart: booking ? booking.start_at : null, money,
    });
  } catch (e) {
    res.status(404).render('error', { title: 'Not found', message: e.message });
  }
});

// Decrypts the ID photo in memory and streams it — never written to disk.
router.post('/waivers/s/:id/id-view', ...shopOnly, formLimiter, async (req, res) => {
  try {
    const buf = await waivers.getDecryptedIdDoc(req.user.id, req.params.id);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(404).render('error', { title: 'Not found', message: e.message });
  }
});

// --- Aftercare (shop) ----------------------------------------------------------
router.get('/aftercare', ...shopOnly, async (req, res) => {
  const tpl = await aftercare.getActiveTemplate(req.user.id);
  const checkins = await aftercare.getCheckinsForShop(req.user.id);
  const review = await aftercare.getReviewSettings(req.user.id);
  const askRow = await db.get(
    `SELECT COUNT(*) AS n FROM notifications n
     JOIN users u ON u.id = n.user_id
     WHERE n.kind = 'review-ask' AND n.link LIKE 'https%' AND EXISTS (
       SELECT 1 FROM aftercare_checkins ac
       WHERE ac.customer_user_id = n.user_id AND ac.shop_user_id = ?
     )`, [req.user.id]);
  const photos = await aftercare.getHealedPhotosForShop(req.user.id);
  res.render('toolkit/aftercare', {
    title: 'Aftercare autopilot — Tattoo Art Customs',
    tpl, checkins, review, reviewAsks: Number((askRow && askRow.n) || 0),
    photos, flash: req.session.flash, money,
  });
  req.session.flash = null;
});

router.post('/aftercare/template', ...shopOnly, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await aftercare.saveTemplate(req.user.id, { title: req.body.title, bodyMd: req.body.body_md });
    flash(req, 'Aftercare guide saved.');
  } catch (e) { flash(req, 'Could not save guide: ' + e.message); }
  res.redirect('/toolkit/aftercare');
});

router.post('/aftercare/review-settings', ...shopOnly, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await aftercare.saveReviewSettings(req.user.id, {
      googleReviewUrl: req.body.google_review_url, enabled: !!req.body.enabled,
    });
    flash(req, 'Review settings saved.');
  } catch (e) { flash(req, 'Could not save: ' + e.message); }
  res.redirect('/toolkit/aftercare');
});

// --- Aftercare (customer one-tap response) ------------------------------------
router.get('/aftercare/r/:checkinId', requireLogin, async (req, res) => {
  const ac = await db.get('SELECT * FROM aftercare_checkins WHERE id = ?', [req.params.checkinId]);
  if (!ac || String(ac.customer_user_id) !== String(req.user.id)) {
    return res.status(404).render('error', { title: 'Not found', message: 'Check-in not found.' });
  }
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [ac.shop_user_id]);
  const shopName = (shop && shop.display_name) || 'the shop';
  const r = String(req.query.r || '');
  let reviewUrl = null;
  if (['great', 'ok', 'concern'].includes(r) && ac.status !== 'responded') {
    try {
      const { reviewAsked } = await aftercare.respondToCheckin({
        checkinId: ac.id, customerUserId: req.user.id, response: r,
      });
      if (reviewAsked) {
        const rs = await aftercare.getReviewSettings(ac.shop_user_id);
        reviewUrl = rs && rs.google_review_url;
      }
    } catch (e) { /* fall through to the page */ }
    const fresh = await db.get('SELECT * FROM aftercare_checkins WHERE id = ?', [ac.id]);
    return res.render('toolkit/aftercare-respond', {
      title: `${shopName} — thanks! — Tattoo Art Customs`,
      checkin: fresh, shopName, alreadyResponded: true, reviewUrl, money,
    });
  }
  res.render('toolkit/aftercare-respond', {
    title: `${shopName} — how's the healing? — Tattoo Art Customs`,
    checkin: ac, shopName, alreadyResponded: ac.status === 'responded', reviewUrl: null, money,
  });
});

// --- Aftercare (customer healed-photo upload) -----------------------------------
router.get('/aftercare/photo/:checkinId', requireLogin, async (req, res) => {
  const ac = await db.get('SELECT * FROM aftercare_checkins WHERE id = ?', [req.params.checkinId]);
  if (!ac || String(ac.customer_user_id) !== String(req.user.id)) {
    return res.status(404).render('error', { title: 'Not found', message: 'Check-in not found.' });
  }
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [ac.shop_user_id]);
  res.render('toolkit/aftercare-photo', {
    title: 'Send a healed photo — Tattoo Art Customs',
    checkin: ac, shopName: (shop && shop.display_name) || 'the shop', money,
  });
});

router.post('/aftercare/photo/:checkinId', requireLogin, (req, res) => {
  healedUpload.single('photo')(req, res, async (err) => {
    try {
      if (err) throw err;
      if (!req.file) throw new Error('Choose a photo first.');
      const photoId = await aftercare.saveHealedPhoto({
        checkinId: req.params.checkinId, customerUserId: req.user.id,
        file: req.file, consentToPost: !!req.body.consent_to_post,
      });
      flash(req, 'Photo sent — thanks for sharing your healed ink!');
      res.redirect(`/toolkit/aftercare/r/${req.params.checkinId}`);
    } catch (e) {
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
      res.status(400).render('error', { title: 'Upload failed', message: e.message });
    }
  });
});

// --- Healed wall (shop) ----------------------------------------------------------
router.get('/healed', ...shopOnly, async (req, res) => {
  const photos = await aftercare.getHealedPhotosForShop(req.user.id);
  res.render('toolkit/healed', {
    title: 'Healed wall — Tattoo Art Customs',
    photos, flash: req.session.flash, money,
  });
  req.session.flash = null;
});

// Publish a consented healed photo to the community healed wall.
router.post('/healed/:photoId/publish', ...shopOnly, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const hp = await db.get('SELECT * FROM healed_photos WHERE id = ?', [req.params.photoId]);
    if (!hp || String(hp.shop_user_id) !== String(req.user.id)) throw new Error('Photo not found.');
    if (!Number(hp.consent_to_post)) throw new Error('The client did not consent to posting this photo.');
    if (Number(hp.posted_to_wall)) throw new Error('Already posted.');
    const ac = await db.get('SELECT booking_id FROM aftercare_checkins WHERE id = ?', [hp.checkin_id]);
    // Copy into the public photos dir (served at /img/photos).
    const photosDir = path.join(config.uploadDir, 'photos');
    fs.mkdirSync(photosDir, { recursive: true });
    const ext = path.extname(hp.image_path || '').toLowerCase().slice(0, 5) || '.jpg';
    const name = `healed-${hp.id}${ext}`;
    fs.copyFileSync(path.join(config.assetDir, hp.image_path), path.join(photosDir, name));
    const customer = await db.get('SELECT display_name FROM users WHERE id = ?', [hp.customer_user_id]);
    await db.insert('healed_posts', {
      customer_user_id: hp.customer_user_id,
      artist_user_id: null, shop_user_id: hp.shop_user_id, design_id: null,
      booking_id: ac ? ac.booking_id : null,
      photo_path: name,
      caption: `Healed work shared by ${(customer && customer.display_name) || 'a client'}.`,
      likes_count: 0, created_at: db.now(),
    });
    await db.update('healed_photos', hp.id, { posted_to_wall: 1 });
    flash(req, 'Posted to the healed wall.');
  } catch (e) { flash(req, 'Could not publish: ' + e.message); }
  res.redirect('/toolkit/healed');
});

// --- Cancellation auto-fill (shop) -----------------------------------------------
router.get('/autofill', ...shopOnly, async (req, res) => {
  const offers = await autofill.getOffersForShop(req.user.id);
  const settings = await flow.getBookingSettings(req.user.id);
  res.render('toolkit/autofill', {
    title: 'Cancellation auto-fill — Tattoo Art Customs',
    offers, settings, flash: req.session.flash, money,
  });
  req.session.flash = null;
});

router.post('/autofill/settings', ...shopOnly, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const patch = {
      autofill_enabled: req.body.autofill_enabled ? 1 : 0,
      autofill_audience: ['waitlist', 'waitlist+past'].includes(req.body.autofill_audience)
        ? req.body.autofill_audience : 'waitlist',
      autofill_expiry_minutes: Math.max(15, Math.min(1440, Number(req.body.autofill_expiry_minutes) || 120)),
    };
    await db.query(
      `UPDATE shop_booking_settings SET autofill_enabled = ?, autofill_audience = ?, autofill_expiry_minutes = ?
       WHERE shop_user_id = ?`,
      [patch.autofill_enabled, patch.autofill_audience, patch.autofill_expiry_minutes, req.user.id]);
    flash(req, 'Auto-fill settings saved.');
  } catch (e) { flash(req, 'Could not save: ' + e.message); }
  res.redirect('/toolkit/autofill');
});

// --- Auto-fill claim (customer) ------------------------------------------------------
router.get('/autofill/claim/:token', requireLogin, async (req, res) => {
  const offer = await db.get('SELECT * FROM slot_offers WHERE claim_token = ?', [String(req.params.token)]);
  const shopName = async (id) => {
    const s = await db.get('SELECT display_name FROM users WHERE id = ?', [id]);
    return (s && s.display_name) || 'the shop';
  };
  if (!offer) {
    return res.render('toolkit/autofill-claim', {
      title: 'Spot claim — Tattoo Art Customs', offer: null, shopName: '',
      state: 'expired', bookingUrl: null, money,
    });
  }
  if (offer.status === 'claimed') {
    const mine = String(offer.winner_customer_id) === String(req.user.id);
    return res.render('toolkit/autofill-claim', {
      title: 'Spot claim — Tattoo Art Customs', offer, shopName: await shopName(offer.shop_user_id),
      state: mine ? 'won' : 'lost',
      bookingUrl: mine ? `/bookings/shop/${offer.shop_user_id}?claim_start=${offer.start_at}&claim_end=${offer.end_at}` : null,
      money,
    });
  }
  if (offer.status !== 'open' || Number(offer.expires_at) <= Date.now()) {
    return res.render('toolkit/autofill-claim', {
      title: 'Spot claim — Tattoo Art Customs', offer, shopName: await shopName(offer.shop_user_id),
      state: 'expired', bookingUrl: null, money,
    });
  }
  res.render('toolkit/autofill-claim', {
    title: 'A spot just opened! — Tattoo Art Customs', offer,
    shopName: await shopName(offer.shop_user_id), state: 'claim', bookingUrl: null, money,
  });
});

router.post('/autofill/claim/:token', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const result = await autofill.claimOffer({ token: req.params.token, customerUserId: req.user.id });
    if (result.already) {
      if (result.mine) {
        flash(req, 'You already claimed this spot — continue to booking.');
        return res.redirect(`/bookings/shop/${result.offer.shop_user_id}?claim_start=${result.offer.start_at}&claim_end=${result.offer.end_at}`);
      }
      flash(req, 'Someone just claimed this spot.');
      return res.redirect(`/toolkit/autofill/claim/${req.params.token}`);
    }
    flash(req, `Spot claimed — ${fmtWhen(result.startAt)} at ${result.shopName}. Pick it on the calendar to finish booking.`);
    res.redirect(`/bookings/shop/${result.offer.shop_user_id}?claim_start=${result.startAt}&claim_end=${result.endAt}`);
  } catch (e) {
    flash(req, e.message);
    res.redirect(`/toolkit/autofill/claim/${req.params.token}`);
  }
});

// --- Slow-day blasts (shop) ------------------------------------------------------------
router.get('/blasts', ...shopOnly, async (req, res) => {
  const list = await blasts.getBlastsForShop(req.user.id);
  const used = await blasts.recentBlastCount(req.user.id);
  res.render('toolkit/blasts', {
    title: 'Slow-day blasts — Tattoo Art Customs',
    blasts: list, blastsLeft: Math.max(0, 2 - used),
    maxChars: blasts.BLAST_MAX_CHARS, flash: req.session.flash, money,
  });
  req.session.flash = null;
});

router.post('/blasts', ...shopOnly, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const { sent } = await blasts.sendBlast(req.user.id, req.body.message);
    flash(req, `Blast sent to ${sent} past client${sent === 1 ? '' : 's'}.`);
  } catch (e) { flash(req, 'Could not send blast: ' + e.message); }
  res.redirect('/toolkit/blasts');
});

// --- Marketplace attribution (shop) -------------------------------------------------------
router.get('/attribution', ...shopOnly, async (req, res) => {
  const stats = await attribution.getAttributionStats(req.user.id);
  res.json({ ok: true, stats });
});

// --- No-show enforcement (shop) ---------------------------------------------------------------
const noshow = require('./noshow');

router.get('/noshow', ...shopOnly, async (req, res) => {
  const holds = await noshow.getHoldsForShop(req.user.id);
  const settings = await flow.getBookingSettings(req.user.id);
  res.render('toolkit/noshow', {
    title: 'No-show enforcement — Tattoo Art Customs',
    holds,
    policy: {
      noshow_forfeit_deposit: Number(settings.noshow_forfeit_deposit) || 0,
      cancel_window_hours: Number(settings.cancel_window_hours) || 0,
      deposit_amount_cents: Number(settings.deposit_amount_cents) || 0,
    },
    autoChargeEnabled: config.autoChargeEnabled === true,
    paypalLive: !!(config.paypal && config.paypal.clientId && config.paypal.clientSecret),
    flash: req.session.flash, money,
  });
  req.session.flash = null;
});

router.post('/noshow/:bookingId/mark', ...shopOnly, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [req.params.bookingId]);
    if (!booking || String(booking.shop_user_id) !== String(req.user.id)) throw new Error('Booking not found.');
    await flow.markNoShow(booking.id); // existing: flips status, forfeits deposit row, notifies
    const settings = await flow.getBookingSettings(req.user.id);
    const fresh = await db.get('SELECT * FROM bookings WHERE id = ?', [booking.id]);
    await noshow.ensureHoldForBooking(fresh);
    const decision = noshow.evaluateForfeit(fresh, settings);
    await noshow.recordHoldDecision(booking.id, decision);
    flash(req, `Marked no-show. Hold decision: ${decision.outcome} (${decision.reason}).` +
      (config.autoChargeEnabled ? '' : ' Auto-collection is OFF — nothing was charged.'));
  } catch (e) { flash(req, 'Could not mark no-show: ' + e.message); }
  res.redirect('/toolkit/noshow');
});

// --- Payment plans (shop) ----------------------------------------------------------------------
const plans = require('./plans');

router.get('/plans', ...shopOnly, async (req, res) => {
  const list = await plans.getPlansForShop(req.user.id);
  const customers = await db.all(
    `SELECT DISTINCT u.id, u.display_name FROM users u
     JOIN bookings b ON b.customer_user_id = u.id
     WHERE b.shop_user_id = ? ORDER BY u.display_name LIMIT 200`, [req.user.id]);
  res.render('toolkit/plans', {
    title: 'Payment plans — Tattoo Art Customs',
    plans: list, customers,
    paypalLive: !!(config.paypal && config.paypal.clientId && config.paypal.clientSecret),
    flash: req.session.flash, money,
  });
  req.session.flash = null;
});

router.post('/plans', ...shopOnly, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const totalCents = Math.round(Number(req.body.total_dollars) * 100);
    const firstDue = Date.parse(req.body.first_due_at);
    const { planId } = await plans.createPlan(req.user.id, req.body.customer_id, {
      bookingId: req.body.booking_id || null,
      title: req.body.title, totalCents,
      sessionsCount: Number(req.body.sessions_count),
      firstDueAt: Number.isFinite(firstDue) ? firstDue : Date.now() + 30 * 86400000,
    });
    flash(req, 'Payment plan created.');
    return res.redirect(`/toolkit/plans/${planId}`);
  } catch (e) { flash(req, 'Could not create plan: ' + e.message); }
  res.redirect('/toolkit/plans');
});

router.get('/plans/:planId', requireLogin, async (req, res) => {
  try {
    const isShop = await hasShopSub(req.user.id);
    const viewerRole = isShop ? 'shop' : 'customer';
    const { plan, installments } = await plans.getPlanDetail(req.params.planId, req.user.id, viewerRole);
    const other = viewerRole === 'shop'
      ? await db.get('SELECT display_name FROM users WHERE id = ?', [plan.customer_user_id])
      : await db.get('SELECT display_name FROM users WHERE id = ?', [plan.shop_user_id]);
    res.render('toolkit/plan-detail', {
      title: `${plan.title} — Tattoo Art Customs`,
      plan: { ...plan, customer_name: viewerRole === 'shop' ? (other && other.display_name) : undefined,
              shop_name: viewerRole === 'customer' ? (other && other.display_name) : undefined },
      installments, viewerRole, money,
    });
  } catch (e) {
    res.status(404).render('error', { title: 'Not found', message: e.message });
  }
});

router.post('/plans/:planId/waive/:seq', ...shopOnly, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await plans.waiveInstallment(req.params.planId, req.params.seq, req.user.id);
    flash(req, 'Installment waived.');
  } catch (e) { flash(req, 'Could not waive: ' + e.message); }
  res.redirect(`/toolkit/plans/${req.params.planId}`);
});

router.post('/plans/:planId/cancel', ...shopOnly, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await plans.cancelPlan(req.params.planId, req.user.id);
    flash(req, 'Plan cancelled.');
  } catch (e) { flash(req, 'Could not cancel: ' + e.message); }
  res.redirect(`/toolkit/plans/${req.params.planId}`);
});

// Customer view of their own plans.
router.get('/my-plans', requireLogin, async (req, res) => {
  const list = await plans.getPlansForCustomer(req.user.id);
  res.render('toolkit/plans', {
    title: 'My payment plans — Tattoo Art Customs',
    plans: list, customers: [], paypalLive: false, flash: req.session.flash, money,
  });
  req.session.flash = null;
});

async function hasShopSub(userId) {
  const { hasActiveSubscription } = require('../middleware/auth');
  try { return await hasActiveSubscription(userId, 'tattoo_shop'); }
  catch (_) { return false; }
}

module.exports = router;
