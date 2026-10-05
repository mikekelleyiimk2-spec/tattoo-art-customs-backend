// Tap-to-pay standalone subscriptions — shops only, billed separately from
// the shop membership. Mirrors the PayPal subscription flow in
// src/routes/memberships.js: create → approve → webhook activates;
// cancel/failed → suspended (bill current = service active).
const express = require('express');
const db = require('../db');
const config = require('../config');
const paypal = require('../lib/paypal');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { TIERS, getTapSub } = require('../lib/tapBilling');

const router = express.Router();

// Start a tap-to-pay subscription for one tier. Shops only.
router.post('/subscribe/:tier', requireLogin, requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  const tier = TIERS[req.params.tier];
  if (!tier) return res.status(404).render('error', { title: 'Not found', message: 'Unknown tap tier.' });
  if (!config.paypalTapPlansConfigured()) {
    req.session.flash = 'Tap-to-pay billing is being set up — please try again shortly.';
    return res.redirect('/tap-to-pay');
  }
  // Idempotency: never stack duplicate tap subscriptions.
  const existing = await getTapSub(req.user.id);
  if (existing) {
    req.session.flash = 'You already have tap-to-pay billing — manage it on your shop dashboard.';
    return res.redirect('/shop');
  }
  try {
    const sub = await paypal.createSubscription({
      planKey: tier.planKey,
      returnUrl: `${config.baseUrl}/tap/approve`,
      cancelUrl: `${config.baseUrl}/tap-to-pay`,
    });
    const approve = sub.links.find((l) => l.rel === 'approve');
    const subId = await db.insert('shop_tap_subscriptions', {
      shop_user_id: req.user.id, tier: req.params.tier, status: 'pending',
      paypal_subscription_id: sub.id,
    });
    req.session.pendingTapSub = subId;
    res.redirect(approve.href);
  } catch (e) {
    // Never leak raw provider errors to the page.
    console.error('tap subscribe failed:', e.message);
    req.session.flash = 'Checkout is unavailable right now — please try again in a moment.';
    res.redirect('/tap-to-pay');
  }
});

// PayPal returns here after the buyer approves.
router.get('/approve', requireLogin, async (req, res) => {
  const subId = req.session.pendingTapSub;
  delete req.session.pendingTapSub;
  if (!subId) return res.redirect('/shop');
  const sub = await db.get('SELECT * FROM shop_tap_subscriptions WHERE id = ?', [subId]);
  if (!sub || sub.shop_user_id !== req.user.id) return res.redirect('/shop');
  try {
    const remote = await paypal.getSubscription(sub.paypal_subscription_id);
    const status = (remote.status || '').toLowerCase();
    // Only a PayPal-confirmed ACTIVE subscription activates tap billing.
    if (status === 'active') {
      const now = Date.now();
      await db.update('shop_tap_subscriptions', sub.id, {
        status: 'active', current_period_start: now,
        current_period_end: now + 30 * 86400000, updated_at: now,
      });
      req.session.flash = 'Tap-to-pay billing is active.';
    } else {
      req.session.flash = 'Payment not completed yet — your tap billing is still pending.';
    }
  } catch (e) {
    console.error('tap approve check failed:', e.message);
    req.session.flash = 'Could not confirm payment — check back shortly.';
  }
  res.redirect('/shop');
});

// Cancel (at PayPal + locally). Service runs to the end of the paid period.
router.post('/cancel', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const sub = await getTapSub(req.user.id);
  if (!sub) return res.redirect('/shop');
  try {
    if (sub.paypal_subscription_id) await paypal.cancelSubscription(sub.paypal_subscription_id);
  } catch (e) { /* still cancel locally */ }
  const now = db.now();
  await db.update('shop_tap_subscriptions', sub.id, { status: 'canceled', canceled_at: now, updated_at: now });
  req.session.flash = 'Tap-to-pay billing canceled. Per the Terms, memberships are final and non-refundable.';
  res.redirect('/shop');
});

module.exports = router;
