// Brambleforce — iOS sideload sale door (owner orders 2026-11-01:
// the game sells on every storefront that will take it, iOS included,
// and the house already runs a proven iOS sideload route — /ios-app).
//
//   GET  /brambleforce/ios                        — purchase page ($6.99)
//   POST /brambleforce/ios/buy                    — order + PayPal checkout
//   GET  /brambleforce/ios/approve/:orderId       — PayPal return (capture)
//   GET  /brambleforce/ios/download/:orderId      — durable download page
//   GET  /brambleforce/ios/download/:orderId/file — the IPA bytes (gated)
//
// A sibling of routes/iosApp.js (same guest-checkout flow: guests buy
// with just a delivery email — '' buyer sentinel + HMAC checkout token,
// receipt + durable download-page link emailed on capture; members with
// their login). Orders carry order_type 'brambleforce_ios'.
//
// ONE structural difference from /ios-app, by design (spec:
// your_files/brambleforce-ios-sideload-2026-11-01.md §5): the IPA is
// ~635 MB and can NEVER sit on this service's 1 GB ephemeral disk, so
// the byte leg does not res.download() a local file. It resolves the
// registry entry for the iOS package key in src/data/app-updates.json
// (the same registry the Android build lives in) to its storageRef and
// answers through lib/storage.servePrivateFile (302 → 15-minute
// presigned R2 URL), exactly like the Android game's gated route.
// Version swaps = one R2 upload (POST /api/muse/upload-ios-update) +
// one registry flip; buyers re-download the current build from this
// same purchase page (the page is order-bound, not version-bound).
//
// Unlock honesty, identical to the Android sideload edition because it
// is the same game build: the IPA ships BF_VARIANT='sideload'. There
// is NO Apple IAP in it; the game's extra content is bought on this
// website's Brambleforce store and unlocked in-game with the issued
// code (/api/brambleforce/redeem). The purchase page says so plainly.
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const db = require('../db');
const config = require('../config');
const pricing = require('../lib/pricing');
const paypal = require('../lib/paypal');
const guestCheckout = require('../lib/guestCheckout');
const storage = require('../lib/storage');
const seatVerify = require('../lib/seatVerify');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');

const BF_IOS_PRICE_CENTS = 699;
const BF_IOS_NAME = 'Brambleforce — iOS (Sideload Edition)';
// Registry key in src/data/app-updates.json for the iOS build. The
// ".ios" suffix keeps it a distinct registry citizen from the Android
// package while staying inside the house com.usefulappz.* namespace.
const BF_IOS_PACKAGE = 'com.usefulappz.game2runandgun.ios';
const ORDER_TYPE = 'brambleforce_ios';
const GUEST_SCOPE = 'brambleforce_ios';

const guestDownloadPath = (order) =>
  `/brambleforce/ios/download/${order.id}?gt=${encodeURIComponent(guestCheckout.guestToken(order.id, GUEST_SCOPE))}`;
const downloadPath = (order) =>
  guestCheckout.isGuestOrder(order) ? guestDownloadPath(order) : `/brambleforce/ios/download/${order.id}`;

// Paid-download refusals land in the verify watch (cadence pass
// 2026-11-01): the gate verifies at every attempt, and a refused
// attempt is recorded behavior. Only the paidOnly (byte-serving)
// path logs — the checkout-return path shares this loader and its
// refusals are ordinary navigation, not download attempts.
async function iosGateRejected(req, reason) {
  await seatVerify.logEvent({
    kind: 'download_gate_rejected', detail: `brambleforce_ios:${reason}`,
    surface: 'brambleforce-ios', req,
  });
}

// Guest orders prove ownership with the HMAC token; member orders need
// the buyer's own login. Returns the order, or null after responding.
// (Same shape as routes/iosApp.js loadIosOrder.)
async function loadBfIosOrder(req, res, { paidOnly }) {
  const order = await db.get(
    `SELECT * FROM orders WHERE id = ? AND order_type = '${ORDER_TYPE}'${paidOnly ? " AND status = 'paid'" : ''}`,
    [req.params.orderId]
  );
  if (!order) {
    if (paidOnly) await iosGateRejected(req, 'order_not_paid_or_gone');
    res.status(paidOnly ? 403 : 404).render('error', {
      title: paidOnly ? 'Not available' : 'Not found',
      message: paidOnly ? 'This download is not available.' : 'Order not found.',
    });
    return null;
  }
  if (guestCheckout.isGuestOrder(order)) {
    if (guestCheckout.verifyGuestToken(req.query.gt, GUEST_SCOPE) !== String(order.id)) {
      if (paidOnly) await iosGateRejected(req, 'guest_token_mismatch');
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
    if (paidOnly) await iosGateRejected(req, 'buyer_mismatch');
    res.status(paidOnly ? 403 : 404).render('error', {
      title: paidOnly ? 'Not available' : 'Not found',
      message: paidOnly ? 'This download is not available.' : 'Order not found.',
    });
    return null;
  }
  return order;
}

// The iOS build's registry entry (storageRef → the private R2 object),
// read fresh per request like routes/appUpdates.js so a registry flip
// is a deploy-free version swap on the next hit after it lands.
function iosRegistryEntry() {
  const regPath = process.env.APP_UPDATES_REGISTRY
    || path.join(__dirname, '..', 'data', 'app-updates.json');
  try {
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    const entry = reg && typeof reg === 'object' ? reg[BF_IOS_PACKAGE] : null;
    return entry && typeof entry === 'object' ? entry : null;
  } catch (e) {
    return null;
  }
}

// Purchase page: the full game for iPhone, $6.99, sideload via
// SideStore. Carries the iOS disclosures in plain words BEFORE
// purchase (free-space, 7-day refresh, 3-app free-ID cap, no Apple
// IAP — extras are website unlock codes, same as Android sideload).
router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.render('site/brambleforce-ios', {homeFace: true, darkFace: true, bodyClass: 'page-dark',
    title: 'Brambleforce for iPhone — Sideload Edition',
    price: BF_IOS_PRICE_CENTS,
    user: req.user || null,
    metaDescription: 'Brambleforce for iPhone — $6.99, the full game, sideloaded with SideStore. No App Store needed.',
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
      return res.redirect('/brambleforce/ios');
    }
  }
  const price = BF_IOS_PRICE_CENTS;
  const fee = pricing.processingFeeCents(price);
  const orderId = await db.insert('orders', {
    buyer_id: guest ? '' : req.user.id, order_type: ORDER_TYPE,
    amount_cents: price, fee_cents: fee, status: 'pending', payment_method: 'paypal',
    guest_email: guestEmail,
    created_at: db.now(),
  });
  try {
    const pp = await paypal.createCheckoutOrder({
      amountCents: price + fee,
      description: BF_IOS_NAME,
      returnUrl: guest
        ? `${config.baseUrl}/brambleforce/ios/approve/${orderId}?gt=${guestCheckout.guestToken(orderId, GUEST_SCOPE)}`
        : `${config.baseUrl}/brambleforce/ios/approve/${orderId}`,
      cancelUrl: `${config.baseUrl}/brambleforce/ios`,
    });
    await db.update('orders', orderId, { paypal_order_id: pp.id });
    const approve = pp.links.find((l) => l.rel === 'approve');
    res.redirect(approve.href);
  } catch (e) {
    console.error('Brambleforce iOS PayPal order create failed:', e.message);
    req.session.flash = 'PayPal checkout is unavailable right now — try again later.';
    res.redirect('/brambleforce/ios');
  }
});

// PayPal return: capture payment (amount verified to the cent).
router.get('/approve/:orderId', async (req, res) => {
  const order = await loadBfIosOrder(req, res, { paidOnly: false });
  if (!order) return;
  if (order.status === 'paid') return res.redirect(downloadPath(order));
  try {
    const capture = await paypal.captureCheckoutOrder(order.paypal_order_id);
    const expectedTotal = order.amount_cents + order.fee_cents;
    const captured = Math.round(parseFloat(capture.purchase_units[0].payments.captures[0].amount.value) * 100);
    if (captured !== expectedTotal) {
      // Refused at the attempt AND recorded (cadence pass 2026-11-01).
      await seatVerify.logEvent({
        kind: 'fulfillment_mismatch',
        detail: `brambleforce_ios: captured ${captured} != expected ${expectedTotal} (order ${order.id})`,
        userId: order.buyer_id || null, req,
      });
      throw new Error('Amount mismatch');
    }
    await db.update('orders', order.id, { status: 'paid', paid_at: db.now() });
    try {
      await require('../lib/holidayRaffle').awardPurchaseEntries(
        await db.get('SELECT * FROM orders WHERE id = ?', [order.id]));
    } catch (e) { console.error('holiday raffle purchase entries failed:', e.message); }
    if (guestCheckout.isGuestOrder(order)) {
      await guestCheckout.sendGuestAppReceipt({
        order, appName: BF_IOS_NAME,
        downloadPageUrl: `${config.baseUrl}${downloadPath(order)}`,
      });
      // Guest bridge (owner ruling 2026-10-26, contract §10):
      // sideload buyers stay guests until the app is live on the
      // store — record the pending tie. Best-effort.
      await guestCheckout.bridgeGuestPurchase(order, GUEST_SCOPE);
    }
    req.session.flash = 'Payment complete — your Brambleforce iOS download is ready.';
    res.redirect(downloadPath(order));
  } catch (e) {
    console.error('Brambleforce iOS PayPal capture failed:', e.message);
    req.session.flash = 'Payment could not be completed — try again.';
    res.redirect('/brambleforce/ios');
  }
});

// Durable download page: the buyer's way back to the current build,
// forever. Each visit's Download button mints a fresh short-lived
// signed link (the byte leg below), so this page itself never expires.
router.get('/download/:orderId', async (req, res) => {
  const order = await loadBfIosOrder(req, res, { paidOnly: true });
  if (!order) return;
  const entry = iosRegistryEntry();
  const fileBase = `/brambleforce/ios/download/${order.id}/file`;
  const downloadUrl = guestCheckout.isGuestOrder(order)
    ? `${fileBase}?gt=${encodeURIComponent(guestCheckout.guestToken(order.id, GUEST_SCOPE))}`
    : fileBase;
  res.render('site/brambleforce-ios-download', {homeFace: true, darkFace: true, bodyClass: 'page-dark',
    title: 'Download Brambleforce for iPhone',
    downloadUrl,
    versionName: entry ? entry.versionName : null,
    sizeBytes: entry ? entry.sizeBytes : null,
    order,
  });
});

// The byte leg: paid-order gate first (same loader), then the registry
// entry's R2 ref through servePrivateFile — a 302 to a 15-minute
// presigned URL; the bytes stream from R2, never through this disk.
// If no build is registered yet, say so honestly instead of 404ing
// the buyer's page.
router.get('/download/:orderId/file', async (req, res) => {
  const order = await loadBfIosOrder(req, res, { paidOnly: true });
  if (!order) return;
  const entry = iosRegistryEntry();
  if (!entry || !entry.storageRef) {
    return res.status(503).render('error', {
      title: 'Build being staged',
      message: 'The current iPhone build is being staged right now. Your purchase is complete and this page stays yours — try the download again in a little while.',
    });
  }
  return storage.servePrivateFile(res, String(entry.storageRef), {
    downloadName: entry.ipaFile || 'Brambleforce.ipa',
  });
});

module.exports = router;
