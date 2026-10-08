// Free + paid sideload distribution routes. Owner order 2026-10-08.
// Lineup:
//   /little-inkers-ios      — Little Inkers iOS, FREE (kid-safe page, no tattoo links)
//   /little-inkers-android  — Little Inkers Android, FREE (kid-safe page)
//   /tac-android            — TAC Android free, FREE (regular site chrome)
//   /tac-android-pro        — TAC Android Pro, $1.99 paid (mirrors /ios-app PayPal flow)
// The $1.67 TAC iOS flow lives in routes/iosApp.js — untouched.
const express = require('express');
const db = require('../db');
const config = require('../config');
const pricing = require('../lib/pricing');
const paypal = require('../lib/paypal');
const { requireLogin } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { resolveStoredPath } = require('../lib/storage');

// app key -> file config. Keys match the `app` allowlist on
// POST /api/muse/upload-sideload.
const FREE_APPS = {
  'little-inkers-ios': {
    filename: 'little-inkers.ipa',
    envVar: 'LITTLE_INKERS_IPA_PATH',
    defaultRel: 'uploads/sideload/little-inkers.ipa',
    appName: 'Little Inkers',
    platform: 'ios',
    kidSafe: true,
  },
  'little-inkers-android': {
    filename: 'little-inkers.apk',
    envVar: 'LITTLE_INKERS_APK_PATH',
    defaultRel: 'uploads/sideload/little-inkers.apk',
    appName: 'Little Inkers',
    platform: 'android',
    kidSafe: true,
  },
  'tac-android': {
    filename: 'tac-android-free.apk',
    envVar: 'TAC_ANDROID_FREE_APK_PATH',
    defaultRel: 'uploads/sideload/tac-android-free.apk',
    appName: 'Tattoo Art Customs',
    platform: 'android',
    kidSafe: false,
  },
};

function serveFreeFile(appKey, res) {
  const cfg = FREE_APPS[appKey];
  const rel = process.env[cfg.envVar] || cfg.defaultRel;
  const absPath = resolveStoredPath(rel);
  if (!absPath) {
    return res.status(404).render('error', {
      title: 'Not ready',
      message: `The ${cfg.appName} app file is being prepared — check back soon.`,
    });
  }
  return res.download(absPath, cfg.filename);
}

// ---- Little Inkers free sideload (kid-safe layout, zero tattoo links) ----
function liSideloadRouter(kind) {
  const router = express.Router();
  const appKey = kind === 'ios' ? 'little-inkers-ios' : 'little-inkers-android';
  const cfg = FREE_APPS[appKey];

  router.get('/', (req, res) => {
    res.render('site/little-inkers-sideload', {
      layout: 'layout-li',
      title: `Little Inkers for ${kind === 'ios' ? 'iPhone' : 'Android'} — Free Download`,
      metaDescription: 'Download the free Little Inkers coloring app for kids.',
      kind,
      appName: cfg.appName,
    });
  });

  router.get('/download', (req, res) => serveFreeFile(appKey, res));

  return router;
}

// ---- TAC Android free ----
function tacAndroidFreeRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.render('site/tac-android-sideload', {
      title: 'Tattoo Art Customs for Android — Free Download',
      metaDescription: 'Get Tattoo Art Customs for Android free — sideload the APK. No Play Store needed.',
      user: req.user || null,
    });
  });

  router.get('/download', (req, res) => serveFreeFile('tac-android', res));

  return router;
}

// ---- TAC Android Pro ($1.99 paid — mirrors the /ios-app PayPal flow) ----
const PRO_PRICE_CENTS = 199;
const PRO_APP_NAME = 'Tattoo Art Customs Pro — Android App (Sideload)';

function tacAndroidProRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.render('site/tac-android-pro', {
      title: 'Get Tattoo Art Customs Pro for Android',
      metaDescription: 'Tattoo Art Customs Pro for Android — $1.99, no ads, sideload the APK.',
      price: PRO_PRICE_CENTS,
      user: req.user || null,
    });
  });

  router.post('/buy', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
    const price = PRO_PRICE_CENTS;
    const fee = pricing.processingFeeCents(price);
    const orderId = await db.insert('orders', {
      buyer_id: req.user.id, order_type: 'tac_android_pro',
      amount_cents: price, fee_cents: fee, status: 'pending', payment_method: 'paypal',
      created_at: db.now(),
    });
    try {
      const pp = await paypal.createCheckoutOrder({
        amountCents: price + fee,
        description: PRO_APP_NAME,
        returnUrl: `${config.baseUrl}/tac-android-pro/approve/${orderId}`,
        cancelUrl: `${config.baseUrl}/tac-android-pro`,
      });
      await db.update('orders', orderId, { paypal_order_id: pp.id });
      const approve = pp.links.find((l) => l.rel === 'approve');
      res.redirect(approve.href);
    } catch (e) {
      console.error('TAC Android Pro PayPal order create failed:', e.message);
      req.session.flash = 'PayPal checkout is unavailable right now — try again later.';
      res.redirect('/tac-android-pro');
    }
  });

  router.get('/approve/:orderId', requireLogin, async (req, res) => {
    const order = await db.get(
      "SELECT * FROM orders WHERE id = ? AND buyer_id = ? AND order_type = 'tac_android_pro'",
      [req.params.orderId, req.user.id]
    );
    if (!order) return res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
    if (order.status === 'paid') return res.redirect(`/tac-android-pro/download/${order.id}`);
    try {
      const capture = await paypal.captureOrder(order.paypal_order_id);
      const expectedTotal = order.amount_cents + order.fee_cents;
      const captured = Math.round(parseFloat(capture.purchase_units[0].payments.captures[0].amount.value) * 100);
      if (captured !== expectedTotal) throw new Error('Amount mismatch');
      await db.update('orders', order.id, { status: 'paid', paid_at: db.now() });
      // Pro-app perk registry (same as iOS sideload): record the verified Pro
      // purchase — unlocks the 6-month membership perk. Idempotent on the order.
      try {
        await require('../lib/proPurchases').recordProPurchase({
          userId: req.user.id, purchaseToken: `tac-android-pro-sideload:${order.id}`, platform: 'android',
        });
      } catch (e) { console.error('pro purchase record failed:', e.message); }
      req.session.flash = 'Payment complete — your Pro APK download is ready.';
      res.redirect(`/tac-android-pro/download/${order.id}`);
    } catch (e) {
      console.error('TAC Android Pro PayPal capture failed:', e.message);
      req.session.flash = 'Payment could not be completed — try again.';
      res.redirect('/tac-android-pro');
    }
  });

  router.get('/download/:orderId', requireLogin, async (req, res) => {
    const order = await db.get(
      "SELECT * FROM orders WHERE id = ? AND buyer_id = ? AND order_type = 'tac_android_pro' AND status = 'paid'",
      [req.params.orderId, req.user.id]
    );
    if (!order) return res.status(403).render('error', { title: 'Not available', message: 'This download is not available.' });
    const { issueDownloadToken } = require('../lib/fulfillment');
    const dl = await issueDownloadToken(order.id);
    res.render('site/tac-android-pro-download', {
      title: 'Download Pro APK — Tattoo Art Customs',
      downloadUrl: `/orders/download/${dl.token}?file=apk`,
      order,
    });
  });

  return router;
}

module.exports = { liSideloadRouter, tacAndroidFreeRouter, tacAndroidProRouter, FREE_APPS };
