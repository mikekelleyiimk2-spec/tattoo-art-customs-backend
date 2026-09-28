// Free designer membership for tattoo shops (opt-in).
//
// A shop with an active tattoo_shop subscription may opt in to designer
// membership at no extra cost: upload through the artist portfolio
// pipeline, earn designer commissions, get a public designer portfolio,
// and appear in the request-artist dropdown. The opt-in is only live
// while the shop subscription is active — lapse the subscription and
// designer access plus designer-commission eligibility stop automatically
// (every check below is live per-request; no cron needed).
//
// Anti-gaming is UNCHANGED: commissions.js books a shop's referral of its
// OWN design exactly like no referral (designer 70% / owner 20% / site
// 10%) — an opted-in shop can never pay itself the 20% shop referral cut.
const db = require('../db');
const { hasActiveSubscription, isAdminRole } = require('../middleware/auth');

async function shopDesignerOptedIn(userId) {
  const row = await db.get('SELECT designer_opt_in FROM shop_profiles WHERE user_id = ?', [userId]);
  return !!(row && row.designer_opt_in);
}

// Opt-in is only meaningful with a live shop subscription.
async function shopDesignerActive(userId) {
  if (!(await shopDesignerOptedIn(userId))) return false;
  return hasActiveSubscription(userId, 'tattoo_shop');
}

// Full designer access: paid artist subscription OR opted-in shop.
async function designerAccess(userId) {
  if (await hasActiveSubscription(userId, 'design_artist')) return true;
  return shopDesignerActive(userId);
}

function requireDesignerAccess() {
  return async (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (isAdminRole(req.user.role)) return next();
    if (await designerAccess(req.user.id)) return next();
    req.session.flash = 'This requires an active Design Artist membership — or a tattoo shop subscription with the free designer opt-in turned on.';
    return res.redirect('/membership');
  };
}

module.exports = { shopDesignerOptedIn, shopDesignerActive, designerAccess, requireDesignerAccess };
