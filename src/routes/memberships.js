// Memberships via PayPal Subscriptions.
// Plans: Customer $5/mo, Design Artist $5/mo, Tattoo Shop $99.99/yr.
// An active subscription grants the matching role; canceling/expiry
// reverts the user to customer (admin never changes).
const express = require('express');
const db = require('../db');
const config = require('../config');
const paypal = require('../lib/paypal');
const { requireLogin } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');

const router = express.Router();
const PLAN_KEY_BY_SLUG = { customer: 'customer', design_artist: 'artist', tattoo_shop: 'shop' };
const ROLE_BY_SLUG = { design_artist: 'design_artist', tattoo_shop: 'tattoo_shop' };

router.get('/', requireLogin, async (req, res) => {
  const plans = await db.all('SELECT * FROM plans WHERE active = 1 ORDER BY price_cents');
  const subs = await db.all(
    `SELECT s.*, p.slug AS plan_slug, p.name AS plan_name FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id WHERE s.user_id = ? ORDER BY s.created_at DESC`,
    [req.user.id]);
  res.render('membership/plans', {
    title: 'Membership — Tattoo Art Customs',
    plans, subs, paypalReady: config.paypalPlansConfigured(),
    metaDescription: 'Tattoo Art Customs membership plans.',
  });
});

// Start a PayPal subscription for a plan.
router.post('/subscribe/:slug', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const plan = await db.get('SELECT * FROM plans WHERE slug = ? AND active = 1', [req.params.slug]);
  if (!plan) return res.status(404).render('error', { title: 'Not found', message: 'Unknown plan.' });
  try {
    const sub = await paypal.createSubscription({
      planKey: PLAN_KEY_BY_SLUG[plan.slug],
      returnUrl: `${config.baseUrl}/membership/approve?plan=${plan.slug}`,
      cancelUrl: `${config.baseUrl}/membership`,
    });
    const approve = sub.links.find((l) => l.rel === 'approve');
    const subId = await db.insert('subscriptions', {
      user_id: req.user.id, plan_id: plan.id, status: 'pending',
      paypal_subscription_id: sub.id, created_at: db.now(),
    });
    req.session.pendingSub = subId;
    res.redirect(approve.href);
  } catch (e) {
    req.session.flash = e.message;
    res.redirect('/membership');
  }
});

// PayPal returns here after the buyer approves.
router.get('/approve', requireLogin, async (req, res) => {
  const subId = req.session.pendingSub;
  delete req.session.pendingSub;
  if (!subId) return res.redirect('/membership');
  const sub = await db.get(
    `SELECT s.*, p.slug AS plan_slug FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id WHERE s.id = ?`, [subId]);
  if (!sub || sub.user_id !== req.user.id) return res.redirect('/membership');
  try {
    const remote = await paypal.getSubscription(sub.paypal_subscription_id);
    const status = (remote.status || '').toLowerCase();
    if (status === 'active' || status === 'approval_pending') {
      await db.update('subscriptions', sub.id, {
        status: 'active',
        current_period_end: remote.billing_info?.next_billing_time
          ? Date.parse(remote.billing_info.next_billing_time) : null,
      });
      // Role comes from the stored subscription's plan — never from query params.
      await grantPlanRole(sub.user_id, sub.plan_slug);
      req.session.flash = 'Membership active — welcome!';
    } else {
      await db.update('subscriptions', sub.id, { status: 'pending' });
      req.session.flash = 'Subscription approval is still pending with PayPal.';
    }
  } catch (e) {
    req.session.flash = 'Could not confirm the subscription: ' + e.message;
  }
  res.redirect('/membership');
});

// Grants the role matching a plan slug; creates artist/shop profiles.
// Idempotent — safe to call from both /approve and the webhook.
async function grantPlanRole(userId, planSlug) {
  const role = ROLE_BY_SLUG[planSlug];
  if (!role) return;
  const user = await db.get('SELECT role FROM users WHERE id = ?', [userId]);
  if (!user || user.role === 'admin') return;
  await db.update('users', userId, { role });
  if (role === 'design_artist') {
    await db.upsert('artist_profiles', 'user_id', { user_id: userId, created_at: db.now() });
  }
  if (role === 'tattoo_shop') {
    await db.upsert('shop_profiles', 'user_id', {
      user_id: userId, referral_code: makeReferralCode(), created_at: db.now(),
    });
  }
}

function makeReferralCode() {
  return 'TAC-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Cancel (at PayPal + locally).
router.post('/cancel/:id', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const sub = await db.get('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!sub) return res.redirect('/membership');
  try {
    if (sub.paypal_subscription_id) await paypal.cancelSubscription(sub.paypal_subscription_id);
  } catch (e) { /* still cancel locally */ }
  await db.update('subscriptions', sub.id, { status: 'canceled', canceled_at: db.now() });
  // Revert role to customer unless another active sub grants a role.
  const other = await db.get(
    `SELECT p.slug FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = ? AND s.status = 'active' AND s.id != ?`, [req.user.id, sub.id]);
  if (!other && req.user.role !== 'admin') {
    await db.update('users', req.user.id, { role: 'customer' });
  }
  req.session.flash = 'Membership canceled. Per the Terms, memberships are final and non-refundable.';
  res.redirect('/membership');
});

// PayPal webhook: subscription activated / cancelled / expired / payment failed.
// Events are signature-verified when PayPal credentials + webhook ID are set.
router.post('/webhook', async (req, res) => {
  try {
    if (config.paypalConfigured() && config.paypal.webhookId) {
      const ok = await paypal.verifyWebhookSignature({
        transmissionId: req.get('paypal-transmission-id'),
        timestamp: req.get('paypal-transmission-time'),
        webhookId: config.paypal.webhookId,
        eventBody: req.body,
        certUrl: req.get('paypal-cert-url'),
        authAlgo: req.get('paypal-auth-algo'),
        transmissionSig: req.get('paypal-transmission-sig'),
      });
      if (!ok) {
        console.error('PayPal webhook signature verification FAILED');
        return res.sendStatus(401);
      }
    } else {
      console.warn('PayPal webhook received but PAYPAL_WEBHOOK_ID is not configured — event accepted unverified (dev only).');
    }
    const event = req.body;
    const resource = event.resource || {};
    const paypalSubId = resource.id || resource.billing_agreement_id;
    if (!paypalSubId) return res.sendStatus(200);
    const sub = await db.get(
      `SELECT s.*, p.slug AS plan_slug FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.paypal_subscription_id = ?`, [paypalSubId]);
    if (!sub) return res.sendStatus(200);
    const type = event.event_type || '';
    if (type.includes('ACTIVATED')) {
      await db.update('subscriptions', sub.id, { status: 'active' });
      // Grant the role here too — the buyer may never return via /approve.
      await grantPlanRole(sub.user_id, sub.plan_slug);
    } else if (type.includes('CANCELLED') || type.includes('EXPIRED')) {
      await db.update('subscriptions', sub.id, { status: 'canceled', canceled_at: db.now() });
      const user = await db.get('SELECT role FROM users WHERE id = ?', [sub.user_id]);
      if (user && user.role !== 'admin') {
        const other = await db.get(
          `SELECT s.id FROM subscriptions s WHERE s.user_id = ? AND s.status = 'active' AND s.id != ?`,
          [sub.user_id, sub.id]);
        if (!other) await db.update('users', sub.user_id, { role: 'customer' });
      }
    } else if (type.includes('PAYMENT.FAILED')) {
      await db.update('subscriptions', sub.id, { status: 'past_due' });
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('webhook error', e);
    res.sendStatus(200); // always 200 so PayPal stops retrying a poisoned event
  }
});

module.exports = router;
