// Auth + role + subscription guards.
// Roles: customer, design_artist, tattoo_shop, admin, head_admin.
// A head_admin is a full administrator (passes every requireRole('admin')
// check) plus the only role that may manage other admins.
const db = require('../db');

function isAdminRole(role) {
  return role === 'admin' || role === 'head_admin';
}

function isHeadAdmin(user) {
  return !!user && user.role === 'head_admin';
}

async function loadUser(req, res, next) {
  res.locals.currentUser = null;
  if (req.session && req.session.userId) {
    const user = await db.get(
      'SELECT id, email, role, display_name FROM users WHERE id = ?', [req.session.userId]);
    if (user) {
      res.locals.currentUser = user;
      req.user = user;
    } else {
      delete req.session.userId;
    }
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

function requireRole(...roles) {
  // 'admin' in the list admits head_admins too; an explicit 'head_admin'
  // requirement admits only head_admins.
  const expanded = [...roles];
  if (expanded.includes('admin') && !expanded.includes('head_admin')) expanded.push('head_admin');
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!expanded.includes(req.user.role) && !isAdminRole(req.user.role)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'Your account cannot access this page.' });
    }
    next();
  };
}

// Only the head administrator may manage other admins.
function requireHeadAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (!isHeadAdmin(req.user)) {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Only the head administrator can manage admins.' });
  }
  next();
}

// Site-side membership extension from referral free months
// (users.membership_extended_until, unix-ms).
async function extendedUntil(userId) {
  const u = await db.get('SELECT membership_extended_until FROM users WHERE id = ?', [userId]);
  return u && u.membership_extended_until ? u.membership_extended_until : 0;
}

// Active subscription to a given plan slug (admin bypasses).
async function hasActiveSubscription(userId, planSlug) {
  const row = await db.get(
    `SELECT s.id FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = ? AND p.slug = ? AND s.status = 'active'
       AND (s.current_period_end IS NULL OR s.current_period_end > ?)`,
    [userId, planSlug, Date.now()]);
  if (row) return true;
  // Referral free months extend the membership past the PayPal period.
  if (await extendedUntil(userId) > Date.now()) {
    const ever = await db.get(
      `SELECT s.id FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = ? AND p.slug = ? LIMIT 1`, [userId, planSlug]);
    return !!ever;
  }
  return false;
}

function requireSubscription(planSlug) {
  return async (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (isAdminRole(req.user.role)) return next();
    if (await hasActiveSubscription(req.user.id, planSlug)) return next();
    const plan = await db.get('SELECT name FROM plans WHERE slug = ?', [planSlug]);
    req.session.flash = `This requires an active ${plan ? plan.name : 'membership'}.`;
    return res.redirect('/membership');
  };
}

// Any active subscription (any plan) — for subscriber-only tools like the combiner.
async function hasAnyActiveSubscription(userId) {
  const row = await db.get(
    `SELECT s.id FROM subscriptions s
     WHERE s.user_id = ? AND s.status = 'active'
       AND (s.current_period_end IS NULL OR s.current_period_end > ?)`,
    [userId, Date.now()]);
  if (row) return true;
  return (await extendedUntil(userId)) > Date.now();
}

// "Subscribed member" — any active subscription, or a referral-extended
// membership. Used for early sale entry and member-exclusive designs.
async function isActiveMember(user) {
  if (!user) return false;
  if (isAdminRole(user.role)) return true;
  return hasAnyActiveSubscription(user.id);
}

function requireAnySubscription() {
  return async (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (isAdminRole(req.user.role)) return next();
    if (await hasAnyActiveSubscription(req.user.id)) return next();
    req.session.flash = 'The Design Studio is for subscribers — join a membership to combine your designs.';
    return res.redirect('/membership');
  };
}

module.exports = { loadUser, requireLogin, requireRole, requireHeadAdmin, requireSubscription, requireAnySubscription, hasActiveSubscription, hasAnyActiveSubscription, isActiveMember, isAdminRole, isHeadAdmin };
