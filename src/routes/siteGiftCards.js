// Site-wide gift card routes (mounted at /gift-cards).
//
// Buy flow: amount picker ($25/$50/$75/$100/$150) -> pending row -> PayPal
// checkout -> /capture/:pendingId activates the card (code issued + emailed
// only after payment clears). When PayPal is unavailable the buyer is sent
// to a manual-payment page; an admin confirms the manual payment, which
// activates the card. Redeeming converts the card to site credit spendable
// on premades, customs, and memberships.
const express = require('express');
const { requireLogin } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { money } = require('../lib/pricing');
const {
  SITE_GIFT_CARD_AMOUNTS, SITE_GIFT_CARD_FEE_CENTS, SITE_GIFT_CARD_SHIPPING_CENTS,
  siteGiftCardQuote, createPendingSiteGiftCard, startSiteGiftCardCheckout,
  activateSiteGiftCard, redeemSiteGiftCard, getSiteGiftCardsForPurchaser,
} = require('../lib/siteGiftCards');
const db = require('../db');

const router = express.Router();

// --- Buy: amount picker + recipient + delivery options + fee preview ---
router.get('/buy', requireLogin, async (req, res) => {
  const def = 5000;
  res.render('site-giftcards/buy', {
    title: 'Buy a Gift Card — Tattoo Art Customs',
    presets: SITE_GIFT_CARD_AMOUNTS, fee: SITE_GIFT_CARD_FEE_CENTS,
    shipping: SITE_GIFT_CARD_SHIPPING_CENTS, defaultQuote: siteGiftCardQuote(def, false),
    money, metaDescription: 'Buy a Tattoo Art Customs gift card — $25 to $150, delivered by email or mail.',
  });
});

router.post('/buy', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const amountCents = parseInt(req.body.amount_cents, 10);
    const physical = req.body.delivery === 'mail';
    const { id } = await createPendingSiteGiftCard({
      purchaserUserId: req.user.id,
      amountCents,
      recipientEmail: req.body.recipient_email,
      recipientName: req.body.recipient_name,
      physical,
      shipAddress: req.body.ship_address,
    });
    try {
      const order = await startSiteGiftCardCheckout({ pendingId: id, purchaserUserId: req.user.id });
      return res.redirect(order.approveUrl);
    } catch (e) {
      // PayPal unavailable — fall back to manual payment (CashApp/Venmo),
      // same pattern as the orders buy flow.
      console.error('gift card PayPal checkout failed:', e.message);
      req.session.flash = 'PayPal checkout is unavailable right now — you can pay for the gift card manually below.';
      return res.redirect(`/gift-cards/manual/${id}`);
    }
  } catch (e) {
    req.session.flash = e.message;
    res.redirect('/gift-cards/buy');
  }
});

// --- PayPal return: capture + activate + email the code ---
router.get('/capture/:pendingId', requireLogin, async (req, res) => {
  try {
    const card = await activateSiteGiftCard({
      pendingId: req.params.pendingId,
      purchaserUserId: req.user.id,
      paypalOrderId: req.query.token,
    });
    res.render('site-giftcards/success', {
      title: 'Gift Card Ready — Tattoo Art Customs',
      card, code: card.code, money,
    });
  } catch (e) {
    req.session.flash = 'Gift card activation failed: ' + e.message;
    res.redirect('/gift-cards/buy');
  }
});

// --- Manual payment fallback (CashApp/Venmo), admin-confirmed ---
router.get('/manual/:pendingId', requireLogin, async (req, res) => {
  const card = await db.get('SELECT * FROM site_gift_cards WHERE id = ? AND purchaser_user_id = ?',
    [req.params.pendingId, req.user.id]);
  if (!card || card.status !== 'pending') return res.redirect('/gift-cards/buy');
  res.render('site-giftcards/manual', {
    title: 'Pay for gift card manually — Tattoo Art Customs', card, money,
  });
});

router.post('/manual/:pendingId', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const card = await db.get('SELECT * FROM site_gift_cards WHERE id = ? AND purchaser_user_id = ?',
    [req.params.pendingId, req.user.id]);
  if (!card || card.status !== 'pending') return res.redirect('/gift-cards/buy');
  const method = ['cashapp', 'venmo', 'paypal'].includes(req.body.method) ? req.body.method : 'manual';
  const note = String(req.body.note || '').trim().slice(0, 300);
  await db.update('site_gift_cards', card.id, { payment_method: method, manual_note: note || null });
  req.session.flash = 'Recorded. An admin will confirm your manual payment, then the gift card code will be emailed.';
  res.redirect('/gift-cards/mine');
});

// --- Redeem: code -> site credit ---
router.get('/redeem', requireLogin, async (req, res) => {
  res.render('site-giftcards/redeem', {
    title: 'Redeem a Gift Card — Tattoo Art Customs', money,
    metaDescription: 'Redeem your Tattoo Art Customs gift card as site credit for designs and memberships.',
  });
});

router.post('/redeem', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const card = await redeemSiteGiftCard({ userId: req.user.id, code: req.body.code });
    const { notifyUser } = require('../lib/notify');
    await notifyUser(req.user.id, {
      kind: 'gift-card-redeemed', title: 'Gift card redeemed',
      body: `${money(card.amount_cents)} in site credit added to your account.`,
      link: '/account',
    }).catch(() => {});
    req.session.flash = `Gift card redeemed — ${money(card.amount_cents)} in site credit added. Spend it on premade designs, customs, or a membership.`;
    res.redirect('/account');
  } catch (e) {
    req.session.flash = e.message;
    res.redirect('/gift-cards/redeem');
  }
});

// --- My purchased gift cards ---
router.get('/mine', requireLogin, async (req, res) => {
  const cards = await getSiteGiftCardsForPurchaser(req.user.id);
  res.render('site-giftcards/mine', {
    title: 'My Gift Cards — Tattoo Art Customs', cards, money,
  });
});

module.exports = router;
