// Shop verification: mark a shop's profile verified, unlocking the limited
// shop profile fields (location, hours, appointment requirements).
// Called from the admin members page; the admin's $1 shop_verify task pay
// is booked by the caller (admin task-pay Tier 2), not here.
const db = require('../db');

async function verifyShop(shopUserId) {
  await db.updateWhere('shop_profiles', { verified: 1 }, 'user_id', shopUserId);
}

module.exports = { verifyShop };
