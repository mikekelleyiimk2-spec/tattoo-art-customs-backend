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

module.exports = { resolveShopReferral };
