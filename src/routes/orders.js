// Orders: premade checkout, custom design requests (deposit + 48h delivery),
// manual payment recording (CashApp/Venmo -> pending for admin), PayPal
// capture callbacks, and secure time-limited buyer downloads.
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const config = require('../config');
const { resolveStoredPath } = require('../lib/storage');
const paypal = require('../lib/paypal');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const pricing = require('../lib/pricing');
const { premadePriceCents, isSaleWindow, salePriceActive } = pricing;
const { requireLogin, isActiveMember, isCustomerMember, requireSubscription } = require('../middleware/auth');
const { recordSaleCommissions } = require('../lib/commissions');
const { resolveShopReferral } = require('../shop/attribution');
const { routeCustomOrder } = require('../lib/customFulfillment');
const { onCustomPieceSold } = require('../lib/replacements');
const { onOrderPaid } = require('../lib/printful');
const { fulfillPremadeOrder, sendCustomDepositReceipt } = require('../lib/fulfillment');
const firstCustom = require('../lib/firstCustom');

const router = express.Router();

function referralFromReq(req) {
  return String(req.cookies?.ref_code || req.body.referral_code || '').slice(0, 32);
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
  // Request-only designs are never instant-buy — they go through custom orders.
  if (design.request_only) {
    req.session.flash = 'That design is available by request only — submit a custom order request and we will deliver it.';
    return res.redirect(`/orders/custom?design=${encodeURIComponent(design.id)}`);
  }
  const isCustom = design.listing_type === 'custom';
  // Best-deal-wins at checkout: Saturday sale, the standing 20% CUSTOMER
  // member discount, or regular — never stacked. (The one-time first-custom
  // discount applies only to made-to-order customs via POST /custom, never
  // to already-made portfolio pieces here. member_20 is customer-plan only:
  // artists, shops, and admins never get it — see isCustomerMember.)
  const saleOn = await pricing.salePriceActive(req.user);
  const customerMember = await isCustomerMember(req.user);
  let listPrice, discountApplied;
  if (saleOn) {
    listPrice = isCustom
      ? pricing.customFullCents(new Date(), member)
      : premadePriceCents(new Date(), member);
    discountApplied = 'saturday_sale';
  } else if (customerMember) {
    listPrice = isCustom ? pricing.memberCustomFullCents() : pricing.memberPremadeCents();
    discountApplied = pricing.MEMBER_DISCOUNT_CODE;
  } else {
    listPrice = isCustom
      ? pricing.customFullCents(new Date(), member)
      : premadePriceCents(new Date(), member);
    discountApplied = null;
  }
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
    referral_code: refCode, referred_shop_id: await resolveShopReferral(refCode),
    linework_only: lineworkOnly ? 1 : 0,
    discount_applied: discountApplied,
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

// --- Shop "buy for client" (Phase 2): a shop with an active tattoo_shop
// subscription purchases a premade design at FULL price for a client. The
// buying shop earns NO referral commission on its own purchase
// (referred_shop_id is forced to NULL; see the buyer guard in
// recordSaleCommissions). The art cost lands on a client bill for the shop
// to collect (created when the order is paid).
router.post('/buy-for-client/:designId', requireLogin, requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  const design = await db.get("SELECT * FROM designs WHERE id = ? AND status = 'approved'", [req.params.designId]);
  if (!design) return res.status(404).render('error', { title: 'Not found', message: 'That design is not available.' });
  const clientEmail = String(req.body.client_email || '').trim().toLowerCase().slice(0, 160);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clientEmail)) {
    req.session.flash = 'Enter the client\u2019s email address so the art can be billed and delivered to them.';
    return res.redirect(`/design/${design.id}`);
  }
  const member = await isActiveMember(req.user);
  if (design.members_only && !member) {
    req.session.flash = 'That design is exclusive to members — join a membership to buy it.';
    return res.redirect('/membership');
  }
  const isCustom = design.listing_type === 'custom';
  const listPrice = isCustom
    ? pricing.customFullCents(new Date(), member)
    : premadePriceCents(new Date(), member);
  const lineworkOnly = design.color_source === 'none' || req.body.linework_only === '1';
  const price = lineworkOnly ? pricing.lineworkOnlyPriceCents(listPrice) : listPrice;
  const fee = pricing.processingFeeCents(price);
  // Link the client's site account when they have one.
  const clientUser = await db.get('SELECT id FROM users WHERE email = ?', [clientEmail]);
  const orderId = await db.insert('orders', {
    buyer_id: req.user.id, design_id: design.id, order_type: 'premade',
    amount_cents: price, fee_cents: fee, status: 'pending', payment_method: 'paypal',
    referral_code: '', referred_shop_id: null,
    linework_only: lineworkOnly ? 1 : 0,
    client_email: clientEmail, client_user_id: clientUser ? clientUser.id : null,
    created_at: db.now(),
  });
  try {
    const pp = await paypal.createCheckoutOrder({
      amountCents: price + fee,
      description: `Tattoo Art Customs — "${design.title}"${lineworkOnly ? ' (linework only)' : ''} (for client ${clientEmail})`,
      returnUrl: `${config.baseUrl}/orders/approve/${orderId}`,
      cancelUrl: `${config.baseUrl}/design/${design.id}`,
    });
    await db.update('orders', orderId, { paypal_order_id: pp.id });
    const approve = pp.links.find((l) => l.rel === 'approve');
    res.redirect(approve.href);
  } catch (e) {
    console.error('PayPal order create failed:', e.message);
    req.session.flash = 'PayPal checkout is unavailable right now — please try again in a moment.';
    res.redirect(`/design/${design.id}`);
  }
});

// --- Custom design request: brief + 50% deposit (Saturday-aware pricing,
// the one-time 20%-off-first-custom subscriber discount, and the standing
// 20%-off customer-member discount: best-deal-wins, never stacked) ---
router.get('/custom', requireLogin, async (req, res) => {
  const quote = await firstCustom.customPriceQuote(req.user);
  const full = quote.full;
  const deposit = quote.deposit;
  // Pre-fill from a request-only design (?design=<id>): the brief names the
  // design so the custom order fulfills that specific piece.
  let designBrief = '';
  let designTitle = '';
  const designParam = String(req.query.design || '').trim().slice(0, 64);
  if (designParam) {
    const d = await db.get(
      "SELECT id, title FROM designs WHERE id = ? AND status = 'approved' AND request_only = 1",
      [designParam]
    );
    if (d) {
      designTitle = d.title;
      designBrief = `Request-only design "${d.title}" (ID: ${d.id}) — please deliver the black linework and full-color versions.`;
    }
  }
  // Tier-2 commission-suspended designers are hidden from the request-artist
  // dropdown (their listings stay up; only new commissions pause).
  // Shops opted into the free designer membership are listed as designers.
  const nowMs = Date.now();
  const artists = await db.all(
    `SELECT u.id, u.display_name FROM users u
     LEFT JOIN shop_profiles sp ON sp.user_id = u.id
     WHERE u.role IN ('design_artist','tattoo_shop','admin','head_admin')
     AND (u.commission_suspended_until IS NULL OR u.commission_suspended_until <= ?)
     ORDER BY u.display_name`, [nowMs]);
  res.render('orders/custom', {
    title: 'Request a Custom Design — Tattoo Art Customs',
    deposit, full, sale: quote.sale, artists,
    designBrief, designTitle,
    firstCustom: quote.discount === firstCustom.FIRST_CUSTOM_DISCOUNT_CODE,
    depositFee: pricing.processingFeeCents(deposit),
    depositTotal: pricing.withFeeCents(deposit),
    fullTotal: pricing.withFeeCents(full),
    rushFee: pricing.RUSH_FEE_CENTS,
    rushSlaHours: pricing.RUSH_SLA_HOURS,
    rushDepositTotal: pricing.withFeeCents(deposit + pricing.RUSH_FEE_CENTS),
    metaDescription: `Order a custom tattoo design — ${pricing.money(full)}, 50% deposit, 48-hour delivery (24-hour rush available).`,
  });
});
router.post('/custom', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const brief = String(req.body.brief || '').trim().slice(0, 4000);
  if (brief.length < 20) {
    req.session.flash = 'Describe your custom design in a bit more detail (20+ characters).';
    return res.redirect('/orders/custom');
  }
  // Idempotency: rapid double-clicks used to stack identical pending orders.
  // If this user already opened the same request in the last 2 minutes,
  // send them to it instead of creating another.
  const dupe = await db.get(
    `SELECT id FROM orders WHERE buyer_id = ? AND order_type = 'custom'
     AND status = 'pending' AND custom_brief = ? AND created_at > ?`,
    [req.user.id, brief, Date.now() - 2 * 60 * 1000]);
  if (dupe) {
    req.session.flash = 'That request is already in — here it is.';
    return res.redirect(`/orders/${dupe.id}`);
  }
  const refCode = referralFromReq(req);
  // Best-deal-wins custom quote: regular, Saturday sale, or the one-time
  // 20%-off-first-custom subscriber discount — never stacked. The order id
  // is minted up front so the discount redemption can be recorded atomically
  // with order creation (exactly-once via UNIQUE(user_id)).
  const newOrderId = db.newId();
  let quote = await firstCustom.customPriceQuote(req.user);
  let discountApplied = quote.discount;
  if (discountApplied === firstCustom.FIRST_CUSTOM_DISCOUNT_CODE) {
    const redeemed = await firstCustom.redeemFirstCustomDiscount(req.user.id, newOrderId);
    if (!redeemed) {
      // Lost a redemption race (already redeemed elsewhere): fall back to
      // the non-discounted price — the discount is never double-issued.
      quote = await firstCustom.customPriceQuote(req.user);
      discountApplied = quote.discount;
    }
  }
  const full = quote.full;
  const deposit = quote.deposit;
  // Rush option (owner rule 2026-09-30): +$30 for 24-hour delivery instead
  // of the standard 48h. The rush fee is disclosed at checkout and included
  // in the processing-fee pass-through.
  const rush = req.body.rush === '1';
  const rushFee = rush ? pricing.RUSH_FEE_CENTS : 0;
  const depositCharge = deposit + rushFee;
  // Optional: customer requests a specific design artist.
  let requestedArtistId = null;
  const wantArtist = String(req.body.requested_artist_id || '').trim();
  if (wantArtist) {
    const a = await db.get(
      `SELECT u.id FROM users u
       LEFT JOIN shop_profiles sp ON sp.user_id = u.id
       WHERE u.id = ? AND u.role IN ('design_artist','tattoo_shop','admin','head_admin')
       AND (u.commission_suspended_until IS NULL OR u.commission_suspended_until <= ?)`,
      [wantArtist, Date.now()]);
    if (a) requestedArtistId = a.id;
  }
  const orderId = await db.insert('orders', {
    id: newOrderId,
    buyer_id: req.user.id, order_type: 'custom',
    amount_cents: full,
    deposit_cents: deposit,
    rush_fee_cents: rushFee,
    fee_cents: pricing.processingFeeCents(depositCharge), // fee on the amount actually charged (deposit + rush)
    discount_applied: discountApplied,
    status: 'pending', payment_method: 'paypal',
    referral_code: refCode, referred_shop_id: await resolveShopReferral(refCode),
    custom_brief: brief,
    requested_artist_id: requestedArtistId,
    custom_status: 'new',
    delivery_due: Date.now() + (rush ? pricing.RUSH_SLA_HOURS : pricing.STANDARD_SLA_HOURS) * 3600 * 1000,
    created_at: db.now(),
  });
  // Pay the deposit with site credit when requested.
  if (req.body.use_credit) {
    try {
      const { payOrderWithCredit } = require('../lib/credits');
      const { order: paid } = await payOrderWithCredit({ userId: req.user.id, orderId });
      req.session.flash = rush
        ? 'Deposit paid with site credit — your RUSH custom request is in. Your design will be delivered within 24 hours.'
        : 'Deposit paid with site credit — your custom request is in.';
      return res.redirect(`/orders/${paid.id}`);
    } catch (e) {
      req.session.flash = e.message + ' Continuing with PayPal below.';
    }
  }
  try {
    const pp = await paypal.createCheckoutOrder({
      amountCents: depositCharge + pricing.processingFeeCents(depositCharge),
      description: rush
        ? 'Tattoo Art Customs — custom design deposit (50%) + 24-hour rush'
        : 'Tattoo Art Customs — custom design deposit (50%)',
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
  res.render('orders/manual', { title: 'Pay manually — Tattoo Art Customs', order });
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

// --- Manual page: pay the exact order total with PayPal (one-time) ---
// Replaces the old hosted subscription button: the buyer never types an
// amount — the order total (price + processing fee) is charged exactly.
router.post('/manual/:orderId/paypal', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', [req.params.orderId, req.user.id]);
  if (!order || order.status !== 'pending') return res.redirect('/account');
  const total = (order.order_type === 'custom' ? order.deposit_cents : order.amount_cents)
    + (order.fee_cents || 0) + (order.rush_fee_cents || 0);
  const design = order.design_id ? await db.get('SELECT title FROM designs WHERE id = ?', [order.design_id]) : null;
  try {
    const pp = await paypal.createCheckoutOrder({
      amountCents: total,
      description: `Tattoo Art Customs — ${design ? `"${design.title}"` : 'custom design deposit (50%)'}`,
      returnUrl: `${config.baseUrl}/orders/approve/${order.id}`,
      cancelUrl: `${config.baseUrl}/orders/manual/${order.id}`,
    });
    await db.update('orders', order.id, { paypal_order_id: pp.id, payment_method: 'paypal' });
    const approve = pp.links.find((l) => l.rel === 'approve');
    return res.redirect(approve.href);
  } catch (e) {
    console.error('PayPal order create failed (manual page):', e.message);
    req.session.flash = 'PayPal checkout is unavailable right now — please use CashApp or Venmo below, or try again later.';
    return res.redirect(`/orders/manual/${order.id}`);
  }
});

// --- PayPal return: capture ---
router.get('/approve/:orderId', requireLogin, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', [req.params.orderId, req.user.id]);
  if (!order) return res.redirect('/account');
  if (order.status === 'paid') return res.redirect(`/orders/${order.id}`);
  try {
    const capture = await paypal.captureCheckoutOrder(order.paypal_order_id);
    // The charged total (price/deposit + processing fee + rush fee). The
    // capture must match it exactly — never mark paid on a short capture.
    const expectedTotal = (order.order_type === 'custom' ? order.deposit_cents : order.amount_cents)
      + (order.fee_cents || 0) + (order.rush_fee_cents || 0);
    const paidCents = paypal.assertCaptureAmount(capture, expectedTotal);
    await db.update('orders', order.id, {
      status: 'paid', amount_paid_cents: paidCents, paid_at: db.now(),
    });
    const fresh = await db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
    await recordSaleCommissions(fresh);
    // Buy-for-client: land the art cost on a client bill for the shop to
    // collect from the client (idempotent per order).
    if (fresh.client_email) {
      const existingBill = await db.get('SELECT id FROM client_bills WHERE order_id = ?', [fresh.id]);
      if (!existingBill) {
        await db.insert('client_bills', {
          shop_user_id: fresh.buyer_id,
          client_email: fresh.client_email,
          client_user_id: fresh.client_user_id || null,
          order_id: fresh.id,
          amount_cents: Number(fresh.amount_cents || 0) + Number(fresh.fee_cents || 0),
          status: 'unpaid',
          note: 'Design purchase for client',
        });
      }
    }
    const fulfil = await onOrderPaid(fresh);
    await routeCustomOrder(fresh);
    await onCustomPieceSold(fresh); // sold custom pieces delist + queue a replacement
    await fulfillPremadeOrder(fresh); // premades deliver instantly: token + receipt email
    if (fresh.order_type === 'custom') await sendCustomDepositReceipt(fresh); // deposit receipt (+ first-custom line item)
    try { await require('../lib/saleWatch').watchOrderPaid(fresh); } catch (e) { console.error('sale watch failed:', e.message); }
    const orderRush = (order.rush_fee_cents || 0) > 0;
    req.session.flash = order.order_type === 'custom'
      ? `Deposit received — your custom request is in. Your design will be delivered within ${orderRush ? '24' : '48'} hours.`
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
  const transfers = await db.all('SELECT * FROM art_transfers WHERE order_id = ? ORDER BY created_at DESC', [order.id]);
  const pricing = require('../lib/pricing');
  const depositTotal = order.order_type === 'custom' && order.deposit_cents != null
    ? Number(order.deposit_cents) + Number(order.fee_cents || 0) : null;
  const fullTotal = order.order_type === 'custom' ? pricing.withFeeCents(Number(order.amount_cents)) : null;
  res.render('orders/detail', { title: `Order ${order.id.slice(0, 8)} — Tattoo Art Customs`, order, design, downloads, transfers, depositTotal, fullTotal });
});

// Cancel your own pending, unpaid order (e.g. an accidental duplicate).
router.post('/:orderId/cancel', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', [req.params.orderId, req.user.id]);
  if (!order || order.status !== 'pending' || Number(order.amount_paid_cents || 0) > 0) {
    req.session.flash = 'That order cannot be canceled.';
    return res.redirect('/account');
  }
  await db.update('orders', order.id, { status: 'canceled' });
  req.session.flash = 'Order canceled.';
  res.redirect('/account');
});

router.post('/:orderId/download-token', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', [req.params.orderId, req.user.id]);
  if (!order || order.status !== 'paid') {
    req.session.flash = 'Downloads unlock once the order is paid.';
    return res.redirect('/account');
  }
  // Reuses the still-valid auto-issued token when one exists (idempotent).
  const dl = await require('../lib/fulfillment').issueDownloadToken(order.id);
  res.redirect(`/orders/download/${dl.token}/view`);
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
  if (order.order_type === 'ios_app') {
    // iOS app IPA: served from the configured path.
    const ipaPath = process.env.IOS_APP_IPA_PATH || 'uploads/ios-app/tattoo-art-customs.ipa';
    absPath = resolveStoredPath(ipaPath);
    if (!absPath) {
      return res.status(404).render('error', { title: 'Not ready', message: 'The iOS app file is being prepared — check back soon.' });
    }
    return res.download(absPath, 'tattoo-art-customs.ipa');
  }
  if (order.order_type === 'premade' && order.design_id) {
    const design = await db.get('SELECT color_path, linework_path FROM designs WHERE id = ?', [order.design_id]);
    if (!design) return res.status(404).render('error', { title: 'Not found', message: 'Design files are missing.' });
    const rel = which === 'linework' ? design.linework_path : design.color_path;
    absPath = resolveStoredPath(rel);
  } else {
    // Custom orders: admin attaches the finished files to the order record
    // (stored under uploads/designs/); served the same secure way.
    const rel = which === 'linework' ? order.custom_linework_path : order.custom_color_path;
    if (!rel) return res.status(404).render('error', { title: 'Not ready', message: 'Your custom design is still being created — check back soon.' });
    absPath = resolveStoredPath(rel);
  }
  if (!absPath) {
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
    lineworkOnly: !!(order && order.linework_only),
  });
});

module.exports = router;
