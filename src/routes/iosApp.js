const express = require('express');
const router = express.Router();
const db = require('../db');
const config = require('../config');
const pricing = require('../lib/pricing');
const paypal = require('../lib/paypal');
const { requireLogin } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');

const IOS_APP_PRICE_CENTS = 167;
const IOS_APP_NAME = 'Tattoo Art Customs — iOS App (Sideload)';

// Purchase page for the iOS app ($1.67 via website, sideload IPA).
router.get('/', async (req, res) => {
  res.render('site/ios-app', {
    title: 'Get the iOS App — Tattoo Art Customs',
    price: IOS_APP_PRICE_CENTS,
    user: req.user || null,
    metaDescription: 'Get Tattoo Art Customs for iPhone — $1.67, sideload via SideStore. No App Store needed.',
  });
});

// Create order + PayPal checkout.
router.post('/buy', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const price = IOS_APP_PRICE_CENTS;
  const fee = pricing.processingFeeCents(price);
  const orderId = await db.insert('orders', {
    buyer_id: req.user.id, order_type: 'ios_app',
    amount_cents: price, fee_cents: fee, status: 'pending', payment_method: 'paypal',
    created_at: db.now(),
  });
  try {
    const pp = await paypal.createCheckoutOrder({
      amountCents: price + fee,
      description: IOS_APP_NAME,
      returnUrl: `${config.baseUrl}/ios-app/approve/${orderId}`,
      cancelUrl: `${config.baseUrl}/ios-app`,
    });
    await db.update('orders', orderId, { paypal_order_id: pp.id });
    const approve = pp.links.find((l) => l.rel === 'approve');
    res.redirect(approve.href);
  } catch (e) {
    console.error('iOS app PayPal order create failed:', e.message);
    req.session.flash = 'PayPal checkout is unavailable right now — try again later.';
    res.redirect('/ios-app');
  }
});

// PayPal return: capture payment.
router.get('/approve/:orderId', requireLogin, async (req, res) => {
  const order = await db.get(
    "SELECT * FROM orders WHERE id = ? AND buyer_id = ? AND order_type = 'ios_app'",
    [req.params.orderId, req.user.id]
  );
  if (!order) return res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
  if (order.status === 'paid') return res.redirect(`/ios-app/download/${order.id}`);
  try {
    const capture = await paypal.captureOrder(order.paypal_order_id);
    const expectedTotal = order.amount_cents + order.fee_cents;
    // Verify captured amount matches.
    const captured = Math.round(parseFloat(capture.purchase_units[0].payments.captures[0].amount.value) * 100);
    if (captured !== expectedTotal) throw new Error('Amount mismatch');
    await db.update('orders', order.id, { status: 'paid', paid_at: db.now() });
    // Pro-app perk registry (owner directive 2026-10-05): the iOS sideload
    // buyer is known here (signed-in capture), so record the verified Pro
    // purchase — unlocks the 6-month membership perk. Idempotent on the
    // order (a re-hit of this endpoint re-uses the same token).
    try {
      await require('../lib/proPurchases').recordProPurchase({
        userId: req.user.id, purchaseToken: `ios-sideload:${order.id}`, platform: 'ios',
      });
    } catch (e) { console.error('pro purchase record failed:', e.message); }
    req.session.flash = 'Payment complete — your iOS app download is ready.';
    res.redirect(`/ios-app/download/${order.id}`);
  } catch (e) {
    console.error('iOS app PayPal capture failed:', e.message);
    req.session.flash = 'Payment could not be completed — try again.';
    res.redirect('/ios-app');
  }
});

// Download page: serves the IPA via download token.
router.get('/download/:orderId', requireLogin, async (req, res) => {
  const order = await db.get(
    "SELECT * FROM orders WHERE id = ? AND buyer_id = ? AND order_type = 'ios_app' AND status = 'paid'",
    [req.params.orderId, req.user.id]
  );
  if (!order) return res.status(403).render('error', { title: 'Not available', message: 'This download is not available.' });
  const { issueDownloadToken } = require('../lib/fulfillment');
  const dl = await issueDownloadToken(order.id);
  res.render('site/ios-app-download', {
    title: 'Download iOS App — Tattoo Art Customs',
    downloadUrl: `/orders/download/${dl.token}?file=ipa`,
    order,
  });
});

module.exports = router;
