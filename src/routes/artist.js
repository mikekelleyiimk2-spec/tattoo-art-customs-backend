// Design artist area (requires active design_artist subscription).
// Uploads, bio editor (screened), commission dashboard (splits visible
// here ONLY — never to customers), payout email setup.
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const config = require('../config');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { screenText } = require('../lib/screening');
const { payableBalance } = require('../lib/commissions');
const slaEnforcer = require('../lib/slaEnforcer');
const { commissionSuspendedUntil } = require('../lib/commissions');
const { registerPayoutRoutes, payoutDashboardData } = require('../lib/payoutRoutes');
const { upsertProfile } = require('../lib/profiles');
const pricing = require('../lib/pricing');
const { DESIGN_STYLES, portfolioUploadMulter, handlePortfolioUpload } = require('../lib/portfolioUpload');

const router = express.Router();
router.use(requireLogin, requireSubscription('design_artist'));
registerPayoutRoutes(router, 'artist');

// Note 2026-09-28: designer portfolio uploads live here (subscription-gated).
// /account/upload stays the free path for every logged-in member.

router.get('/portfolio', async (req, res) => {
  const designs = await db.all(
    'SELECT * FROM designs WHERE artist_id = ? ORDER BY created_at DESC', [req.user.id]);
  res.render('artist/portfolio', {
    title: 'My portfolio — Tattoo Art Customs',
    designs: designs.map((d) => ({ ...d, categories: JSON.parse(d.categories || '[]') })),
    userId: req.user.id,
    customPrice: pricing.customFullCents(), premadePrice: pricing.premadePriceCents(),
    metaDescription: '',
  });
});

router.get('/portfolio/upload', (req, res) => res.render('artist/portfolio-upload', {
  title: 'Upload a new piece — Tattoo Art Customs',
  styles: DESIGN_STYLES, action: '/artist/portfolio/upload',
  customPrice: pricing.customFullCents(), premadePrice: pricing.premadePriceCents(),
  metaDescription: '',
}));

router.post('/portfolio/upload', formLimiter, (req, res, next) => {
  portfolioUploadMulter(req, res, (err) => {
    if (err) { req.session.flash = err.message; return res.redirect('/artist/portfolio/upload'); }
    next();
  });
}, checkHoneypot, async (req, res) => {
  await handlePortfolioUpload(req, res, '/artist/portfolio/upload');
});

router.get('/portfolio/:id/edit', async (req, res) => {
  const design = await db.get('SELECT * FROM designs WHERE id = ? AND artist_id = ?', [req.params.id, req.user.id]);
  if (!design) return res.status(404).render('error', { title: 'Not found', message: 'That piece is not in your portfolio.' });
  const cats = JSON.parse(design.categories || '[]');
  res.render('artist/portfolio-edit', {
    title: 'Edit piece — Tattoo Art Customs',
    design, styles: DESIGN_STYLES,
    extraCats: cats.filter((c) => c !== design.style).join(', '),
    metaDescription: '',
  });
});

router.post('/portfolio/:id/edit', formLimiter, checkHoneypot, async (req, res) => {
  const design = await db.get('SELECT * FROM designs WHERE id = ? AND artist_id = ?', [req.params.id, req.user.id]);
  if (!design) return res.status(404).render('error', { title: 'Not found', message: 'That piece is not in your portfolio.' });
  const title = String(req.body.title || '').trim().slice(0, 120);
  if (!title) { req.session.flash = 'Give your design a title.'; return res.redirect(`/artist/portfolio/${design.id}/edit`); }
  const style = String(req.body.style || '').trim().toLowerCase();
  if (!DESIGN_STYLES.includes(style)) { req.session.flash = 'Pick a style.'; return res.redirect(`/artist/portfolio/${design.id}/edit`); }
  const description = String(req.body.description || '').trim().slice(0, 2000);
  const extraCats = String(req.body.categories || '').split(',')
    .map((c) => c.trim().toLowerCase().replace(/[^a-z0-9- ]/g, '').slice(0, 40))
    .filter(Boolean).filter((c) => c !== style).slice(0, 11);
  const screen = screenText(`${title}\n${description}`);
  await db.update('designs', design.id, {
    title, description, style, categories: JSON.stringify([style, ...extraCats]),
  });
  if (!screen.ok) {
    await db.insert('review_queue', {
      item_type: 'design', item_id: design.id,
      reason: 'Contact info detected in edited title/description: ' + screen.flags.map((f) => f.label).join(', '),
      status: 'open', created_at: db.now(),
    });
    req.session.flash = 'Saved, but flagged for review (possible contact info). An admin will review it.';
  } else {
    req.session.flash = 'Piece updated.';
  }
  res.redirect('/artist/portfolio');
});

router.post('/portfolio/:id/delete', formLimiter, checkHoneypot, async (req, res) => {
  const design = await db.get('SELECT * FROM designs WHERE id = ? AND artist_id = ?', [req.params.id, req.user.id]);
  if (!design) return res.status(404).render('error', { title: 'Not found', message: 'That piece is not in your portfolio.' });
  const paid = await db.get("SELECT id FROM orders WHERE design_id = ? AND status = 'paid' LIMIT 1", [design.id]);
  if (paid || (design.sale_count || 0) > 0) {
    req.session.flash = 'This piece has sales and cannot be deleted — contact an administrator.';
    return res.redirect('/artist/portfolio');
  }
  for (const p of [design.color_path, design.linework_path, design.linework_wm_path, design.custom_watermark_path]) {
    if (p) { try { fs.unlinkSync(path.join(config.assetDir, p)); } catch { /* already gone */ } }
  }
  await db.query('DELETE FROM designs WHERE id = ?', [design.id]);
  req.session.flash = 'Piece deleted.';
  res.redirect('/artist/portfolio');
});

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
  // Terminated orders are excluded — the artist's assignment on those ended.
  const nowMs = Date.now();
  const slaRows = await db.all(
    `SELECT id, custom_brief, delivery_due, custom_status, late_penalty_days
     FROM orders WHERE order_type = 'custom' AND status = 'paid'
     AND requested_artist_id = ? AND custom_status NOT IN ('delivered', 'order_terminated')
     AND delivery_due IS NOT NULL ORDER BY delivery_due ASC`, [req.user.id]);
  const slaOrders = [];
  const slaRepeat = await slaEnforcer.repeatOffenderInfo(req.user.id, nowMs);
  // Tier 2: commission suspension notice (plain, warm — account stays active).
  const commissionPausedUntil = await commissionSuspendedUntil(req.user.id, nowMs);
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
    slaOrders, slaRepeat, repeatNotice: slaEnforcer.REPEAT_OFFENDER_NOTICE, nowMs,
    commissionPausedUntil,
    ...payout,
  });
});

router.get('/upload', (req, res) => res.redirect('/artist/portfolio/upload'));
router.post('/upload', (req, res) => res.redirect(307, '/artist/portfolio/upload'));
// Note 2026-09-28: designer portfolio uploads live at /artist/portfolio/upload
// (subscription-gated). /account/upload stays the free path for members.

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
