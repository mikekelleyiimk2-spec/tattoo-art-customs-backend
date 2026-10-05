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
const { upsertProfile } = require('../lib/profiles');
const { dualSubBonusActive } = require('./shopDesigner');

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
  const me = await db.get(
    'SELECT is_founding_shop, founding_shop_ends_at FROM users WHERE id = ?', [req.user.id]);
  const dualBonus = await dualSubBonusActive(req.user.id);
  // Tap-to-pay standalone billing status card.
  const { getTapSub, tapComped, tapActive, TIERS } = require('../lib/tapBilling');
  const tapSub = await getTapSub(req.user.id);
  const tapIsComped = await tapComped(req.user.id);
  const tapIsActive = await tapActive(req.user.id);
  const tapTier = tapSub ? TIERS[tapSub.tier] : null;
  // Referral volume tier: current rate + progress to the next tier.
  const { shopReferralTier } = require('./shopIncentives');
  const tier = await shopReferralTier(req.user.id);
  // Client-art inbox: transfers customers sent to this shop (Phase 1).
  const myEmail = (await db.get('SELECT email FROM users WHERE id = ?', [req.user.id]) || {}).email || '';
  const artInbox = await db.all(
    `SELECT t.*, d.title AS design_title, u.display_name AS from_name
     FROM art_transfers t
     LEFT JOIN designs d ON d.id = t.design_id
     LEFT JOIN users u ON u.id = t.from_user_id
     WHERE (t.to_shop_user_id = ? OR LOWER(t.to_email) = LOWER(?))
       AND t.kind = 'to_shop'
     ORDER BY t.created_at DESC LIMIT 25`,
    [req.user.id, myEmail]);
  // Client bills (Phase 2): art the shop bought for clients, to collect.
  const clientBills = await db.all(
    `SELECT b.*, d.title AS design_title
     FROM client_bills b
     LEFT JOIN orders o ON o.id = b.order_id
     LEFT JOIN designs d ON d.id = o.design_id
     WHERE b.shop_user_id = ?
     ORDER BY b.created_at DESC LIMIT 25`,
    [req.user.id]);
  // Client-linked purchases (Phase 2): orders this shop bought for clients.
  const clientOrders = await db.all(
    `SELECT o.*, d.title AS design_title
     FROM orders o
     LEFT JOIN designs d ON d.id = o.design_id
     WHERE o.buyer_id = ? AND o.client_email IS NOT NULL AND o.client_email != ''
     ORDER BY o.created_at DESC LIMIT 25`,
    [req.user.id]);
  res.render('shop/dashboard', {
    title: 'Shop Dashboard — Tattoo Art Customs',
    profile, balance, payouts, ledger, refLink,
    referralSales: referrals[0]?.n || 0, referralTotal: referrals[0]?.total || 0,
    isFoundingShop: !!(me && me.is_founding_shop),
    foundingEndsAt: me && me.founding_shop_ends_at,
    dualBonus,
    tier,
    tapSub, tapIsComped, tapIsActive, tapTier, tapTiers: TIERS,
    artInbox, clientBills, clientOrders,
    ...payout,
  });
});

// Mark a client bill paid (Phase 2: the shop collected the art cost from the client).
router.post('/client-bills/:billId/paid', formLimiter, checkHoneypot, async (req, res) => {
  const bill = await db.get('SELECT * FROM client_bills WHERE id = ? AND shop_user_id = ?', [req.params.billId, req.user.id]);
  if (!bill || bill.status === 'paid') {
    req.session.flash = 'That bill was not found.';
    return res.redirect('/shop');
  }
  await db.update('client_bills', bill.id, { status: 'paid', paid_at: Date.now() });
  req.session.flash = 'Bill marked paid.';
  res.redirect('/shop');
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
  await upsertProfile('shop_profiles', req.user.id, { ...fields, profile_status: 'ok' });
  req.session.flash = 'Shop profile updated.';
  res.redirect('/shop');
});

router.post('/payout-email', formLimiter, checkHoneypot, async (req, res) => {
  const email = String(req.body.paypal_email || '').trim().toLowerCase().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    req.session.flash = 'Enter a valid PayPal email.';
    return res.redirect('/shop');
  }
  await upsertProfile('shop_profiles', req.user.id, { payout_paypal_email: email });
  req.session.flash = 'Payout email saved.';
  res.redirect('/shop');
});

module.exports = router;
