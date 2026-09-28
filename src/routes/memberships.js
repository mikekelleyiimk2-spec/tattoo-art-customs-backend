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
const PLAN_KEY_BY_SLUG = { customer: 'customer', customer_annual: 'customer_annual', design_artist: 'artist', tattoo_shop: 'shop' };
const { isAdminRole } = require('../middleware/auth');
const { ensureReferralCode, firstMonthDiscountEligible, markFirstMonthUsed, grantReferralReward } = require('../lib/referrals');

router.get('/', requireLogin, async (req, res) => {
  const plans = await db.all('SELECT * FROM plans WHERE active = 1 ORDER BY price_cents');
  const subs = await db.all(
    `SELECT s.*, p.slug AS plan_slug, p.name AS plan_name FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id WHERE s.user_id = ? ORDER BY s.created_at DESC`,
    [req.user.id]);
  const referralCode = await ensureReferralCode(req.user.id);
  const redemptions = await db.all(
    'SELECT * FROM referral_redemptions WHERE referrer_id = ? ORDER BY granted_at DESC', [req.user.id]);
  const foundingShop = config.foundingShopActive();
  const foundingStatus = await require('../lib/founding').getFoundingStatus();
  res.render('membership/plans', {
    title: 'Membership — Tattoo Art Customs',
    plans, subs, paypalReady: config.paypalPlansConfigured(),
    annualReady: config.paypalAnnualPlanConfigured(),
    foundingShop: foundingShop && foundingStatus.shopsLeft > 0, foundingPrice: config.pricing.foundingShop.priceCents,
    foundingEnds: config.foundingShopWindowEnd,
    shopsLeft: foundingStatus.shopsLeft,
    firstMonthEligible: await firstMonthDiscountEligible(req.user.id),
    firstMonthPrice: config.pricing.firstMonth.priceCents,
    customerPlanPrice: (plans.find((x) => x.slug === 'customer') || {}).price_cents || config.pricing.plans.customer.priceCents,
    referralCode, redemptions, money: require('../lib/pricing').money,
    baseUrl: config.baseUrl,
    metaDescription: 'Tattoo Art Customs membership plans.',
  });
});

// Start a PayPal subscription for a plan.
router.post('/subscribe/:slug', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const plan = await db.get('SELECT * FROM plans WHERE slug = ? AND active = 1', [req.params.slug]);
  if (!plan) return res.status(404).render('error', { title: 'Not found', message: 'Unknown plan.' });
  if (plan.slug === 'customer_annual' && !config.paypalAnnualPlanConfigured()) {
    req.session.flash = 'The annual plan is not available yet — the monthly plan is ready now.';
    return res.redirect('/membership');
  }
  try {
    // Subscription incentives:
    // - $1 first month for NEW monthly customer memberships (exactly once
    //   per user): a PayPal trial cycle, recorded on the user + subscription.
    // - Founding tattoo shops: $79.99 first year instead of $99.99 while
    //   the founding window is open (renewals revert to $99.99 automatically).
    let billingCycles = null;
    let firstMonth = false;
    let founding = false;
    if (plan.slug === 'customer' && await firstMonthDiscountEligible(req.user.id)) {
      billingCycles = paypal.firstMonthTrialCycles(plan.price_cents);
      firstMonth = true;
    } else if (plan.slug === 'tattoo_shop' && config.foundingShopActive()) {
      // Founding shops: $79.99 first year instead of $99.99 — but only for
      // the first 100 shops (the founding-shop cap).
      const foundingLib = require('../lib/founding');
      if (await foundingLib.foundingShopsAvailable()) {
        billingCycles = paypal.foundingShopCycles();
        founding = true;
      }
    }
    const sub = await paypal.createSubscription({
      planKey: PLAN_KEY_BY_SLUG[plan.slug],
      returnUrl: `${config.baseUrl}/membership/approve?plan=${plan.slug}`,
      cancelUrl: `${config.baseUrl}/membership`,
      billingCycles,
    });
    const approve = sub.links.find((l) => l.rel === 'approve');
    const subId = await db.insert('subscriptions', {
      user_id: req.user.id, plan_id: plan.id, status: 'pending',
      paypal_subscription_id: sub.id, created_at: db.now(),
      first_month_discount_applied: firstMonth ? 1 : 0,
      founding_discount_applied: founding ? 1 : 0,
    });
    if (firstMonth) await markFirstMonthUsed(req.user.id);
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
      // Refer-a-friend: the friend is now a paying subscriber — the referrer
      // earns one free month (exactly once per referred subscription).
      try { await grantReferralReward(sub.user_id, sub.id); } catch (e) {
        console.error('referral reward failed:', e.message);
      }
      // Early-subscriber raffle: first paid subscription inside the window
      // earns exactly one entry (idempotent — safe if the webhook runs too).
      try { await require('../lib/founding').maybeEnterRaffle(sub.user_id, sub.id); } catch (e) {
        console.error('raffle entry failed:', e.message);
      }
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
// Also claims founding-program status (first 50 artists / first 100 shops);
// the claim is idempotent and silently no-ops once the caps fill.
// (Shared implementation lives in src/lib/planRoles.js so the Google Play
// verification flow grants the same roles and founding status.)
const { grantPlanRole } = require('../lib/planRoles');

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
  if (!other && !isAdminRole(req.user.role)) {
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
      // Refer-a-friend reward (idempotent — safe if /approve already ran it).
      try { await grantReferralReward(sub.user_id, sub.id); } catch (e) {
        console.error('referral reward failed:', e.message);
      }
      // Early-subscriber raffle entry (idempotent — safe if /approve ran it).
      try { await require('../lib/founding').maybeEnterRaffle(sub.user_id, sub.id); } catch (e) {
        console.error('raffle entry failed:', e.message);
      }
    } else if (type.includes('CANCELLED') || type.includes('EXPIRED')) {
      await db.update('subscriptions', sub.id, { status: 'canceled', canceled_at: db.now() });
      const user = await db.get('SELECT role FROM users WHERE id = ?', [sub.user_id]);
      if (user && !isAdminRole(user.role)) {
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
