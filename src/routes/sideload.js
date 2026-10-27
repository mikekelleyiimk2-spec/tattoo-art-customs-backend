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
const guestCheckout = require('../lib/guestCheckout');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { resolveStoredPath } = require('../lib/storage');
const testerPool = require('../lib/testerPool');
const fillCycle = require('../lib/fillCycle');

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
    const rel = process.env[cfg.envVar] || cfg.defaultRel;
    res.render('site/little-inkers-sideload', {
      layout: 'layout-li',
      title: `Little Inkers for ${kind === 'ios' ? 'iPhone' : 'Android'} — Free Download`,
      metaDescription: 'Download the free Little Inkers coloring app for kids.',
      kind,
      appName: cfg.appName,
      // Show the real download button only when the build file is
      // actually in storage — otherwise the page keeps its honest
      // "coming soon" card instead of promising a download that 404s.
      downloadReady: Boolean(resolveStoredPath(rel)),
      downloadUrl: `/little-inkers-${kind}/download`,
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

  // Guest checkout (money-path fix 2026-10-15, mirroring the design guest
  // checkout in routes/orders.js): guests buy with just a delivery email —
  // guest_email on the order, '' buyer sentinel (migration 089), HMAC
  // checkout token on the PayPal return URL, receipt + download-page link
  // emailed on capture. The member flow below is unchanged.
  const GUEST_SCOPE = 'tac_android_pro';
  const guestDownloadPath = (order) =>
    `/tac-android-pro/download/${order.id}?gt=${encodeURIComponent(guestCheckout.guestToken(order.id, GUEST_SCOPE))}`;
  const downloadPath = (order) =>
    guestCheckout.isGuestOrder(order) ? guestDownloadPath(order) : `/tac-android-pro/download/${order.id}`;

  // Guest orders prove ownership with the HMAC token; member orders need
  // the buyer's own login. Returns the order, or null after responding.
  async function loadProOrder(req, res, { paidOnly }) {
    const order = await db.get(
      `SELECT * FROM orders WHERE id = ? AND order_type = 'tac_android_pro'${paidOnly ? " AND status = 'paid'" : ''}`,
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

  router.post('/buy', formLimiter, checkHoneypot, async (req, res) => {
    const guest = !req.user;
    let guestEmail = null;
    if (guest) {
      guestEmail = guestCheckout.parseGuestEmail(req.body.guest_email);
      if (!guestEmail) {
        req.session.flash = 'Enter the email address your download should be delivered to.';
        return res.redirect('/tac-android-pro');
      }
    }
    const price = PRO_PRICE_CENTS;
    const fee = pricing.processingFeeCents(price);
    const orderId = await db.insert('orders', {
      buyer_id: guest ? '' : req.user.id, order_type: 'tac_android_pro',
      amount_cents: price, fee_cents: fee, status: 'pending', payment_method: 'paypal',
      guest_email: guestEmail,
      created_at: db.now(),
    });
    try {
      const pp = await paypal.createCheckoutOrder({
        amountCents: price + fee,
        description: PRO_APP_NAME,
        returnUrl: guest
          ? `${config.baseUrl}/tac-android-pro/approve/${orderId}?gt=${guestCheckout.guestToken(orderId, GUEST_SCOPE)}`
          : `${config.baseUrl}/tac-android-pro/approve/${orderId}`,
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

  router.get('/approve/:orderId', async (req, res) => {
    const order = await loadProOrder(req, res, { paidOnly: false });
    if (!order) return;
    if (order.status === 'paid') return res.redirect(downloadPath(order));
    try {
      const capture = await paypal.captureCheckoutOrder(order.paypal_order_id);
      const expectedTotal = order.amount_cents + order.fee_cents;
      const captured = Math.round(parseFloat(capture.purchase_units[0].payments.captures[0].amount.value) * 100);
      if (captured !== expectedTotal) throw new Error('Amount mismatch');
      await db.update('orders', order.id, { status: 'paid', paid_at: db.now() });
      // Pro-app perk registry (same as iOS sideload): record the verified Pro
      // purchase — unlocks the 6-month membership perk. Idempotent on the
      // order. Member orders only: guests have no account to attach it to.
      if (!guestCheckout.isGuestOrder(order)) {
        try {
          await require('../lib/proPurchases').recordProPurchase({
            userId: order.buyer_id, purchaseToken: `tac-android-pro-sideload:${order.id}`, platform: 'android',
          });
        } catch (e) { console.error('pro purchase record failed:', e.message); }
      } else {
        await guestCheckout.sendGuestAppReceipt({
          order, appName: 'Tattoo Art Customs Pro',
          downloadPageUrl: `${config.baseUrl}${downloadPath(order)}`,
        });
        // Guest bridge (owner ruling 2026-10-26, contract §10):
        // sideload buyers stay guests until the app is live on the
        // store — record the pending tie. Best-effort.
        await guestCheckout.bridgeGuestPurchase(order, GUEST_SCOPE);
      }
      req.session.flash = 'Payment complete — your Pro APK download is ready.';
      res.redirect(downloadPath(order));
    } catch (e) {
      console.error('TAC Android Pro PayPal capture failed:', e.message);
      req.session.flash = 'Payment could not be completed — try again.';
      res.redirect('/tac-android-pro');
    }
  });

  router.get('/download/:orderId', async (req, res) => {
    const order = await loadProOrder(req, res, { paidOnly: true });
    if (!order) return;
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

// ---- Tester Hub (canonical public URL) ----
// Owner order 2026-10-26: ONE memorable address every surface can
// link — "Wanna be a tester? Here, join our tester app." The APK
// bytes live in the app-updates store (uploaded via
// POST /api/muse/upload-sideload, app=com.usefulappz.testerhub) and
// are served by GET /api/apps/com.usefulappz.testerhub/apk.
//
// Fix-queue (everything audit 2026-10-26): the address itself is a
// real LANDING PAGE now, not a redirect stub — the printed URL on
// every social post was a closed door (the dopamine landing sat
// stranded at /testers). GET / renders the landing: tester-side
// face only, live pool count + light board from the same books the
// Hub reads, the ONE action (pool signup) wired to the pool machine
// (POST /join here, or POST /api/testers/signup from the page's JS —
// both land in testerPool.joinPool, source 'web'). The APK stays
// one tap away at GET /download, which keeps the old redirect.
function testerHubRouter() {
  const router = express.Router();

  router.get('/', async (req, res) => {
    let poolCount = 0;
    let board = { founding: true, tester: [], new_apps_today: 0 };
    let apps = [];
    try { poolCount = await testerPool.poolCount(); } catch (e) { /* page renders regardless */ }
    try { board = await fillCycle.lightBoard(8); } catch (e) { /* founding state stands */ }
    try { apps = (await testerPool.listApps()).slice(0, 6); } catch (e) { /* feed is a bonus, not the door */ }
    const errCode = ['gmail', 'name', 'other'].includes(req.query.error) ? req.query.error : null;
    res.render('site/tester-hub', {
      title: 'Become a Tester — First in Line | Tester Hub by Useful Appz',
      metaDescription: 'BECOME A TESTER — FIRST IN LINE TO TRY THE NEWEST APPS. One signup puts you first in line for every new app in the Tester Hub.',
      poolCount, board, apps,
      joined: req.query.joined === '1',
      joinError: errCode,
    });
  });

  // The old front-door behavior, kept as the download button's
  // target: one tap from the landing to the APK bytes.
  router.get('/download', (req, res) => {
    res.redirect(302, '/api/apps/com.usefulappz.testerhub/apk');
  });

  // The ONE action, no-JS path: a plain form post into the same
  // pool machine the Hub app uses (testerPool.joinPool). The page's
  // JS enhancement posts to POST /api/testers/signup instead; both
  // pipes end at the same table, so the wire is one wire.
  router.post('/join', formLimiter, checkHoneypot, async (req, res) => {
    try {
      const r = await testerPool.joinPool({
        name: req.body && req.body.name,
        gmail: req.body && req.body.gmail,
        source: 'web',
      });
      if (!r.ok) {
        const code = /gmail/i.test(r.error || '') ? 'gmail' : (/name/i.test(r.error || '') ? 'name' : 'other');
        return res.redirect(`/tester-hub?error=${code}#join`);
      }
      return res.redirect('/tester-hub?joined=1#join');
    } catch (e) {
      console.error('[tester-hub/join] failed:', e.message);
      return res.redirect('/tester-hub?error=other#join');
    }
  });

  return router;
}

// ---- UsefulAppz Folder (free sideload, canonical public URL) ----
// Same pattern as /tester-hub (owner order 2026-10-26: the Folder
// goes out side by side with the Tester Hub): the memorable front
// door redirects to the app-updates store bytes for
// com.usefulappz.folder, uploaded via POST /api/muse/upload-sideload.
function folderRouter() {
  const router = express.Router();
  router.get('/', (req, res) => {
    res.redirect(302, '/api/apps/com.usefulappz.folder/apk');
  });
  return router;
}

module.exports = { liSideloadRouter, tacAndroidFreeRouter, tacAndroidProRouter, testerHubRouter, folderRouter, FREE_APPS };
