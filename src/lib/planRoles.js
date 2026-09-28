// Plan-role grants shared by the website checkout flow (src/routes/memberships.js)
// and the Google Play purchase-verification flow (src/routes/play.js).
//
// Grants the role matching a plan slug and creates the artist/shop profile.
// Also claims founding-program status (first 50 artists / first 100 shops);
// the claim is idempotent and silently no-ops once the caps fill.
//
// Idempotent — safe to call from both /approve, the PayPal webhook, and
// Play purchase verification.
const db = require('../db');
const { upsertProfile } = require('./profiles');
const { isAdminRole } = require('../middleware/auth');
const foundingLib = require('./founding');

const ROLE_BY_SLUG = { design_artist: 'design_artist', tattoo_shop: 'tattoo_shop' };

function makeReferralCode() {
  return 'TAC-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function grantPlanRole(userId, planSlug) {
  const role = ROLE_BY_SLUG[planSlug];
  if (!role) return;
  const user = await db.get('SELECT role FROM users WHERE id = ?', [userId]);
  if (!user || isAdminRole(user.role)) return;
  await db.update('users', userId, { role });
  if (role === 'design_artist') {
    await upsertProfile('artist_profiles', userId, {});
    try { await foundingLib.claimFoundingArtist(userId); }
    catch (e) { console.error('founding artist claim failed:', e.message); }
  }
  if (role === 'tattoo_shop') {
    await upsertProfile('shop_profiles', userId, { referral_code: makeReferralCode() });
    try { await foundingLib.claimFoundingShop(userId); }
    catch (e) { console.error('founding shop claim failed:', e.message); }
  }
}

module.exports = { grantPlanRole, makeReferralCode, ROLE_BY_SLUG };
