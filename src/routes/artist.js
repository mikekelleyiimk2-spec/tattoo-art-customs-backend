// Design artist area (requires active design_artist subscription).
// Uploads, bio editor (screened), commission dashboard (splits visible
// here ONLY — never to customers), payout email setup.
const express = require('express');
const db = require('../db');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { screenText } = require('../lib/screening');
const { payableBalance } = require('../lib/commissions');
const { registerPayoutRoutes, payoutDashboardData } = require('../lib/payoutRoutes');
const { upsertProfile } = require('../lib/profiles');

const router = express.Router();
router.use(requireLogin, requireSubscription('design_artist'));
registerPayoutRoutes(router, 'artist');

// Note 2026-09-28: art uploads moved to /account/upload — free for every
// logged-in account; admin approval still required before going live.

router.get('/', async (req, res) => {
  const designs = await db.all('SELECT * FROM designs WHERE artist_id = ? ORDER BY created_at DESC', [req.user.id]);
  const profile = await db.get('SELECT * FROM artist_profiles WHERE user_id = ?', [req.user.id]) || {};
  const balance = await payableBalance('artist', req.user.id);
  const payouts = await db.all(
    "SELECT * FROM payouts WHERE recipient_type = 'artist' AND recipient_id = ? ORDER BY created_at DESC LIMIT 10",
    [req.user.id]);
  const ledger = await db.all(
    'SELECT * FROM commission_ledger WHERE recipient_type = ? AND recipient_id = ? ORDER BY created_at DESC LIMIT 25',
    ['artist', req.user.id]);
  const payout = await payoutDashboardData(req.user.id, 'artist');
  // SLA banner: this artist's at-risk (<24h) and overdue custom orders.
  const nowMs = Date.now();
  const slaRows = await db.all(
    `SELECT id, custom_brief, delivery_due, custom_status, late_penalty_days
     FROM orders WHERE order_type = 'custom' AND status = 'paid'
     AND requested_artist_id = ? AND custom_status NOT IN ('delivered')
     AND delivery_due IS NOT NULL ORDER BY delivery_due ASC`, [req.user.id]);
  const slaOrders = [];
  for (const o of slaRows) {
    const pen = await db.get(
      `SELECT COALESCE(SUM(deduction_cents),0) AS t FROM sla_penalties WHERE order_id = ?`, [o.id]);
    const msLeft = o.delivery_due - nowMs;
    const daysLate = Math.max(0, Math.floor(-msLeft / 86400000));
    if (daysLate > 0 || msLeft <= 24 * 3600 * 1000) {
      slaOrders.push({
        id: o.id, brief: (o.custom_brief || '').slice(0, 80),
        status: (o.custom_status || '').replace(/_/g, ' '),
        days_late: daysLate, hours_left: Math.max(0, Math.floor(msLeft / 3600000)),
        penalty_cents: pen.t,
      });
    }
  }
  res.render('artist/dashboard', {
    title: 'Artist Dashboard — Tattoo Art Customs',
    designs: designs.map((d) => ({ ...d, categories: JSON.parse(d.categories || '[]') })),
    profile, balance, payouts, ledger, metaDescription: '',
    slaOrders, nowMs,
    ...payout,
  });
});

router.get('/upload', (req, res) => res.redirect('/account/upload'));
router.post('/upload', (req, res) => res.redirect(307, '/account/upload'));
// Note 2026-09-28: uploads moved to /account/upload — free for every
// logged-in account; admin approval still required before going live.

// Bio editor — screened; blocked on contact info, flagged for review.
router.post('/bio', formLimiter, checkHoneypot, async (req, res) => {
  const bio = String(req.body.bio || '').trim().slice(0, 2000);
  const screen = screenText(bio);
  const data = { bio, bio_status: screen.ok ? 'ok' : 'flagged' };
  await upsertProfile('artist_profiles', req.user.id, data);
  if (!screen.ok) {
    await db.insert('review_queue', {
      item_type: 'bio', item_id: req.user.id,
      reason: 'Contact info detected in bio: ' + screen.flags.map((f) => f.label).join(', '),
      status: 'open', created_at: db.now(),
    });
    req.session.flash = 'Bio saved but flagged for review — remove any contact info or off-site links.';
  } else {
    req.session.flash = 'Bio updated.';
  }
  res.redirect('/artist');
});

// Payout method (PayPal email).
router.post('/payout-email', formLimiter, checkHoneypot, async (req, res) => {
  const email = String(req.body.paypal_email || '').trim().toLowerCase().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    req.session.flash = 'Enter a valid PayPal email.';
    return res.redirect('/artist');
  }
  await upsertProfile('artist_profiles', req.user.id, { payout_paypal_email: email });
  req.session.flash = 'Payout email saved. You become payable once registered, subscribed, and this is set.';
  res.redirect('/artist');
});

module.exports = router;
