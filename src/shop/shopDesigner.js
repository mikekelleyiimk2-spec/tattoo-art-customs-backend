// Every tattoo shop subscription IS a designer subscription (owner rule
// 2026-09-29).
//
// A shop with an active tattoo_shop subscription automatically gets the
// full designer membership — no opt-in needed: upload through the artist
// portfolio pipeline, earn designer commissions, get a public designer
// portfolio, and appear in the request-artist dropdown. Lapse the shop
// subscription and designer access plus designer-commission eligibility
// stop automatically (every check below is live per-request; no cron
// needed).
//
// Anti-gaming is UNCHANGED: commissions.js books a shop's referral of its
// OWN design exactly like no referral (designer 70% / owner 20% / site
// 10%) — a shop can never pay itself the 20% shop referral cut.
const db = require('../db');
const { hasActiveSubscription, isAdminRole } = require('../middleware/auth');
const { upsertProfile } = require('../lib/profiles');

// Live check: an active tattoo_shop subscription carries the designer
// membership with it.
async function shopDesignerActive(userId) {
  return hasActiveSubscription(userId, 'tattoo_shop');
}

// Full designer access: paid artist subscription OR shop subscription
// (which includes the designer membership automatically).
async function designerAccess(userId) {
  if (await hasActiveSubscription(userId, 'design_artist')) return true;
  return shopDesignerActive(userId);
}

// Dual-subscription loyalty bonus: Adolfo's account ONLY (owner rule
// 2026-09-28) — no other account gets the +2%, even holding both an active
// design_artist subscription and an active tattoo_shop subscription
// (current_period_end IS NULL counts as active — lifetime grants).
// Commissions Adolfo earns get +2pts, funded out of the owner's share
// (the site's 10% overhead is never cut); see commissions.js.
// DUAL_BONUS_USER_ID env override exists so tests can exercise the path.
function dualBonusUserId() {
  return process.env.DUAL_BONUS_USER_ID || '3dcf35ac4d2762d2f2725398'; // Adolfo — adolfo3301@yahoo.com
}
async function dualSubBonusActive(userId) {
  if (userId !== dualBonusUserId()) return false;
  const now = Date.now();
  const rows = await db.all(
    `SELECT p.slug AS slug FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = ? AND p.slug IN ('design_artist', 'tattoo_shop')
       AND s.status = 'active' AND (s.current_period_end IS NULL OR s.current_period_end > ?)`,
    [userId, now]);
  const slugs = new Set(rows.map((r) => r.slug));
  return slugs.has('design_artist') && slugs.has('tattoo_shop');
}

function requireDesignerAccess() {
  return async (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (isAdminRole(req.user.role)) return next();
    if (await designerAccess(req.user.id)) {
      // Shops carry the designer membership automatically — make sure the
      // designer-side pages (portfolio, bio) have a profile row, including
      // for shops subscribed before this rule existed.
      try { await upsertProfile('artist_profiles', req.user.id, {}); } catch (e) { /* read-only contexts */ }
      return next();
    }
    req.session.flash = 'This requires an active Design Artist membership — included automatically with every tattoo shop subscription.';
    return res.redirect('/membership');
  };
}

module.exports = { shopDesignerActive, designerAccess, requireDesignerAccess, dualSubBonusActive, dualBonusUserId };
