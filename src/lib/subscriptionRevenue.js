// Subscription revenue ledger (migration 042).
//
// One row per subscription payment, recorded exactly once. The opening
// raffle closes early at $2,700 in owner subscription profits, and this is
// the meter it reads.
//
// Split rule (owner policy 2026-09-30): the site takes its standard 10%
// overhead cut and the owner keeps 90% — the same 10% overhead applied to
// all other revenue. Owner-favorable rounding on odd cents (site share
// floors, owner gets the remainder).
//
// Provider conventions:
// - 'paypal' / `sub-activated:<paypalSubId>` — first payment on activation
//   (webhook ACTIVATED and /approve share this ref, so the double-fire is
//   a no-op the second time).
// - 'paypal' / `sale:<saleId>` — recurring payments via
//   PAYMENT.SALE.COMPLETED, keyed by the PayPal sale id.
// - 'google_play' / `play:<purchaseToken>` — Play purchase verification.
//   Recorded at gross plan price: Google's store cut (15-30%) is NOT
//   deducted, so owner profits here are slightly generous. The Play
//   financial reports are the source of truth for net; this ledger is the
//   source of truth for "a paying subscriber exists and paid the plan price".
//
// Zero/negative amounts are never recorded (free grants, trials that paid
// $0) — they are not revenue.
const db = require('../db');

const SUBSCRIPTION_SITE_OVERHEAD_PCT = 10;

function splitRevenue(amountCents) {
  const amt = Math.max(0, Math.round(amountCents || 0));
  const siteShare = Math.floor((amt * SUBSCRIPTION_SITE_OVERHEAD_PCT) / 100);
  return { amount: amt, siteShare, ownerShare: amt - siteShare };
}

// Record one subscription payment. Idempotent: a second call with the same
// (provider, providerRef) returns { recorded: false } without inserting.
async function recordSubscriptionRevenue({ userId, plan, amountCents, provider, providerRef }) {
  const { amount, siteShare, ownerShare } = splitRevenue(amountCents);
  if (amount <= 0) return { recorded: false, reason: 'zero_amount' };
  if (!userId || !provider || !providerRef) {
    throw new Error('recordSubscriptionRevenue: userId, provider, and providerRef are required');
  }
  try {
    await db.insert('subscription_revenue', {
      id: db.newId(),
      user_id: userId,
      plan: String(plan || ''),
      amount_cents: amount,
      owner_share_cents: ownerShare,
      site_share_cents: siteShare,
      provider: String(provider),
      provider_ref: String(providerRef).slice(0, 200),
      created_at: db.now(),
    });
    return { recorded: true, amountCents: amount, ownerShareCents: ownerShare, siteShareCents: siteShare };
  } catch (e) {
    if (/unique/i.test(e.message || '')) return { recorded: false, reason: 'duplicate' };
    throw e;
  }
}

// First-payment amount for a fresh PayPal activation, given the
// subscription row (with plan price + discount flags). Mirrors the billing
// cycles chosen in POST /membership/subscribe.
function firstPaymentCents(sub, config) {
  const price = Number(sub.price_cents || sub.plan_price_cents || 0);
  if (sub.plan_slug === 'customer' && Number(sub.first_month_discount_applied) === 1) {
    return config.pricing.firstMonth.priceCents;
  }
  if (sub.plan_slug === 'tattoo_shop' && Number(sub.founding_discount_applied) === 1) {
    return config.pricing.foundingShop.priceCents;
  }
  return price;
}

// The raffle's $2,700 close condition reads this.
async function ownerSubscriptionProfitsCents() {
  const r = await db.get('SELECT COALESCE(SUM(owner_share_cents),0) AS t FROM subscription_revenue');
  return r ? r.t : 0;
}

async function siteSubscriptionRevenueCents() {
  const r = await db.get('SELECT COALESCE(SUM(site_share_cents),0) AS t FROM subscription_revenue');
  return r ? r.t : 0;
}

// PayPal fires BOTH BILLING.SUBSCRIPTION.ACTIVATED and
// PAYMENT.SALE.COMPLETED for the first payment, in either order. The
// activation records the known first-cycle price; the sale event is skipped
// when it is that same first payment (within the window of the activation
// record). Recurring sales (a month+ later) always record.
const FIRST_PAYMENT_WINDOW_MS = 2 * 3600 * 1000;

async function recordPaypalActivation(sub, config) {
  // Sale event arrived first: a sale: row for this user+plan inside the
  // window means the first payment is already counted.
  const prior = await db.get(
    `SELECT id FROM subscription_revenue WHERE provider = 'paypal'
     AND provider_ref LIKE 'sale:%' AND user_id = ? AND plan = ?
     AND created_at > ? LIMIT 1`,
    [sub.user_id, sub.plan_slug, db.now() - FIRST_PAYMENT_WINDOW_MS]);
  if (prior) return { recorded: false, reason: 'sale_first' };
  return recordSubscriptionRevenue({
    userId: sub.user_id, plan: sub.plan_slug,
    amountCents: firstPaymentCents(sub, config),
    provider: 'paypal',
    providerRef: `sub-activated:${sub.paypal_subscription_id}`,
  });
}

async function recordPaypalSale({ sub, saleId, amountCents, saleTimeMs }) {
  if (!saleId) return { recorded: false, reason: 'no_sale_id' };
  const act = await db.get(
    `SELECT created_at FROM subscription_revenue WHERE provider = 'paypal'
     AND provider_ref = ? LIMIT 1`,
    [`sub-activated:${sub.paypal_subscription_id}`]);
  if (act && saleTimeMs && saleTimeMs <= Number(act.created_at) + FIRST_PAYMENT_WINDOW_MS) {
    return { recorded: false, reason: 'first_payment' };
  }
  return recordSubscriptionRevenue({
    userId: sub.user_id, plan: sub.plan_slug,
    amountCents, provider: 'paypal', providerRef: `sale:${saleId}`,
  });
}

module.exports = {
  SUBSCRIPTION_SITE_OVERHEAD_PCT,
  splitRevenue,
  recordSubscriptionRevenue,
  firstPaymentCents,
  ownerSubscriptionProfitsCents,
  siteSubscriptionRevenueCents,
  recordPaypalActivation,
  recordPaypalSale,
  FIRST_PAYMENT_WINDOW_MS,
};
