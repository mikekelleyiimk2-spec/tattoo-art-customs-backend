// One-time 20%-off-first-custom discount for new subscribers
// (owner rule 2026-09-29, approved).
//
// Eligibility: the buyer holds an ACTIVE subscription/membership (any plan:
// customer, artist, shop, lifetime) AND has never had a custom commission on
// that account AND has never redeemed the discount. First custom ever = the
// one that gets the discount.
//
// Exactly-once: redemption is recorded in `first_custom_redemptions`
// (UNIQUE(user_id)) at order creation, before the order row is written. The
// check-then-insert race is closed by the UNIQUE constraint: a lost race
// falls back to the regular/sale price, so the discount can never be
// double-issued. Enforcement is server-side only — the client is never
// trusted.
//
// Never stackable: customPriceQuote() returns a single best-deal price —
// the first-custom discount, the Saturday sale, or regular — never combined.
const db = require('../db');
const config = require('../config');
const pricing = require('./pricing');
const { visitorCount, paidSalesCount } = require('./visitors');
const { isActiveMember } = require('../middleware/auth');

const FIRST_CUSTOM_DISCOUNT_CODE = 'first_custom_20';

// Opening-sale campaign cap: the discount auto-disables when the site
// reaches EITHER cap, whichever comes first. Values live in
// config.campaignCaps so future sales can reuse the mechanism.
async function openingSaleActive() {
  const { visitorCap, paidSalesCap } = config.campaignCaps;
  if ((await visitorCount()) >= visitorCap) return false;
  if ((await paidSalesCount()) >= paidSalesCap) return false;
  return true;
}

async function firstCustomEligible(user) {
  if (!user) return false;
  if (!(await openingSaleActive())) return false;
  if (!(await isActiveMember(user))) return false;
  const redeemed = await db.get('SELECT id FROM first_custom_redemptions WHERE user_id = ?', [user.id]);
  if (redeemed) return false;
  const prior = await db.get(
    `SELECT id FROM orders WHERE buyer_id = ? AND order_type = 'custom' AND status != 'canceled' LIMIT 1`,
    [user.id]);
  return !prior;
}

// Best-deal-wins custom quote. Returns { full, deposit, discount, sale, member }.
// `discount` is a single code ('first_custom_20' | 'saturday_sale' | null) —
// discounts are never stacked; the buyer always gets the lowest single price.
async function customPriceQuote(user, date = new Date()) {
  const member = await isActiveMember(user);
  const saleOn = await pricing.salePriceActive(user, date);
  let full = pricing.customFullCents(date, member);
  let discount = saleOn ? 'saturday_sale' : null;
  if (await firstCustomEligible(user)) {
    const fcFull = pricing.firstCustomFullCents();
    if (fcFull < full) { full = fcFull; discount = FIRST_CUSTOM_DISCOUNT_CODE; }
  }
  return { full, deposit: Math.round(full / 2), discount, sale: saleOn, member };
}

// Record the redemption exactly once. Returns true when THIS call redeemed
// it. Returns false only when the UNIQUE(user_id) constraint fired (another
// request already redeemed) — the caller must then fall back to the
// non-discounted price. Any other DB error is rethrown: failing loudly is
// safer than silently issuing a reusable discount.
async function redeemFirstCustomDiscount(userId, orderId) {
  try {
    await db.insert('first_custom_redemptions', {
      user_id: userId, order_id: orderId, redeemed_at: db.now(),
    });
    return true;
  } catch (e) {
    if (/unique/i.test(e.message || '')) return false;
    throw e;
  }
}

module.exports = { FIRST_CUSTOM_DISCOUNT_CODE, firstCustomEligible, customPriceQuote, redeemFirstCustomDiscount, openingSaleActive };
