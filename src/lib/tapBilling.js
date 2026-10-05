// Tap-to-pay standalone subscription billing (owner-approved 2026-10-04).
// Tiered flat monthly fee for shops only, billed separately from the shop
// membership: solo $9.99, studio $19.99, shop $29.99.
// Enforcement rule: bill current = service active. Every tap-to-pay perk or
// badge gate MUST go through tapActive() — never check the row directly.
const db = require('../db');

const TIERS = {
  solo:   { priceCents: 999,  planKey: 'tap_solo',   label: 'Solo',   chairs: '1 chair' },
  studio: { priceCents: 1999, planKey: 'tap_studio', label: 'Studio', chairs: '2–4 chairs' },
  shop:   { priceCents: 2999, planKey: 'tap_shop',   label: 'Shop',   chairs: '5+ chairs' },
};

// Standing gratitude arrangement (owner, 2026-10-04): Adolfo is comped FREE
// for as long as his shop subscription stays active — no end date, never
// moved to paid tap billing. Implemented in code (not a DB row) so the rule
// holds in every environment with zero manual grants.
const ADOLFO_EMAIL = 'adolfo3301@yahoo.com';

async function getTapSub(userId) {
  return db.get(
    `SELECT * FROM shop_tap_subscriptions
     WHERE shop_user_id = ? AND status IN ('pending','active','past_due')
     ORDER BY created_at DESC`,
    [userId]);
}

async function tapComped(userId) {
  const row = await db.get(
    'SELECT id FROM shop_tap_subscriptions WHERE shop_user_id = ? AND comped = 1',
    [userId]);
  if (row) return true;
  const u = await db.get('SELECT id FROM users WHERE email = ?', [ADOLFO_EMAIL]);
  if (u && String(u.id) === String(userId)) {
    const { hasActiveSubscription } = require('../middleware/auth');
    if (await hasActiveSubscription(userId, 'tattoo_shop')) return true;
  }
  return false;
}

async function tapActive(userId) {
  if (await tapComped(userId)) return true;
  const sub = await getTapSub(userId);
  return !!(sub && sub.status === 'active');
}

module.exports = { TIERS, ADOLFO_EMAIL, getTapSub, tapComped, tapActive };
