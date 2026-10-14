// Generic paid-sideload purchase pages (owner ruling 2026-10-14).
//
//   GET  /buy-app/:slug                 — purchase page
//   POST /buy-app/:slug/buy             — create order + PayPal checkout
//   GET  /buy-app/:slug/approve/:orderId — PayPal return: capture + mark paid
//   GET  /buy-app/:slug/download/:orderId — download page + update token
//
// Follows the TAC Android Pro flow in routes/sideload.js exactly (login →
// orders row → PayPal checkout → capture → paid → token download). The
// download page issues the buyer's update token (lib/updateTokens): the
// APK itself is served by the gated /api/apps/:package/apk?t=<token>, so
// future updates download automatically once the app has the code.
const express = require('express');
const db = require('../db');
const config = require('../config');
const pricing = require('../lib/pricing');
const paypal = require('../lib/paypal');
const updateTokens = require('../lib/updateTokens');
const { requireLogin } = require('../middleware/auth');
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

  router.post('/:slug/buy', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
    const app = req.buyApp;
    const slug = req.buySlug;
    const price = app.priceCents;
    const fee = pricing.processingFeeCents(price);
    const orderId = await db.insert('orders', {
      buyer_id: req.user.id, order_type: `sideload:${app.package}`,
      amount_cents: price, fee_cents: fee, status: 'pending', payment_method: 'paypal',
      created_at: db.now(),
    });
    try {
      const pp = await paypal.createCheckoutOrder({
        amountCents: price + fee,
        description: `${app.name} — Android App (Sideload)`,
        returnUrl: `${config.baseUrl}/buy-app/${slug}/approve/${orderId}`,
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

  router.get('/:slug/approve/:orderId', requireLogin, async (req, res) => {
    const app = req.buyApp;
    const slug = req.buySlug;
    const order = await db.get(
      'SELECT * FROM orders WHERE id = ? AND buyer_id = ? AND order_type = ?',
      [req.params.orderId, req.user.id, `sideload:${app.package}`]
    );
    if (!order) return res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
    if (order.status === 'paid') return res.redirect(`/buy-app/${slug}/download/${order.id}`);
    try {
      // lib/paypal's capture export is captureCheckoutOrder; captureOrder is
      // kept as a fallback alias name (the older sideload/ios flows use it).
      const captureFn = paypal.captureOrder || paypal.captureCheckoutOrder;
      const capture = await captureFn(order.paypal_order_id);
      const expectedTotal = order.amount_cents + order.fee_cents;
      const captured = Math.round(parseFloat(capture.purchase_units[0].payments.captures[0].amount.value) * 100);
      if (captured !== expectedTotal) throw new Error('Amount mismatch');
      await db.update('orders', order.id, { status: 'paid', paid_at: db.now() });
      req.session.flash = 'Payment complete — your app download is ready.';
      res.redirect(`/buy-app/${slug}/download/${order.id}`);
    } catch (e) {
      console.error(`buy-app ${slug} PayPal capture failed:`, e.message);
      req.session.flash = 'Payment could not be completed — try again.';
      res.redirect(`/buy-app/${slug}`);
    }
  });

  router.get('/:slug/download/:orderId', requireLogin, async (req, res) => {
    const app = req.buyApp;
    const order = await db.get(
      'SELECT * FROM orders WHERE id = ? AND buyer_id = ? AND order_type = ? AND status = \'paid\'',
      [req.params.orderId, req.user.id, `sideload:${app.package}`]
    );
    if (!order) return res.status(403).render('error', { title: 'Not available', message: 'This download is not available.' });
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
