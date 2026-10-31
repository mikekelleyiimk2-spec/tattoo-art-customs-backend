const express = require('express');
const router = express.Router();
const db = require('../db');
const config = require('../config');
const pricing = require('../lib/pricing');
const paypal = require('../lib/paypal');
const guestCheckout = require('../lib/guestCheckout');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');

const IOS_APP_PRICE_CENTS = 167;
const IOS_APP_NAME = 'Tattoo Art Customs — iOS App (Sideload)';

// Guest checkout (money-path fix 2026-10-15, Part 2 — mirroring the
// buy-app / TAC Android Pro guest flow in lib/guestCheckout): guests buy
// with just a delivery email — guest_email on the order, '' buyer
// sentinel (migration 089), HMAC checkout token on the PayPal return
// URL, receipt + download-page link emailed on capture. The download
// page issues the IPA download token (lib/fulfillment) per visit, so
// the emailed page link is durable while the IPA itself is never served
// on a public URL. The member flow below is unchanged.
const GUEST_SCOPE = 'ios_app';
const guestDownloadPath = (order) =>
  `/ios-app/download/${order.id}?gt=${encodeURIComponent(guestCheckout.guestToken(order.id, GUEST_SCOPE))}`;
const downloadPath = (order) =>
  guestCheckout.isGuestOrder(order) ? guestDownloadPath(order) : `/ios-app/download/${order.id}`;

// Guest orders prove ownership with the HMAC token; member orders need
// the buyer's own login. Returns the order, or null after responding.
async function loadIosOrder(req, res, { paidOnly }) {
  const order = await db.get(
    `SELECT * FROM orders WHERE id = ? AND order_type = 'ios_app'${paidOnly ? " AND status = 'paid'" : ''}`,
    [req.params.orderId]
  );
  if (!order) {
    res.status(paidOnly ? 403 : 404).render('error', {
      title: paidOnly ? 'Not available' : 'Not found',
      message: paidOnly ? 'This download is not available.' : 'Order not found.',
    });
    return null;
  }
  if (guestCheckout.isGuestOrder(order)) {
    if (guestCheckout.verifyGuestToken(req.query.gt, GUEST_SCOPE) !== String(order.id)) {
      res.status(403).render('error', {
        title: 'Invalid checkout link',
        message: 'This guest checkout link is not valid. Your download link is also emailed to you when payment completes.',
      });
      return null;
    }
    return order;
  }
  if (!req.user) {
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return null;
  }
  if (order.buyer_id !== req.user.id) {
    res.status(paidOnly ? 403 : 404).render('error', {
      title: paidOnly ? 'Not available' : 'Not found',
      message: paidOnly ? 'This download is not available.' : 'Order not found.',
    });
    return null;
  }
  return order;
}

// Purchase page for the iOS app ($1.67 via website, sideload IPA).
router.get('/', async (req, res) => {
  res.render('site/ios-app', {homeFace: true, darkFace: true, bodyClass: 'page-dark', 
    title: 'Get the iOS App — Tattoo Art Customs',
    price: IOS_APP_PRICE_CENTS,
    user: req.user || null,
    metaDescription: 'Get Tattoo Art Customs for iPhone — $1.67, sideload via SideStore. No App Store needed.',
  });
});

// Create order + PayPal checkout.
router.post('/buy', formLimiter, checkHoneypot, async (req, res) => {
  const guest = !req.user;
  let guestEmail = null;
  if (guest) {
    guestEmail = guestCheckout.parseGuestEmail(req.body.guest_email);
    if (!guestEmail) {
      req.session.flash = 'Enter the email address your download should be delivered to.';
      return res.redirect('/ios-app');
    }
  }
  const price = IOS_APP_PRICE_CENTS;
  const fee = pricing.processingFeeCents(price);
  const orderId = await db.insert('orders', {
    buyer_id: guest ? '' : req.user.id, order_type: 'ios_app',
    amount_cents: price, fee_cents: fee, status: 'pending', payment_method: 'paypal',
    guest_email: guestEmail,
    created_at: db.now(),
  });
  try {
    const pp = await paypal.createCheckoutOrder({
      amountCents: price + fee,
      description: IOS_APP_NAME,
      returnUrl: guest
        ? `${config.baseUrl}/ios-app/approve/${orderId}?gt=${guestCheckout.guestToken(orderId, GUEST_SCOPE)}`
        : `${config.baseUrl}/ios-app/approve/${orderId}`,
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
router.get('/approve/:orderId', async (req, res) => {
  const order = await loadIosOrder(req, res, { paidOnly: false });
  if (!order) return;
  if (order.status === 'paid') return res.redirect(downloadPath(order));
  try {
    const capture = await paypal.captureCheckoutOrder(order.paypal_order_id);
    const expectedTotal = order.amount_cents + order.fee_cents;
    // Verify captured amount matches.
    const captured = Math.round(parseFloat(capture.purchase_units[0].payments.captures[0].amount.value) * 100);
    if (captured !== expectedTotal) throw new Error('Amount mismatch');
    await db.update('orders', order.id, { status: 'paid', paid_at: db.now() });
    try {
      await require('../lib/holidayRaffle').awardPurchaseEntries(
        await db.get('SELECT * FROM orders WHERE id = ?', [order.id]));
    } catch (e) { console.error('holiday raffle purchase entries failed:', e.message); }
    if (guestCheckout.isGuestOrder(order)) {
      // Guests have no account: the receipt + token download-page link
      // goes out by email instead (same delivery as the member flow's
      // on-screen download page, carried to their inbox).
      await guestCheckout.sendGuestAppReceipt({
        order, appName: 'Tattoo Art Customs — iOS App',
        downloadPageUrl: `${config.baseUrl}${downloadPath(order)}`,
      });
      // Guest bridge (owner ruling 2026-10-26, contract §10):
      // sideload buyers stay guests until the app is live on the
      // store — record the pending tie. Best-effort.
      await guestCheckout.bridgeGuestPurchase(order, GUEST_SCOPE);
    } else {
      // Pro-app perk registry (owner directive 2026-10-05): the iOS sideload
      // buyer is known here (signed-in capture), so record the verified Pro
      // purchase — unlocks the 6-month membership perk. Idempotent on the
      // order (a re-hit of this endpoint re-uses the same token).
      try {
        await require('../lib/proPurchases').recordProPurchase({
          userId: order.buyer_id, purchaseToken: `ios-sideload:${order.id}`, platform: 'ios',
        });
      } catch (e) { console.error('pro purchase record failed:', e.message); }
    }
    req.session.flash = 'Payment complete — your iOS app download is ready.';
    res.redirect(downloadPath(order));
  } catch (e) {
    console.error('iOS app PayPal capture failed:', e.message);
    req.session.flash = 'Payment could not be completed — try again.';
    res.redirect('/ios-app');
  }
});

// Download page: serves the IPA via download token.
router.get('/download/:orderId', async (req, res) => {
  const order = await loadIosOrder(req, res, { paidOnly: true });
  if (!order) return;
  const { issueDownloadToken } = require('../lib/fulfillment');
  const dl = await issueDownloadToken(order.id);
  res.render('site/ios-app-download', {homeFace: true, darkFace: true, bodyClass: 'page-dark', 
    title: 'Download iOS App — Tattoo Art Customs',
    downloadUrl: `/orders/download/${dl.token}?file=ipa`,
    order,
  });
});

module.exports = router;
