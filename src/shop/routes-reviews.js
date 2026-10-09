// Review request automation routes (mounted at /shop/reviews by the coordinator).
//
// Mount lines the coordinator adds in src/index.js:
//   app.use('/shop/reviews', require('./shop/routes-reviews'));
//
// NOTE: review SETTINGS (Google review URL + enabled) live in the same
// shop_review_settings row the aftercare review machine uses (migration
// 051); storage is owned by src/shop/aftercare.js. The toolkit aftercare
// page (/toolkit/aftercare) edits the same row — this page is a second
// window into it, not a competing store.
const express = require('express');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const {
  getSettings, saveSettings, getEligibleBookings, getSentLog, sendReviewRequest,
} = require('./reviewRequests');

const router = express.Router();
const SHOP = requireSubscription('tattoo_shop');

// Shop: review settings + completed bookings ready for a request + recent
// sent log (all sources, including the aftercare 'great' ask).
router.get('/', requireLogin, SHOP, async (req, res) => {
  const reviewSettings = await getSettings(req.user.id);
  const eligible = await getEligibleBookings(req.user.id);
  const log = await getSentLog(req.user.id);
  res.render('shop/reviews/settings', {
    title: 'Review Requests — Tattoo Art Customs',
    reviewSettings, eligible, log: log.slice(0, 20),
  });
});

// Shop: full sent-request log (all sources).
router.get('/log', requireLogin, SHOP, async (req, res) => {
  const log = await getSentLog(req.user.id);
  res.render('shop/reviews/log', {
    title: 'Sent Review Requests — Tattoo Art Customs', log,
  });
});

// Shop: save review settings (same row as the aftercare review machine).
router.post('/settings', requireLogin, SHOP, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await saveSettings(req.user.id, {
      googleReviewUrl: req.body.google_review_url,
      enabled: req.body.enabled === '1' || req.body.enabled === 'on',
    });
    req.session.flash = 'Review settings saved.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect('/shop/reviews');
});

// Shop: manually trigger a review request for one completed booking.
// Idempotent across sources: when the aftercare 'great' ask (or any other
// ask) already went out for this booking, no second email is sent.
router.post('/send/:bookingId', requireLogin, SHOP, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const result = await sendReviewRequest({
      shopUserId: req.user.id, bookingId: req.params.bookingId,
    });
    req.session.flash = result.already
      ? 'This customer was already asked for a review — no duplicate sent.'
      : 'Review request sent.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect('/shop/reviews');
});

module.exports = router;
