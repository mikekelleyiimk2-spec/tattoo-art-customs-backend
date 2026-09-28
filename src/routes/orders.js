// Orders: premade checkout, custom design requests (deposit + 48h delivery),
// manual payment recording (CashApp/Venmo -> pending for admin), PayPal
// capture callbacks, and secure time-limited buyer downloads.
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const paypal = require('../lib/paypal');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const pricing = require('../lib/pricing');
const { premadePriceCents, isSaleWindow, salePriceActive } = pricing;
const { requireLogin, isActiveMember } = require('../middleware/auth');
const { recordSaleCommissions } = require('../lib/commissions');
const { routeCustomOrder } = require('../lib/customFulfillment');
const { onCustomPieceSold } = require('../lib/replacements');
const { onOrderPaid } = require('../lib/printful');

const router = express.Router();

function referralFromReq(req) {
  return String(req.cookies?.ref_code || req.body.referral_code || '').slice(0, 32);
}

async function resolveReferral(code) {
  if (!code) return null;
  const shop = await db.get('SELECT user_id FROM shop_profiles WHERE referral_code = ?', [code]);
  return shop ? shop.user_id : null;
}

// --- Premade + portfolio pieces: start checkout for a design ---
// Portfolio custom pieces are already-made art: they charge the current
// custom-design price (sale-aware) and deliver instantly like premade
// fulfillment — they NEVER go through the 48-hour made-to-order pipeline.
router.post('/buy/:designId', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const design = await db.get("SELECT * FROM designs WHERE id = ? AND status = 'approved'", [req.params.designId]);
  if (!design) return res.status(404).render('error', { title: 'Not found', message: 'That design is not available.' });
  // Member-exclusive designs are purchasable by active members only.
  const member = await isActiveMember(req.user);
  if (design.members_only && !member) {
    req.session.flash = 'That design is exclusive to members — join a membership to buy it.';
    return res.redirect('/membership');
  }
  const isCustom = design.listing_type === 'custom';
  // Members see the sale price from 6 PM Saturday (early entry).
  const listPrice = isCustom
    ? pricing.customFullCents(new Date(), member)
    : premadePriceCents(new Date(), member);
  // Linework-only purchase: the buyer chose it (3% discount), or the piece
  // has no color version (automatic 3%-off linework-only price).
  const lineworkOnly = design.color_source === 'none' || req.body.linework_only === '1';
  const price = lineworkOnly ? pricing.lineworkOnlyPriceCents(listPrice) : listPrice;
  const refCode = referralFromReq(req);
  // Processing fee (3.5% + $0.49) is added to the total — commissions are
  // computed on the base price only, so the business never absorbs the fee.
  const fee = pricing.processingFeeCents(price);
  const orderId = await db.insert('orders', {
    buyer_id: req.user.id, design_id: design.id, order_type: 'premade',
    amount_cents: price, fee_cents: fee, status: 'pending', payment_method: 'paypal',
    referral_code: refCode, referred_shop_id: await resolveReferral(refCode),
    linework_only: lineworkOnly ? 1 : 0,
    created_at: db.now(),
  });
  // Pay with site credit when requested and the balance covers it.
  if (req.body.use_credit) {
    try {
      const { payOrderWithCredit } = require('../lib/credits');
      const { order: paid } = await payOrderWithCredit({ userId: req.user.id, orderId });
      req.session.flash = 'Paid with site credit — your download is ready.';
      return res.redirect(`/orders/${paid.id}`);
    } catch (e) {
      req.session.flash = e.message + ' Continuing with PayPal below.';
    }
  }
  try {
    const pp = await paypal.createCheckoutOrder({
      amountCents: price + fee,
      description: `Tattoo Art Customs — "${design.title}"${lineworkOnly ? ' (linework only)' : ''}`,
      returnUrl: `${config.baseUrl}/orders/approve/${orderId}`,
      cancelUrl: `${config.baseUrl}/design/${design.id}`,
    });
    await db.update('orders', orderId, { paypal_order_id: pp.id });
    const approve = pp.links.find((l) => l.rel === 'approve');
    res.redirect(approve.href);
  } catch (e) {
    console.error('PayPal order create failed:', e.message);
    req.session.flash = 'PayPal checkout is unavailable right now — you can pay manually below.';
    res.redirect(`/orders/manual/${orderId}`);
  }
});

// --- Custom design request: brief + 50% deposit (Saturday-aware pricing) ---
router.get('/custom', requireLogin, async (req, res) => {
  const member = await isActiveMember(req.user);
  const full = pricing.customFullCents(new Date(), member);
  const deposit = pricing.customDepositCents(new Date(), member);
  // Tier-2 commission-suspended designers are hidden from the request-artist
  // dropdown (their listings stay up; only new commissions pause).
  // Shops opted into the free designer membership are listed as designers.
  const nowMs = Date.now();
  const artists = await db.all(
    `SELECT u.id, u.display_name FROM users u
     LEFT JOIN shop_profiles sp ON sp.user_id = u.id
     WHERE (u.role = 'design_artist' OR (u.role = 'tattoo_shop' AND sp.designer_opt_in = 1))
     AND (u.commission_suspended_until IS NULL OR u.commission_suspended_until <= ?)
     ORDER BY u.display_name`, [nowMs]);
  res.render('orders/custom', {
    title: 'Request a Custom Design — Tattoo Art Customs',
    deposit, full, sale: await salePriceActive(req.user), artists,
    depositFee: pricing.processingFeeCents(deposit),
    depositTotal: pricing.withFeeCents(deposit),
    fullTotal: pricing.withFeeCents(full),
    metaDescription: `Order a custom tattoo design — ${pricing.money(full)}, 50% deposit, 48-hour delivery.`,
  });
});
router.post('/custom', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const brief = String(req.body.brief || '').trim().slice(0, 4000);
  if (brief.length < 20) {
    req.session.flash = 'Describe your custom design in a bit more detail (20+ characters).';
    return res.redirect('/orders/custom');
  }
  const refCode = referralFromReq(req);
  const member = await isActiveMember(req.user);
  const full = pricing.customFullCents(new Date(), member);
  const deposit = pricing.customDepositCents(new Date(), member);
  // Optional: customer requests a specific design artist.
  let requestedArtistId = null;
  const wantArtist = String(req.body.requested_artist_id || '').trim();
  if (wantArtist) {
    const a = await db.get(
      `SELECT u.id FROM users u
       LEFT JOIN shop_profiles sp ON sp.user_id = u.id
       WHERE u.id = ? AND (u.role = 'design_artist' OR (u.role = 'tattoo_shop' AND sp.designer_opt_in = 1))
       AND (u.commission_suspended_until IS NULL OR u.commission_suspended_until <= ?)`,
      [wantArtist, Date.now()]);
    if (a) requestedArtistId = a.id;
  }
  const orderId = await db.insert('orders', {
    buyer_id: req.user.id, order_type: 'custom',
    amount_cents: full,
    deposit_cents: deposit,
    fee_cents: pricing.processingFeeCents(deposit), // fee on the deposit (the amount actually charged)
    status: 'pending', payment_method: 'paypal',
    referral_code: refCode, referred_shop_id: await resolveReferral(refCode),
    custom_brief: brief,
    requested_artist_id: requestedArtistId,
    custom_status: 'new',
    delivery_due: Date.now() + 48 * 3600 * 1000,
    created_at: db.now(),
  });
  // Pay the deposit with site credit when requested.
  if (req.body.use_credit) {
    try {
      const { payOrderWithCredit } = require('../lib/credits');
      const { order: paid } = await payOrderWithCredit({ userId: req.user.id, orderId });
      req.session.flash = 'Deposit paid with site credit — your custom request is in.';
      return res.redirect(`/orders/${paid.id}`);
    } catch (e) {
      req.session.flash = e.message + ' Continuing with PayPal below.';
    }
  }
  try {
    const pp = await paypal.createCheckoutOrder({
      amountCents: deposit + pricing.processingFeeCents(deposit),
      description: 'Tattoo Art Customs — custom design deposit (50%)',
      returnUrl: `${config.baseUrl}/orders/approve/${orderId}`,
      cancelUrl: `${config.baseUrl}/orders/custom`,
    });
    await db.update('orders', orderId, { paypal_order_id: pp.id });
    const approve = pp.links.find((l) => l.rel === 'approve');
    res.redirect(approve.href);
  } catch (e) {
    console.error('PayPal order create failed:', e.message);
    req.session.flash = 'PayPal checkout is unavailable right now — you can pay the deposit manually below.';
    res.redirect(`/orders/manual/${orderId}`);
  }
});

// --- Manual payment (CashApp/Venmo): record as pending for admin ---
router.get('/manual/:orderId', requireLogin, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', [req.params.orderId, req.user.id]);
  if (!order) return res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
  res.render('orders/manual', { title: 'Pay manually — Tattoo Art Customs', order, metaDescription: '' });
});
router.post('/manual/:orderId', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', [req.params.orderId, req.user.id]);
  if (!order || order.status !== 'pending') return res.redirect('/account');
  const method = ['cashapp', 'venmo', 'paypal'].includes(req.body.method) ? req.body.method : 'manual';
  const note = String(req.body.note || '').trim().slice(0, 300);
  const brief = (order.custom_brief || '') + `\n[manual note: ${note}]`;
  await db.update('orders', order.id, { payment_method: method, custom_brief: brief });
  req.session.flash = 'Recorded. An admin will confirm your manual payment, then your download unlocks.';
  res.redirect('/account');
});

// --- PayPal return: capture ---
router.get('/approve/:orderId', requireLogin, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', [req.params.orderId, req.user.id]);
  if (!order) return res.redirect('/account');
  if (order.status === 'paid') return res.redirect(`/orders/${order.id}`);
  try {
    const capture = await paypal.captureCheckoutOrder(order.paypal_order_id);
    const captured = capture.purchase_units?.[0]?.payments?.captures?.[0];
    const paidCents = Math.round(parseFloat(captured?.amount?.value || '0') * 100);
    await db.update('orders', order.id, {
      status: 'paid', amount_paid_cents: paidCents, paid_at: db.now(),
    });
    const fresh = await db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
    await recordSaleCommissions(fresh);
    const fulfil = await onOrderPaid(fresh);
    await routeCustomOrder(fresh);
    await onCustomPieceSold(fresh); // sold custom pieces delist + queue a replacement
    req.session.flash = order.order_type === 'custom'
      ? 'Deposit received — your custom request is in. Your design will be delivered within 48 hours.'
      : 'Payment received — your download is ready.';
    req.session.flash +=
      (fulfil.submitted ? ' Your print was sent to the printer automatically.' : '');
    res.redirect(`/orders/${order.id}`);
  } catch (e) {
    req.session.flash = 'Payment capture failed: ' + e.message;
    res.redirect('/account');
  }
});

// --- Order detail + secure download token ---
router.get('/:orderId', requireLogin, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.orderId]);
  if (!order || (order.buyer_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
  }
  const design = order.design_id ? await db.get('SELECT title FROM designs WHERE id = ?', [order.design_id]) : null;
  const downloads = await db.all('SELECT * FROM downloads WHERE order_id = ? ORDER BY created_at DESC', [order.id]);
  res.render('orders/detail', { title: `Order ${order.id.slice(0, 8)} — Tattoo Art Customs`, order, design, downloads, metaDescription: '' });
});

router.post('/:orderId/download-token', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', [req.params.orderId, req.user.id]);
  if (!order || order.status !== 'paid') {
    req.session.flash = 'Downloads unlock once the order is paid.';
    return res.redirect('/account');
  }
  const token = crypto.randomBytes(24).toString('hex');
  await db.insert('downloads', {
    order_id: order.id, token, expires_at: Date.now() + 24 * 3600 * 1000, created_at: db.now(),
  });
  res.redirect(`/orders/download/${token}/view`);
});

// Serves the CLEAN color + linework files. Never linked publicly; the token
// expires after 24h. (Design delivered as the color file; linework included
// in the same response via the second link on the download page.)
router.get('/download/:token', async (req, res) => {
  const dl = await db.get('SELECT * FROM downloads WHERE token = ?', [req.params.token]);
  if (!dl || dl.expires_at < Date.now()) {
    return res.status(410).render('error', { title: 'Link expired', message: 'This download link has expired. Generate a new one from your order page.' });
  }
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [dl.order_id]);
  if (!order || order.status !== 'paid') return res.status(403).render('error', { title: 'Forbidden', message: 'This order is not paid.' });
  const which = req.query.file === 'linework' ? 'linework' : 'color';
  // Linework-only purchases never unlock the color version.
  if (order.linework_only && which === 'color') {
    return res.status(403).render('error', {
      title: 'Not included',
      message: 'You purchased the clean linework only — the color version is not included in this order.',
    });
  }
  let absPath = null;
  if (order.order_type === 'premade' && order.design_id) {
    const design = await db.get('SELECT color_path, linework_path FROM designs WHERE id = ?', [order.design_id]);
    if (!design) return res.status(404).render('error', { title: 'Not found', message: 'Design files are missing.' });
    const rel = which === 'linework' ? design.linework_path : design.color_path;
    absPath = path.join(config.assetDir, rel);
  } else {
    // Custom orders: admin attaches the finished files to the order record
    // (stored under uploads/designs/); served the same secure way.
    const rel = which === 'linework' ? order.custom_linework_path : order.custom_color_path;
    if (!rel) return res.status(404).render('error', { title: 'Not ready', message: 'Your custom design is still being created — check back soon.' });
    absPath = path.join(config.assetDir, rel);
  }
  if (!absPath || !fs.existsSync(absPath)) {
    return res.status(404).render('error', { title: 'Not found', message: 'Design files are missing.' });
  }
  res.download(absPath);
});

// Download landing page (shows both file links for a token).
router.get('/download/:token/view', async (req, res) => {
  const dl = await db.get('SELECT * FROM downloads WHERE token = ?', [req.params.token]);
  if (!dl || dl.expires_at < Date.now()) {
    return res.status(410).render('error', { title: 'Link expired', message: 'This download link has expired.' });
  }
  const order = await db.get('SELECT linework_only FROM orders WHERE id = ?', [dl.order_id]);
  res.render('orders/download', {
    title: 'Your download — Tattoo Art Customs', token: req.params.token,
    lineworkOnly: !!(order && order.linework_only), metaDescription: '',
  });
});

module.exports = router;
