// Shop referral attribution: resolve a referral code (?ref=CODE, or a typed
// code at checkout) to the referring shop's user id. Recorded on orders as
// referred_shop_id so the shop earns its commission cut and referral-tier
// progress; consumed by commissions.recordSaleCommissions and
// shopIncentives.shopVolumeTierRate.
const db = require('../db');

async function resolveShopReferral(code) {
  if (!code) return null;
  const shop = await db.get('SELECT user_id FROM shop_profiles WHERE referral_code = ?', [code]);
  return shop ? shop.user_id : null;
}

// Marketplace booking attribution (F7): bookings that originated from the
// Tattoo Art Customs design flow ("Get this tattooed") carry
// attribution_source = 'tac_marketplace'. The shop dashboard uses this as the
// renewal argument for the shop subscription.
async function getAttributionStats(shopUserId) {
  const all = await db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(deposit_cents), 0) AS revenue
     FROM bookings
     WHERE shop_user_id = ? AND attribution_source = 'tac_marketplace'
       AND status NOT IN ('cancelled', 'expired')`,
    [String(shopUserId)]);
  const recent = await db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(deposit_cents), 0) AS revenue
     FROM bookings
     WHERE shop_user_id = ? AND attribution_source = 'tac_marketplace'
       AND status NOT IN ('cancelled', 'expired')
       AND created_at >= ?`,
    [String(shopUserId), Date.now() - 30 * 86400000]);
  return {
    allTime: { bookings: Number((all && all.n) || 0), revenueCents: Number((all && all.revenue) || 0) },
    last30d: { bookings: Number((recent && recent.n) || 0), revenueCents: Number((recent && recent.revenue) || 0) },
  };
}

module.exports = { resolveShopReferral, getAttributionStats };
