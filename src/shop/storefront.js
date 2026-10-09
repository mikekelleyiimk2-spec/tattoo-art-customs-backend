// Shop storefront (shop toolset).
//
// Public branded page per shop (/store/:shopId) listing the shop's own
// approved designs for sale. Purchase links carry the shop's referral code
// so the shop earns referral credit on storefront sales.
// NOTE: shop_storefront_settings has no id/created_at columns — never
// db.insert() it; use raw queries (same pattern as shop_booking_settings).
const db = require('../db');

async function getSettings(shopUserId) {
  let s = await db.get('SELECT * FROM shop_storefront_settings WHERE shop_user_id = ?', [shopUserId]);
  if (!s) {
    await db.query('INSERT INTO shop_storefront_settings (shop_user_id) VALUES (?)', [shopUserId]);
    s = await db.get('SELECT * FROM shop_storefront_settings WHERE shop_user_id = ?', [shopUserId]);
  }
  return s;
}

async function saveSettings(shopUserId, { enabled, headline, welcomeText }) {
  await getSettings(shopUserId); // ensure row
  await db.query(
    'UPDATE shop_storefront_settings SET enabled = ?, headline = ?, welcome_text = ? WHERE shop_user_id = ?',
    [enabled ? 1 : 0,
     String(headline || '').slice(0, 120) || null,
     String(welcomeText || '').slice(0, 2000) || null,
     shopUserId]);
  return getSettings(shopUserId);
}

// The shop's own approved designs (the shop user holds designer access via
// shopDesigner.js, so their uploads carry artist_id = their user id).
async function getShopDesigns(shopUserId, limit = 60) {
  return db.all(
    `SELECT id, title, price_cents, color_path, linework_path, created_at
     FROM designs
     WHERE artist_id = ? AND status = 'approved'
     ORDER BY created_at DESC LIMIT ?`,
    [shopUserId, limit]);
}

async function getShopReferralCode(shopUserId) {
  const p = await db.get('SELECT referral_code FROM shop_profiles WHERE user_id = ?', [shopUserId]);
  return (p && p.referral_code) || null;
}

module.exports = { getSettings, saveSettings, getShopDesigns, getShopReferralCode };
