// Gift card routes (mounted at /giftcards by the coordinator).
const express = require('express');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { money } = require('../lib/pricing');
const {
  GIFT_CARD_AMOUNTS, MIN_CUSTOM_CENTS, MAX_CUSTOM_CENTS,
  giftCardFees, giftCardReceiptLines,
  createPendingGiftCard, activateGiftCard, redeemGiftCard,
  getGiftCardsForShop, getGiftCardsForPurchaser,
} = require('./giftcards');
const db = require('../db');

const router = express.Router();

// --- Buy: amount picker + recipient email + fee preview ---
router.get('/buy', requireLogin, async (req, res) => {
  const shops = await db.all(
    "SELECT id, display_name FROM users WHERE role = 'tattoo_shop' ORDER BY display_name LIMIT 200");
  const def = 5000;
  const fees = giftCardFees(def);
  res.render('giftcards/buy', {
    title: 'Buy a Gift Card — Tattoo Art Customs',
    presets: GIFT_CARD_AMOUNTS, minCustom: MIN_CUSTOM_CENTS, maxCustom: MAX_CUSTOM_CENTS,
    shops, defaultFees: fees, money, metaDescription: 'Buy a Tattoo Art Customs gift card.',
  });
});

router.post('/buy', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  try {
    let amountCents;
    if (req.body.preset) amountCents = parseInt(req.body.preset, 10);
    else amountCents = Math.round(parseFloat(req.body.custom_amount || '0') * 100);
    const { pendingId, fees, approveUrl } = await createPendingGiftCard({
      purchaserUserId: req.user.id,
      amountCents,
      recipientEmail: req.body.recipient_email,
      shopUserId: req.body.shop_user_id || null,
    });
    req.session.gc_pending = pendingId;
    res.redirect(approveUrl);
  } catch (e) {
    req.session.flash = e.message;
    res.redirect('/giftcards/buy');
  }
});

// --- PayPal return: capture + activate + email the code ---
router.get('/capture/:pendingId', requireLogin, async (req, res) => {
  try {
    const { code, amount_cents, already } = await activateGiftCard({
      pendingId: req.params.pendingId,
      purchaserUserId: req.user.id,
      paypalOrderId: req.query.token,
    });
    delete req.session.gc_pending;
    res.render('giftcards/success', {
      title: 'Gift Card Ready — Tattoo Art Customs',
      code, amount: money(amount_cents), amount_cents, already: !!already,
    });
  } catch (e) {
    req.session.flash = 'Gift card activation failed: ' + e.message;
    res.redirect('/giftcards/buy');
  }
});

// --- Redeem against a booking (fee-free; full amount applies) ---
router.get('/redeem', requireLogin, async (req, res) => {
  const bookings = await db.all(
    `SELECT b.id, b.start_at, u.display_name AS shop_name
     FROM bookings b JOIN users u ON u.id = b.shop_user_id
     WHERE b.customer_user_id = ? AND b.status NOT IN ('cancelled', 'completed')
     ORDER BY b.start_at ASC LIMIT 50`, [req.user.id]);
  res.render('giftcards/redeem', {
    title: 'Redeem a Gift Card — Tattoo Art Customs',
    bookings, metaDescription: 'Redeem your Tattoo Art Customs gift card against a booking.',
  });
});

router.post('/redeem', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const { amount_cents } = await redeemGiftCard({
      code: req.body.code, bookingId: req.body.booking_id, customerUserId: req.user.id,
    });
    // Phase 2 owns booking balance application; the redeemed amount is
    // returned here for it to credit.
    const { notifyUser } = require('../lib/notify');
    await notifyUser(req.user.id, {
      kind: 'gift-card-redeemed', title: 'Gift card redeemed',
      body: `${money(amount_cents)} applied to your booking.`,
      link: `/journal#booking-${req.body.booking_id}`,
    });
    req.session.flash = `Gift card redeemed — ${money(amount_cents)} applied to your booking.`;
    res.redirect('/giftcards/redeem');
  } catch (e) {
    req.session.flash = e.message;
    res.redirect('/giftcards/redeem');
  }
});

// --- My purchased gift cards ---
router.get('/mine', requireLogin, async (req, res) => {
  const cards = await getGiftCardsForPurchaser(req.user.id);
  res.render('giftcards/mine', {
    title: 'My Gift Cards — Tattoo Art Customs', cards, money,
  });
});

// --- Shop view: gift-card sales for this shop ---
router.get('/shop', requireLogin, requireSubscription('tattoo_shop'), async (req, res) => {
  const cards = await getGiftCardsForShop(req.user.id);
  const sold = cards.filter((c) => c.status === 'active' || c.status === 'redeemed');
  const totalSold = sold.reduce((s, c) => s + c.amount_cents, 0);
  const redeemed = cards.filter((c) => c.status === 'redeemed');
  res.render('giftcards/shop', {
    title: 'Gift Card Sales — Tattoo Art Customs',
    cards, totalSold, redeemedCount: redeemed.length, money,
  });
});

// JSON fee preview for the amount picker (used by the buy page script).
router.get('/fees', requireLogin, async (req, res) => {
  const cents = parseInt(req.query.amount_cents, 10);
  if (!Number.isInteger(cents) || cents <= 0) return res.status(400).json({ ok: false });
  const f = giftCardFees(cents);
  const fmt = res.locals.fmtMoney || money;
  res.json({
    ok: true, base: f.base, platformFee: f.platformFee, processing: f.processing,
    total: f.total, lines: giftCardReceiptLines(f).map((l) => l),
    baseFmt: fmt(f.base), platformFeeFmt: fmt(f.platformFee),
    processingFmt: fmt(f.processing), totalFmt: fmt(f.total),
  });
});

module.exports = router;
