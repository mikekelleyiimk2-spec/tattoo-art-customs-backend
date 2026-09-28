// Auth + role + subscription guards.
const db = require('../db');

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
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!roles.includes(req.user.role) && req.user.role !== 'admin') {
      return res.status(403).render('error', { title: 'Forbidden', message: 'Your account cannot access this page.' });
    }
    next();
  };
}

// Active subscription to a given plan slug (admin bypasses).
async function hasActiveSubscription(userId, planSlug) {
  const row = await db.get(
    `SELECT s.id FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = ? AND p.slug = ? AND s.status = 'active'
       AND (s.current_period_end IS NULL OR s.current_period_end > ?)`,
    [userId, planSlug, Date.now()]);
  return !!row;
}

function requireSubscription(planSlug) {
  return async (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.role === 'admin') return next();
    if (await hasActiveSubscription(req.user.id, planSlug)) return next();
    const plan = await db.get('SELECT name FROM plans WHERE slug = ?', [planSlug]);
    req.session.flash = `This requires an active ${plan ? plan.name : 'membership'}.`;
    return res.redirect('/membership');
  };
}

module.exports = { loadUser, requireLogin, requireRole, requireSubscription, hasActiveSubscription };
