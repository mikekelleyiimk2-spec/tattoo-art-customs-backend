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
const PLAN_KEY_BY_SLUG = { customer: 'customer', customer_annual: 'customer_annual', customer_6month: 'customer_6month', design_artist: 'artist', tattoo_shop: 'shop' };
const { isAdminRole } = require('../middleware/auth');
const { ensureReferralCode, firstMonthDiscountEligible, markFirstMonthUsed, grantReferralReward } = require('../lib/referrals');
const { recordPaypalActivation, recordPaypalSale } = require('../lib/subscriptionRevenue');

// Public landing page for the Tattoo Shop membership: shop-exclusive
// benefits on top, the full included marketplace feature set below.
router.get('/shops', async (req, res) => {
  const shopPlan = await db.get("SELECT * FROM plans WHERE slug = 'tattoo_shop' AND active = 1");
  res.render('membership/shops', {
    title: 'Tattoo Shop Membership — Tattoo Art Customs',
    shopPlan,
    paypalReady: config.paypalPlansConfigured(),
    loggedIn: !!req.user,
    metaDescription: 'Tattoo Shop membership: verified directory listing, 20% referral commissions, shop toolkit in development, and full Design Artist access. $103.98/year.',
  });
});

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
    sixMonthReady: config.paypalCustomer6MonthPlanConfigured(),
    // Pro-app perk (owner directive 2026-10-05): the 6-month customer plan
    // is purchasable ONLY by verified Pro-app owners with no active
    // customer-plan membership. Everyone else sees it locked with an upsell
    // (or "already active"), never a dead button.
    eligibleFor6Month: await require('../lib/proPurchases').hasVerifiedProPurchase(req.user.id),
    hasActiveCustomerMembership: await require('../middleware/auth').isCustomerMember(req.user),
    foundingShop: foundingShop && foundingStatus.shopsLeft > 0 && config.paypalFoundingShopPlanConfigured(), foundingPrice: config.pricing.foundingShop.priceCents,
    foundingEnds: config.foundingShopWindowEnd,
    shopsLeft: foundingStatus.shopsLeft,
    firstMonthEligible: await firstMonthDiscountEligible(req.user.id),
    firstMonthPrice: config.pricing.firstMonth.priceCents,
    customerPlanPrice: (plans.find((x) => x.slug === 'customer') || {}).price_cents || config.pricing.plans.customer.priceCents,
    // Site-credit price per plan: base price with no processing fee (the
    // credit was already fee-paid when acquired). Shown on the "pay with
    // site credit" option (gift-card redemption path, owner rule 2026-09-30).
    creditBaseBySlug: Object.fromEntries(plans.map((p) => [p.slug, Math.round((p.price_cents - 49) / 1.035)])),
    creditBalance: await require('../lib/credits').getCreditBalance(req.user.id),
    referralCode, redemptions, money: require('../lib/pricing').money,
    baseUrl: config.baseUrl,
    metaDescription: 'Tattoo Art Customs membership plans.',
  });
});

// Pay for one membership term with site credit (gift-card redemption path,
// owner rule 2026-09-30). No PayPal, no recurring billing: grants a single
// active term (current_period_end = now + interval) and never auto-renews
// (paid_with_credit = 1). The credit was already fee-paid when it was
// acquired (top-up or gift card purchase), so the BASE plan price is charged
// with no added processing fee.
router.post('/credit/:slug', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const plan = await db.get('SELECT * FROM plans WHERE slug = ? AND active = 1', [req.params.slug]);
  if (!plan) return res.status(404).render('error', { title: 'Not found', message: 'Unknown plan.' });
  // Population-admin guard mirrors /subscribe: those accounts are never
  // billed (their access is already covered).
  try {
    await require('../middleware/auth').assertNotPopulationAdmin(req.user.id);
  } catch (e) {
    req.session.flash = 'Population-admin accounts are never billed for memberships — your access is already covered.';
    return res.redirect('/membership');
  }
  // Pro-app perk gate (owner directive 2026-10-05): the 6-month customer
  // plan is purchasable ONLY by verified Pro-app owners, on any payment path.
  if (plan.slug === 'customer_6month' && !await require('../lib/proPurchases').hasVerifiedProPurchase(req.user.id)) {
    req.session.flash = 'The 6-month plan is a Pro-app perk — own the Pro app to unlock 6 months for the price of 5.';
    return res.redirect('/membership');
  }
  // Anti-gaming (owner directive 2026-10-05): the free month is a NEW-member
  // acquisition perk, not a downgrade path. A user with an ACTIVE
  // customer-plan membership (customer / customer_annual / customer_6month)
  // cannot re-buy at the perk rate — lapsed members (no active sub) ARE
  // eligible, because that is win-back and it is desirable.
  if (plan.slug === 'customer_6month' && await require('../middleware/auth').isCustomerMember(req.user)) {
    req.session.flash = 'The 6-month Pro-perk rate is for new memberships — your customer membership is already active.';
    return res.redirect('/membership');
  }
  // Base price: invert the fee pass-through (priceCents = round(base*1.035)+49).
  const pricing = require('../lib/pricing');
  const displayInterval = plan.interval === '6month' ? '6 months' : plan.interval;
  const baseCents = Math.round((plan.price_cents - 49) / 1.035);
  const { getCreditBalance, addCredit } = require('../lib/credits');
  const balance = await getCreditBalance(req.user.id);
  if (balance < baseCents) {
    req.session.flash = `Not enough site credit — one ${displayInterval} of ${plan.name} is ${pricing.money(baseCents)} and you have ${pricing.money(balance)}. Top up or redeem a gift card first.`;
    return res.redirect('/membership');
  }
  // Extend an existing active sub for this plan, else create a fresh
  // one-term subscription. Idempotent on double-click: the second POST finds
  // the row the first one just created and extends it instead of stacking.
  //
  // ORDER MATTERS: the existing-subscription checks run BEFORE any credit is
  // debited. A PayPal-billed subscription already covering this plan must
  // redirect WITHOUT touching credit — debiting first meant the user lost
  // credit and got nothing.
  // Term length mirrors the plan interval (month = 30d, 6-month = 180d,
  // year = 365d) so the site-credit path grants the plan's real term.
  const termMs = plan.interval === 'year' ? 365 * 86400000
    : plan.interval === '6month' ? 180 * 86400000
    : 30 * 86400000;
  const nowMs = Date.now();
  const existing = await db.get(
    `SELECT * FROM subscriptions WHERE user_id = ? AND plan_id = ? AND status = 'active'
     AND (current_period_end IS NULL OR current_period_end > ?)`, [req.user.id, plan.id, nowMs]);
  if (existing && Number(existing.paid_with_credit) !== 1) {
    // A PayPal-billed subscription already covers this plan — don't stack,
    // and crucially don't charge.
    req.session.flash = 'You already have an active subscription for this plan — complete or cancel it below.';
    return res.redirect('/membership');
  }
  await addCredit({
    userId: req.user.id, amountCents: -baseCents, kind: 'membership_spend', refId: plan.id,
    note: `One ${displayInterval} of ${plan.name} paid with site credit`,
  });
  let subId;
  if (existing) {
    const from = Math.max(Number(existing.current_period_end) || nowMs, nowMs);
    await db.update('subscriptions', existing.id, { current_period_end: from + termMs });
    subId = existing.id;
  } else {
    subId = await db.insert('subscriptions', {
      user_id: req.user.id, plan_id: plan.id, status: 'active',
      paypal_subscription_id: '', current_period_end: nowMs + termMs,
      paid_with_credit: 1, created_at: db.now(),
    });
  }
  const { grantPlanRole } = require('../lib/planRoles');
  await grantPlanRole(req.user.id, plan.slug);
  // Revenue recognition on the same meter as PayPal/Play activations.
  try {
    const { recordSubscriptionRevenue } = require('../lib/subscriptionRevenue');
    await recordSubscriptionRevenue({
      userId: req.user.id, plan: plan.slug, amountCents: baseCents,
      provider: 'credit', providerRef: `credit-sub:${subId}:${nowMs}`,
    });
  } catch (e) { console.error('credit subscription revenue record failed:', e.message); }
  try { await grantReferralReward(req.user.id, subId); } catch (e) { console.error('referral reward failed:', e.message); }
  try {
    await require('../lib/saleWatch').watchSubscriptionActive(
      await db.get('SELECT * FROM subscriptions WHERE id = ?', [subId]));
  } catch (e) { console.error('sale watch failed:', e.message); }
  req.session.flash = `${plan.name} active for one ${displayInterval} — paid with site credit.`;
  res.redirect('/membership');
});

// Start a PayPal subscription for a plan.
router.post('/subscribe/:slug', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const plan = await db.get('SELECT * FROM plans WHERE slug = ? AND active = 1', [req.params.slug]);
  if (!plan) return res.status(404).render('error', { title: 'Not found', message: 'Unknown plan.' });
  // Owner rule 2026-09-29: population-admin accounts ("super admins with
  // population setup") are NEVER auto-charged monthly membership fees — a
  // recurring PayPal subscription would bill them every cycle. Refuse the
  // creation loudly, never silently bill. (Voluntary one-time premade/custom
  // purchases are unaffected — this guard only covers recurring billing.)
  try {
    await require('../middleware/auth').assertNotPopulationAdmin(req.user.id);
  } catch (e) {
    console.warn('blocked recurring subscription creation for population_admin', req.user.id);
    req.session.flash = 'Population-admin accounts are never billed for memberships — your access is already covered.';
    return res.redirect('/membership');
  }
  // Idempotency: never stack duplicate subscriptions for the same plan —
  // rapid double-clicks used to create one pending subscription per click.
  const existing = await db.get(
    `SELECT id FROM subscriptions WHERE user_id = ? AND plan_id = ? AND status IN ('pending','active')`,
    [req.user.id, plan.id]);
  if (existing) {
    req.session.flash = 'You already have a subscription for this plan — complete or cancel it below.';
    return res.redirect('/membership');
  }
  if (plan.slug === 'customer_annual' && !config.paypalAnnualPlanConfigured()) {
    req.session.flash = 'The annual plan is not available yet — the monthly plan is ready now.';
    return res.redirect('/membership');
  }
  // Pro-app perk gate (owner directive 2026-10-05): verified Pro purchase
  // required, AND no active customer-plan membership — the free month is a
  // new-member acquisition perk, not a downgrade path for existing $5/mo
  // members. Lapsed members (no active sub) are eligible: win-back.
  if (plan.slug === 'customer_6month') {
    if (!await require('../lib/proPurchases').hasVerifiedProPurchase(req.user.id)) {
      req.session.flash = 'The 6-month plan is a Pro-app perk — own the Pro app to unlock 6 months for the price of 5.';
      return res.redirect('/membership');
    }
    if (await require('../middleware/auth').isCustomerMember(req.user)) {
      req.session.flash = 'The 6-month Pro-perk rate is for new memberships — your customer membership is already active.';
      return res.redirect('/membership');
    }
    if (!config.paypalCustomer6MonthPlanConfigured()) {
      req.session.flash = 'The 6-month plan is not available yet — the monthly plan is ready now.';
      return res.redirect('/membership');
    }
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
    let planKey = PLAN_KEY_BY_SLUG[plan.slug];
    if (plan.slug === 'customer' && await firstMonthDiscountEligible(req.user.id)) {
      billingCycles = paypal.firstMonthTrialCycles(plan.price_cents);
      firstMonth = true;
    } else if (plan.slug === 'tattoo_shop' && config.foundingShopActive()) {
      // Founding shops: $83.28 first year instead of $103.98 — but only for
      // the first 100 shops (the founding-shop cap). The discount lives in
      // a dedicated PayPal plan (PayPal rejects a 1-year TRIAL override at
      // subscription creation), so subscribe to that plan directly.
      const foundingLib = require('../lib/founding');
      if (await foundingLib.foundingShopsAvailable()) {
        if (!config.paypalFoundingShopPlanConfigured()) {
          req.session.flash = 'Founding-shop checkout is being set up — please try again shortly.';
          return res.redirect('/membership');
        }
        planKey = 'founding_shop';
        founding = true;
      }
    }
    const sub = await paypal.createSubscription({
      planKey,
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
    // Never leak raw provider errors to the page (they used to render
    // verbatim, e.g. "PayPal API POST ... failed: ...").
    console.error('membership subscribe failed:', e.message);
    req.session.flash = 'Checkout is unavailable right now — please try again in a moment.';
    res.redirect('/membership');
  }
});

// PayPal returns here after the buyer approves.
router.get('/approve', requireLogin, async (req, res) => {
  const subId = req.session.pendingSub;
  delete req.session.pendingSub;
  if (!subId) return res.redirect('/membership');
  const sub = await db.get(
    `SELECT s.*, p.slug AS plan_slug, p.price_cents AS plan_price_cents FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id WHERE s.id = ?`, [subId]);
  if (!sub || sub.user_id !== req.user.id) return res.redirect('/membership');
  const wasActive = sub.status === 'active';
  try {
    const remote = await paypal.getSubscription(sub.paypal_subscription_id);
    const status = (remote.status || '').toLowerCase();
    // Only a PayPal-confirmed ACTIVE subscription activates membership.
    // 'approval_pending' means the buyer has not approved (and paid) yet —
    // activating on it would grant a free membership, so it stays pending
    // until the buyer approves or the signed webhook confirms activation.
    if (status === 'active') {
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
      // First-sale watch: the owner gets a notification on every new paid
      // membership (idempotent — only on a fresh activation).
      if (!wasActive) {
        try { await require('../lib/saleWatch').watchSubscriptionActive(sub); } catch (e) { console.error('sale watch failed:', e.message); }
        // Ledger the first payment (idempotent — the webhook shares the ref).
        try { await recordPaypalActivation(sub, config); } catch (e) { console.error('subscription revenue record failed:', e.message); }
      }
      req.session.flash = 'Membership active — welcome!';
    } else {
      await db.update('subscriptions', sub.id, { status: 'pending' });
      req.session.flash = status === 'approval_pending'
        ? 'Your PayPal approval is still pending — approve it at PayPal, then use "Complete payment" below.'
        : 'Subscription approval is still pending with PayPal.';
    }
  } catch (e) {
    req.session.flash = 'Could not confirm the subscription: ' + e.message;
  }
  res.redirect('/membership');
});

// Resume an abandoned checkout: re-fetch the PayPal approve URL for a
// pending subscription owned by the logged-in user and redirect to it.
router.get('/resume/:id', requireLogin, async (req, res) => {
  const sub = await db.get('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id]);
  if (!sub || sub.status !== 'pending' || !sub.paypal_subscription_id) return res.redirect('/membership');
  // Same owner rule as /subscribe: resuming a pending billing agreement
  // would restart automatic monthly charges — never for population admins.
  try {
    await require('../middleware/auth').assertNotPopulationAdmin(req.user.id);
  } catch (e) {
    console.warn('blocked subscription resume for population_admin', req.user.id);
    req.session.flash = 'Population-admin accounts are never billed for memberships — your access is already covered.';
    return res.redirect('/membership');
  }
  try {
    const remote = await paypal.getSubscription(sub.paypal_subscription_id);
    const approve = (remote.links || []).find((l) => l.rel === 'approve');
    if (approve && approve.href) {
      req.session.pendingSub = sub.id;
      return res.redirect(approve.href);
    }
    req.session.flash = 'This subscription can no longer be approved at PayPal — please start a new one.';
  } catch (e) {
    req.session.flash = 'Could not reach PayPal: ' + e.message;
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
    } else if (process.env.NODE_ENV === 'production') {
      console.error('PayPal webhook REJECTED: PAYPAL_WEBHOOK_ID is not configured in production.');
      return res.sendStatus(401);
    } else {
      console.warn('PayPal webhook received but PAYPAL_WEBHOOK_ID is not configured — event accepted unverified (dev only).');
    }
    const event = req.body;
    const resource = event.resource || {};
    const type = event.event_type || '';
    // Recurring subscription payment (and the first payment's sale event):
    // PAYMENT.SALE.COMPLETED carries the exact charged amount. The first
    // payment's sale is skipped when the activation already counted it
    // (recordPaypalSale handles the ordering either way).
    if (type === 'PAYMENT.SALE.COMPLETED' && resource.billing_agreement_id && resource.id) {
      const saleSub = await db.get(
        `SELECT s.*, p.slug AS plan_slug FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
         WHERE s.paypal_subscription_id = ?`, [resource.billing_agreement_id]);
      if (saleSub) {
        const amt = resource.amount || {};
        const total = parseFloat(amt.total || '0');
        if (String(amt.currency || 'USD').toUpperCase() === 'USD' && total > 0) {
          try {
            await recordPaypalSale({
              sub: saleSub,
              saleId: resource.id,
              amountCents: Math.round(total * 100),
              saleTimeMs: resource.create_time ? Date.parse(resource.create_time) : null,
            });
          } catch (e) { console.error('subscription revenue record failed:', e.message); }
        }
      } else {
        // Tap-to-pay standalone billing: each successful payment extends the
        // paid period by one month (bill current = service active).
        const tapSale = await db.get(
          'SELECT * FROM shop_tap_subscriptions WHERE paypal_subscription_id = ?',
          [resource.billing_agreement_id]);
        if (tapSale && !Number(tapSale.comped)) {
          const now = Date.now();
          const from = Math.max(Number(tapSale.current_period_end) || now, now);
          await db.update('shop_tap_subscriptions', tapSale.id, {
            status: 'active', current_period_start: now,
            current_period_end: from + 30 * 86400000, updated_at: now,
          });
        }
      }
      return res.sendStatus(200);
    }
    const paypalSubId = resource.id || resource.billing_agreement_id;
    if (!paypalSubId) return res.sendStatus(200);
    const sub = await db.get(
      `SELECT s.*, p.slug AS plan_slug, p.price_cents AS plan_price_cents FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.paypal_subscription_id = ?`, [paypalSubId]);
    if (!sub) {
      // Tap-to-pay standalone billing (no plan roles ever granted here).
      const tapSub = await db.get(
        'SELECT * FROM shop_tap_subscriptions WHERE paypal_subscription_id = ?',
        [paypalSubId]);
      if (!tapSub) return res.sendStatus(200);
      const tnow = Date.now();
      if (type.includes('ACTIVATED')) {
        await db.update('shop_tap_subscriptions', tapSub.id, {
          status: 'active', current_period_start: tnow,
          current_period_end: tnow + 30 * 86400000, updated_at: tnow,
        });
      } else if (type.includes('CANCELLED') || type.includes('EXPIRED')) {
        await db.update('shop_tap_subscriptions', tapSub.id,
          { status: 'suspended', canceled_at: db.now(), updated_at: tnow });
      } else if (type.includes('PAYMENT.FAILED')) {
        await db.update('shop_tap_subscriptions', tapSub.id,
          { status: 'past_due', updated_at: tnow });
      }
      return res.sendStatus(200);
    }
    if (type.includes('ACTIVATED')) {
      const wasActive = sub.status === 'active';
      await db.update('subscriptions', sub.id, { status: 'active' });
      // Grant the role here too — the buyer may never return via /approve.
      await grantPlanRole(sub.user_id, sub.plan_slug);
      // Refer-a-friend reward (idempotent — safe if /approve already ran it).
      try { await grantReferralReward(sub.user_id, sub.id); } catch (e) {
        console.error('referral reward failed:', e.message);
      }
      // First-sale watch: notify the owner on a fresh activation only.
      if (!wasActive) {
        try { await require('../lib/saleWatch').watchSubscriptionActive(sub); } catch (e) { console.error('sale watch failed:', e.message); }
        // Ledger the first payment (idempotent — /approve shares the ref,
        // and webhook retries hit the UNIQUE constraint).
        try { await recordPaypalActivation(sub, config); } catch (e) { console.error('subscription revenue record failed:', e.message); }
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
