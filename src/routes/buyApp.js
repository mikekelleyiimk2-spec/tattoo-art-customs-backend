// Generic paid-sideload purchase pages (owner ruling 2026-10-14).
//
//   GET  /buy-app/:slug                 — purchase page
//   POST /buy-app/:slug/buy             — create order + PayPal checkout
//   GET  /buy-app/:slug/approve/:orderId — PayPal return: capture + mark paid
//   GET  /buy-app/:slug/download/:orderId — download page + update token
//
// Member flow follows the TAC Android Pro flow in routes/sideload.js
// (login → orders row → PayPal checkout → capture → paid → token
// download). GUEST flow (money-path fix 2026-10-15, mirroring the design
// guest checkout in routes/orders.js): a logged-out buyer checks out with
// just a delivery email — the order carries guest_email with the ''
// buyer sentinel (migration 089), the PayPal return URL carries an HMAC
// checkout token (lib/guestCheckout), and on capture the receipt +
// download-page link is emailed to the guest. The download page issues
// the buyer's update token (lib/updateTokens): the APK itself is served
// by the gated /api/apps/:package/apk?t=<token>, so future updates
// download automatically once the app has the code.
const express = require('express');
const db = require('../db');
const config = require('../config');
const pricing = require('../lib/pricing');
const paypal = require('../lib/paypal');
const updateTokens = require('../lib/updateTokens');
const guestCheckout = require('../lib/guestCheckout');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');

// slug -> { package, name, priceCents }
const APPS = {
  'odometer': { package: 'com.usefulappz.odometer', name: 'Odometer — Mileage Tracker', priceCents: 199 },
  'ai-button': { package: 'com.usefulappz.aibar', name: 'AI Button', priceCents: 999 },
  'muse-button': { package: 'com.usefulappz.musebar', name: 'Muse Button', priceCents: 99 },
  'chatgpt-button': { package: 'com.usefulappz.chatgptbar', name: 'ChatGPT Button', priceCents: 99 },
  'claude-button': { package: 'com.usefulappz.claudebar', name: 'Claude Button', priceCents: 99 },
  'copilot-button': { package: 'com.usefulappz.copilotbar', name: 'Copilot Button', priceCents: 99 },
  'deepseek-button': { package: 'com.usefulappz.deepseekbar', name: 'DeepSeek Button', priceCents: 99 },
  'gemini-button': { package: 'com.usefulappz.geminibar', name: 'Gemini Button', priceCents: 99 },
  'grok-button': { package: 'com.usefulappz.grokbar', name: 'Grok Button', priceCents: 99 },
  'perplexity-button': { package: 'com.usefulappz.perplexitybar', name: 'Perplexity Button', priceCents: 99 },
  'clipboard-bar': { package: 'com.usefulappz.clipboardbar', name: 'Clipboard Bar', priceCents: 99 },
  'countdown-bar': { package: 'com.usefulappz.countdownbar', name: 'Countdown Bar', priceCents: 99 },
};

function buyAppRouter() {
  const router = express.Router();

  // Resolve the slug for every /buy-app route; unknown slug -> 404.
  router.use('/:slug', (req, res, next) => {
    const app = APPS[req.params.slug];
    if (!app) {
      return res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
    }
    req.buyApp = app;
    req.buySlug = req.params.slug;
    return next();
  });

  router.get('/:slug', (req, res) => {
    const app = req.buyApp;
    res.render('site/buy-app', {
      title: `Get ${app.name} for Android`,
      metaDescription: `${app.name} for Android — $${(app.priceCents / 100).toFixed(2)}, sideload the APK. No Play Store needed.`,
      appName: app.name,
      price: app.priceCents,
      slug: req.buySlug,
      user: req.user || null,
    });
  });

  router.post('/:slug/buy', formLimiter, checkHoneypot, async (req, res) => {
    const app = req.buyApp;
    const slug = req.buySlug;
    // Guest checkout: no account required. The buyer's checkout email is
    // the delivery address (receipt + download-page link emailed there).
    const guest = !req.user;
    let guestEmail = null;
    if (guest) {
      guestEmail = guestCheckout.parseGuestEmail(req.body.guest_email);
      if (!guestEmail) {
        req.session.flash = 'Enter the email address your download should be delivered to.';
        return res.redirect(`/buy-app/${slug}`);
      }
    }
    const price = app.priceCents;
    const fee = pricing.processingFeeCents(price);
    const orderId = await db.insert('orders', {
      buyer_id: guest ? '' : req.user.id, order_type: `sideload:${app.package}`,
      amount_cents: price, fee_cents: fee, status: 'pending', payment_method: 'paypal',
      guest_email: guestEmail,
      created_at: db.now(),
    });
    try {
      const pp = await paypal.createCheckoutOrder({
        amountCents: price + fee,
        description: `${app.name} — Android App (Sideload)`,
        returnUrl: guest
          ? `${config.baseUrl}/buy-app/${slug}/approve/${orderId}?gt=${guestCheckout.guestToken(orderId, app.package)}`
          : `${config.baseUrl}/buy-app/${slug}/approve/${orderId}`,
        cancelUrl: `${config.baseUrl}/buy-app/${slug}`,
      });
      await db.update('orders', orderId, { paypal_order_id: pp.id });
      const approve = pp.links.find((l) => l.rel === 'approve');
      res.redirect(approve.href);
    } catch (e) {
      console.error(`buy-app ${slug} PayPal order create failed:`, e.message);
      req.session.flash = 'PayPal checkout is unavailable right now — try again later.';
      res.redirect(`/buy-app/${slug}`);
    }
  });

  // Shared gate for the approve + download routes: guest orders prove
  // ownership with the HMAC checkout token (?gt=); member orders need the
  // buyer's own login. Returns the order, or null after responding.
  async function loadBuyOrder(req, res, { paidOnly }) {
    const app = req.buyApp;
    const order = await db.get(
      `SELECT * FROM orders WHERE id = ? AND order_type = ?${paidOnly ? " AND status = 'paid'" : ''}`,
      [req.params.orderId, `sideload:${app.package}`]
    );
    if (!order) {
      res.status(paidOnly ? 403 : 404).render('error', {
        title: paidOnly ? 'Not available' : 'Not found',
        message: paidOnly ? 'This download is not available.' : 'Order not found.',
      });
      return null;
    }
    if (guestCheckout.isGuestOrder(order)) {
      if (guestCheckout.verifyGuestToken(req.query.gt, app.package) !== String(order.id)) {
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

  function downloadPath(req, order) {
    const base = `/buy-app/${req.buySlug}/download/${order.id}`;
    return guestCheckout.isGuestOrder(order)
      ? `${base}?gt=${encodeURIComponent(guestCheckout.guestToken(order.id, req.buyApp.package))}`
      : base;
  }

  router.get('/:slug/approve/:orderId', async (req, res) => {
    const app = req.buyApp;
    const slug = req.buySlug;
    const order = await loadBuyOrder(req, res, { paidOnly: false });
    if (!order) return;
    if (order.status === 'paid') return res.redirect(downloadPath(req, order));
    try {
      // lib/paypal's capture export is captureCheckoutOrder; captureOrder is
      // kept as a fallback alias name (the older sideload/ios flows use it).
      const captureFn = paypal.captureOrder || paypal.captureCheckoutOrder;
      const capture = await captureFn(order.paypal_order_id);
      const expectedTotal = order.amount_cents + order.fee_cents;
      const captured = Math.round(parseFloat(capture.purchase_units[0].payments.captures[0].amount.value) * 100);
      if (captured !== expectedTotal) throw new Error('Amount mismatch');
      await db.update('orders', order.id, { status: 'paid', paid_at: db.now() });
      if (guestCheckout.isGuestOrder(order)) {
        await guestCheckout.sendGuestAppReceipt({
          order, appName: app.name,
          downloadPageUrl: `${config.baseUrl}${downloadPath(req, order)}`,
        });
      }
      req.session.flash = 'Payment complete — your app download is ready.';
      res.redirect(downloadPath(req, order));
    } catch (e) {
      console.error(`buy-app ${slug} PayPal capture failed:`, e.message);
      req.session.flash = 'Payment could not be completed — try again.';
      res.redirect(`/buy-app/${slug}`);
    }
  });

  router.get('/:slug/download/:orderId', async (req, res) => {
    const app = req.buyApp;
    const order = await loadBuyOrder(req, res, { paidOnly: true });
    if (!order) return;
    const token = updateTokens.issue(order.id, app.package);
    res.render('site/buy-app-download', {
      title: `Download ${app.name} — Tattoo Art Customs`,
      appName: app.name,
      downloadUrl: `/api/apps/${app.package}/apk?t=${token}`,
      token,
      order,
    });
  });

  return router;
}

module.exports = { buyAppRouter, APPS };
