// Brambleforce website sale door (owner orders 2026-10-30: the
// completed game sells on our own doors FIRST — this website — at full
// price, every in-app purchase available; Google's door joins when
// Google catches up).
//
//   GET  /brambleforce                          — landing / storefront
//   GET  /brambleforce/buy/:productId           — buy page (game + 13 IAPs)
//   POST /brambleforce/buy/:productId/buy       — order + PayPal checkout
//   GET  /brambleforce/buy/:productId/approve/:orderId — PayPal return
//   GET  /brambleforce/buy/:productId/success/:orderId — durable purchase page
//   POST /api/brambleforce/redeem               — the game's REDEEM CODE call
//
// Checkout mirrors the fleet paid-sideload pattern (routes/buyApp.js):
// guests buy with just a delivery email ('' buyer sentinel + HMAC
// checkout token), members with their login. The game order carries
// order_type `sideload:<package>` so the gated app-updates route serves
// the APK; IAP orders carry `brambleforce:<product>` and mint a
// single-use unlock code at capture (lib/brambleforce).
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const pricing = require('../lib/pricing');
const paypal = require('../lib/paypal');
const updateTokens = require('../lib/updateTokens');
const guestCheckout = require('../lib/guestCheckout');
const bf = require('../lib/brambleforce');
const rolodex = require('../lib/rolodex');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');

const guestScope = (productId) => `brambleforce:${productId}`;

function partners() {
  // Penny Sweeper affiliate door: placements pulled LIVE from the
  // Affiliate Rolodex for this surface (whole entries — link + code +
  // disclosure travel together). Renders nothing until a program is
  // honestly placed on the BRAMBLEFORCE surface.
  try { return rolodex.queryLive({ surface: 'BRAMBLEFORCE' }); } catch (e) { return []; }
}

function resolveProduct(req, res, next) {
  const p = bf.product(req.params.productId);
  if (!p) {
    return res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  }
  req.bfProduct = p;
  req.bfProductId = req.params.productId;
  return next();
}

// Shared gate for approve + success: guest orders prove ownership with
// the HMAC checkout token (?gt=); member orders need the buyer's own
// login. Returns the order, or null after responding.
async function loadBfOrder(req, res, { paidOnly }) {
  const order = await db.get(
    `SELECT * FROM orders WHERE id = ? AND order_type = ?${paidOnly ? " AND status = 'paid'" : ''}`,
    [req.params.orderId, bf.orderType(req.bfProductId)]
  );
  if (!order) {
    res.status(paidOnly ? 403 : 404).render('error', {
      title: paidOnly ? 'Not available' : 'Not found',
      message: paidOnly ? 'This purchase page is not available.' : 'Order not found.',
    });
    return null;
  }
  if (guestCheckout.isGuestOrder(order)) {
    if (guestCheckout.verifyGuestToken(req.query.gt, guestScope(req.bfProductId)) !== String(order.id)) {
      res.status(403).render('error', {
        title: 'Invalid checkout link',
        message: 'This guest checkout link is not valid. Your purchase link is also emailed to you when payment completes.',
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
      message: paidOnly ? 'This purchase page is not available.' : 'Order not found.',
    });
    return null;
  }
  return order;
}

function successPath(req, order) {
  const base = `/brambleforce/buy/${req.bfProductId}/success/${order.id}`;
  return guestCheckout.isGuestOrder(order)
    ? `${base}?gt=${encodeURIComponent(guestCheckout.guestToken(order.id, guestScope(req.bfProductId)))}`
    : base;
}

async function buyerEmail(order) {
  if (guestCheckout.isGuestOrder(order)) return order.guest_email;
  const u = await db.get('SELECT email FROM users WHERE id = ?', [order.buyer_id]);
  return u ? u.email : null;
}

function pageRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.render('site/brambleforce', {
      title: 'Brambleforce — Run-and-Gun Through a Killer Garden',
      metaDescription: 'Brambleforce for Android — $6.99, 10 missions, 4 fighters, 11 bosses, zero ads. Buy direct and sideload the APK today.',
      products: bf.PRODUCTS,
      productIds: bf.PRODUCT_IDS,
      partners: partners(),
      disclosureStandard: rolodex.disclosureStandard(),
      user: req.user || null,
    });
  });

  router.get('/buy/:productId', resolveProduct, (req, res) => {
    const p = req.bfProduct;
    res.render('site/brambleforce-buy', {
      title: `Get ${p.name} — Brambleforce`,
      metaDescription: `${p.name} — $${(p.priceCents / 100).toFixed(2)}. ${p.blurb}`,
      product: p,
      productId: req.bfProductId,
      price: p.priceCents,
      partners: partners(),
      disclosureStandard: rolodex.disclosureStandard(),
      user: req.user || null,
    });
  });

  router.post('/buy/:productId/buy', resolveProduct, formLimiter, checkHoneypot, async (req, res) => {
    const p = req.bfProduct;
    const productId = req.bfProductId;
    const guest = !req.user;
    let guestEmail = null;
    if (guest) {
      guestEmail = guestCheckout.parseGuestEmail(req.body.guest_email);
      if (!guestEmail) {
        req.session.flash = 'Enter the email address your purchase should be delivered to.';
        return res.redirect(`/brambleforce/buy/${productId}`);
      }
    }
    const price = p.priceCents;
    const fee = pricing.processingFeeCents(price);
    const orderId = await db.insert('orders', {
      buyer_id: guest ? '' : req.user.id, order_type: bf.orderType(productId),
      amount_cents: price, fee_cents: fee, status: 'pending', payment_method: 'paypal',
      guest_email: guestEmail,
      created_at: db.now(),
    });
    try {
      const pp = await paypal.createCheckoutOrder({
        amountCents: price + fee,
        description: p.kind === 'game' ? p.name : `Brambleforce — ${p.name}`,
        returnUrl: guest
          ? `${config.baseUrl}/brambleforce/buy/${productId}/approve/${orderId}?gt=${guestCheckout.guestToken(orderId, guestScope(productId))}`
          : `${config.baseUrl}/brambleforce/buy/${productId}/approve/${orderId}`,
        cancelUrl: `${config.baseUrl}/brambleforce/buy/${productId}`,
      });
      await db.update('orders', orderId, { paypal_order_id: pp.id });
      const approve = pp.links.find((l) => l.rel === 'approve');
      res.redirect(approve.href);
    } catch (e) {
      console.error(`brambleforce ${productId} PayPal order create failed:`, e.message);
      req.session.flash = 'PayPal checkout is unavailable right now — try again later.';
      res.redirect(`/brambleforce/buy/${productId}`);
    }
  });

  router.get('/buy/:productId/approve/:orderId', resolveProduct, async (req, res) => {
    const p = req.bfProduct;
    const productId = req.bfProductId;
    const order = await loadBfOrder(req, res, { paidOnly: false });
    if (!order) return;
    if (order.status === 'paid') return res.redirect(successPath(req, order));
    try {
      const captureFn = paypal.captureOrder || paypal.captureCheckoutOrder;
      const capture = await captureFn(order.paypal_order_id);
      const expectedTotal = order.amount_cents + order.fee_cents;
      const captured = Math.round(parseFloat(capture.purchase_units[0].payments.captures[0].amount.value) * 100);
      if (captured !== expectedTotal) throw new Error('Amount mismatch');
      await db.update('orders', order.id, { status: 'paid', paid_at: db.now() });
      const email = await buyerEmail(order);
      const successUrl = `${config.baseUrl}${successPath(req, order)}`;
      if (p.kind === 'game') {
        await bf.sendGameEmail({ to: email, successUrl });
        if (guestCheckout.isGuestOrder(order)) {
          // Guest bridge (owner ruling 2026-10-26, contract section 10):
          // sideload buyers stay guests until the app is live on the
          // store — record the pending tie. Best-effort.
          await guestCheckout.bridgeGuestPurchase(order, bf.PACKAGE);
        }
        req.session.flash = 'Payment complete — your Brambleforce download is ready.';
        return res.redirect(successPath(req, order));
      }
      // IAP: mint the single-use unlock code and render the success
      // page WITH the code in this response — the raw code is shown
      // exactly once here (hash-only at rest) and emailed as the
      // durable copy.
      const issued = await bf.issueCodeForOrder(order, productId);
      if (issued.code) {
        await bf.sendCodeEmail({ to: email, productId, code: issued.code, successUrl });
      }
      return res.render('site/brambleforce-success', {
        title: `Unlock code — ${p.name}`,
        product: p,
        productId,
        code: issued.code || null,
        codeEmailed: Boolean(issued.code && email),
        order,
        user: req.user || null,
      });
    } catch (e) {
      console.error(`brambleforce ${productId} PayPal capture failed:`, e.message);
      req.session.flash = 'Payment could not be completed — try again.';
      return res.redirect(`/brambleforce/buy/${productId}`);
    }
  });

  // Durable purchase page. Game: re-mints the gated APK token on every
  // visit (the APK bytes are never on a public URL). IAP: the raw code
  // is hash-only at rest and cannot be re-shown — the page points the
  // buyer at their emailed copy.
  router.get('/buy/:productId/success/:orderId', resolveProduct, async (req, res) => {
    const p = req.bfProduct;
    const order = await loadBfOrder(req, res, { paidOnly: true });
    if (!order) return;
    const isGame = p.kind === 'game';
    const token = isGame ? updateTokens.issue(order.id, bf.PACKAGE) : null;
    res.render('site/brambleforce-success', {
      title: isGame ? 'Download Brambleforce' : `Your purchase — ${p.name}`,
      product: p,
      productId: req.bfProductId,
      code: null,
      codeEmailed: false,
      downloadUrl: isGame ? `/api/apps/${bf.PACKAGE}/apk?t=${token}` : null,
      token,
      order,
      user: req.user || null,
    });
  });

  return router;
}

// ---- redeem API (mounted under /api) ----------------------------------
// The game page runs on a file:///android_asset origin and POSTs JSON
// cross-origin, so this ONE endpoint carries its own scoped CORS
// headers (the site at large has none). Codes are single-use with a
// large guessing space; the limiter caps attempts per IP regardless.
const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10000 : 60,
  standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'rate_limited' }),
});

function redeemCors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
}

function apiRouter() {
  const router = express.Router();
  router.use('/brambleforce/redeem', redeemCors, redeemLimiter);
  router.post('/brambleforce/redeem', async (req, res) => {
    const code = req.body && typeof req.body.code === 'string' ? req.body.code : '';
    const result = await bf.redeemCode(code);
    return res.status(200).json(result);
  });
  return router;
}

module.exports = { pageRouter, apiRouter };
