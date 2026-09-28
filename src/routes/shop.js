// Tattoo shop area (requires active tattoo_shop subscription).
// Profile (location / hours / appointment requirements ONLY — screened),
// referral link + stats, commission dashboard (splits visible here ONLY),
// payout email setup.
const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { screenText } = require('../lib/screening');
const { payableBalance } = require('../lib/commissions');
const { registerPayoutRoutes, payoutDashboardData } = require('../lib/payoutRoutes');

const router = express.Router();
router.use(requireLogin, requireSubscription('tattoo_shop'));
registerPayoutRoutes(router, 'shop');

router.get('/', async (req, res) => {
  const profile = await db.get('SELECT * FROM shop_profiles WHERE user_id = ?', [req.user.id]) || {};
  const balance = await payableBalance('shop', req.user.id);
  const payouts = await db.all(
    "SELECT * FROM payouts WHERE recipient_type = 'shop' AND recipient_id = ? ORDER BY created_at DESC LIMIT 10",
    [req.user.id]);
  const ledger = await db.all(
    'SELECT * FROM commission_ledger WHERE recipient_type = ? AND recipient_id = ? ORDER BY created_at DESC LIMIT 25',
    ['shop', req.user.id]);
  const referrals = await db.all(
    'SELECT COUNT(*) AS n, COALESCE(SUM(amount_paid_cents),0) AS total FROM orders WHERE referred_shop_id = ? AND status = ?',
    [req.user.id, 'paid']);
  const refLink = profile.referral_code ? `${config.baseUrl}/?ref=${profile.referral_code}` : '';
  const payout = await payoutDashboardData(req.user.id, 'shop');
  res.render('shop/dashboard', {
    title: 'Shop Dashboard — Tattoo Art Customs',
    profile, balance, payouts, ledger, refLink,
    referralSales: referrals[0]?.n || 0, referralTotal: referrals[0]?.total || 0,
    metaDescription: '',
    ...payout,
  });
});

// Shop profile — ONLY location, hours, appointment requirements may be set.
// Location may include a street address (verified shops only); all fields
// still block emails, phones, links, socials, and payment info.
router.post('/profile', formLimiter, checkHoneypot, async (req, res) => {
  const fields = {
    business_name: String(req.body.business_name || '').trim().slice(0, 120),
    location: String(req.body.location || '').trim().slice(0, 200),
    hours: String(req.body.hours || '').trim().slice(0, 300),
    appointment_requirements: String(req.body.appointment_requirements || '').trim().slice(0, 600),
  };
  const locScreen = screenText(fields.location, { allow: ['street_address'] });
  const restScreen = screenText([fields.business_name, fields.hours, fields.appointment_requirements].join('\n'));
  const bad = [...locScreen.flags, ...restScreen.flags];
  if (bad.length) {
    req.session.flash = 'Blocked: shops may only list business location, hours, and appointment requirements — no emails, phones, links, socials, or payment info. (' +
      bad.map((f) => f.label).join(', ') + ')';
    return res.redirect('/shop');
  }
  const existing = await db.get('SELECT user_id FROM shop_profiles WHERE user_id = ?', [req.user.id]);
  if (existing) await db.updateWhere('shop_profiles', { ...fields, profile_status: 'ok' }, 'user_id', req.user.id);
  else await db.insert('shop_profiles', { user_id: req.user.id, ...fields, created_at: db.now() });
  req.session.flash = 'Shop profile updated.';
  res.redirect('/shop');
});

router.post('/payout-email', formLimiter, checkHoneypot, async (req, res) => {
  const email = String(req.body.paypal_email || '').trim().toLowerCase().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    req.session.flash = 'Enter a valid PayPal email.';
    return res.redirect('/shop');
  }
  const existing = await db.get('SELECT user_id FROM shop_profiles WHERE user_id = ?', [req.user.id]);
  if (existing) await db.updateWhere('shop_profiles', { payout_paypal_email: email }, 'user_id', req.user.id);
  else await db.insert('shop_profiles', { user_id: req.user.id, payout_paypal_email: email, created_at: db.now() });
  req.session.flash = 'Payout email saved.';
  res.redirect('/shop');
});

module.exports = router;
