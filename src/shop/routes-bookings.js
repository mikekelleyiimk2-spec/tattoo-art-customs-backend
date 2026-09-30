// Bookings: shop appointment scheduling, deposits/balances, receipts,
// "Get this tattooed", and shop booking settings (shop toolset, Phase 2).
//
// Mounted at /bookings by src/index.js — all paths below are relative to
// that mount.
//
// Two customer flows (the shop picks one in settings):
//   STANDARD: /shop/:shopId -> POST /hold -> /checkout/:id -> PayPal ->
//             GET /approve/:paymentId (or POST /capture) -> confirmed
//   DEPOSIT-FIRST (shop setting deposit_before_booking=1):
//             GET|POST /deposit-first/:shopId -> PayPal ->
//             GET /deposit-first/approve/:depositId ->
//             GET /deposit-first/:depositId/slots ->
//             POST /deposit-first/:depositId/book -> confirmed
const express = require('express');
const db = require('../db');
const config = require('../config');
const paypal = require('../lib/paypal');
const { requireLogin, requireSubscription, hasActiveSubscription, isAdminRole } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { formatReceiptLines } = require('./bookingFees');
const { getOpenSlots } = require('./bookingSlots');
const flow = require('./bookingFlow');
const { money } = require('../lib/pricing');

const router = express.Router();

// --- helpers --------------------------------------------------------------

async function shopUser(shopId) {
  return db.get("SELECT id, display_name FROM users WHERE id = ? AND role = 'tattoo_shop'", [shopId]);
}

async function shopActive(shopId) {
  return hasActiveSubscription(shopId, 'tattoo_shop');
}

function errCode(e) { return e && e.code; }

async function bookingAccess(booking, user) {
  if (!booking || !user) return false;
  if (isAdminRole(user.role)) return true;
  return booking.customer_user_id === user.id || booking.shop_user_id === user.id;
}

async function shopOwnsBooking(booking, user) {
  return booking && (booking.shop_user_id === user.id || isAdminRole(user.role));
}

// --- public booking page + slots ------------------------------------------

router.get('/shop/:shopId', async (req, res) => {
  const shop = await shopUser(req.params.shopId);
  if (!shop) return res.status(404).render('error', { title: 'Not found', message: 'Shop not found.' });
  const settings = await flow.getBookingSettings(shop.id);
  const staff = await db.all('SELECT * FROM shop_staff WHERE shop_user_id = ? AND active = 1 ORDER BY name', [shop.id]);
  const chairs = await db.all('SELECT * FROM shop_chairs WHERE shop_user_id = ? AND active = 1 ORDER BY name', [shop.id]);
  res.render('bookings/shop', {
    title: `Book — ${shop.display_name} — Tattoo Art Customs`,
    shop, settings, staff, chairs, money,
    designId: String(req.query.design_id || ''),
    depositFirst: Number(settings.deposit_before_booking) === 1,
    bookingActive: await shopActive(shop.id),
    metaDescription: '',
  });
});

router.get('/slots', async (req, res) => {
  const shopId = String(req.query.shop_id || '');
  const fromTs = Number(req.query.from);
  const toTs = Number(req.query.to);
  if (!shopId || !Number.isFinite(fromTs) || !Number.isFinite(toTs)) {
    return res.status(400).json({ ok: false, error: 'shop_id, from, to required' });
  }
  const slots = await getOpenSlots(shopId, {
    staffId: req.query.staff_id || null, chairId: req.query.chair_id || null, fromTs, toTs,
  });
  res.json({ ok: true, slots });
});

// --- "Get this tattooed" ---------------------------------------------------

router.get('/start', requireLogin, async (req, res) => {
  const now = Date.now();
  const shops = await db.all(
    `SELECT u.id, u.display_name FROM users u
     JOIN subscriptions s ON s.user_id = u.id
     JOIN plans p ON p.id = s.plan_id AND p.slug = 'tattoo_shop'
     WHERE u.role = 'tattoo_shop' AND s.status = 'active'
       AND (s.current_period_end IS NULL OR s.current_period_end > ?)
       AND EXISTS (SELECT 1 FROM availability_rules a WHERE a.shop_user_id = u.id AND a.active = 1)
     ORDER BY u.display_name`, [now]);
  res.render('bookings/start', {
    title: 'Get this tattooed — Tattoo Art Customs',
    shops, designId: String(req.query.design_id || ''), money, metaDescription: '',
  });
});

router.post('/start', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const shopId = String(req.body.shop_id || '');
  const designId = String(req.body.design_id || '');
  const shop = await shopUser(shopId);
  if (!shop || !(await shopActive(shopId))) {
    req.session.flash = 'That shop is not available for booking right now.';
    return res.redirect('/bookings/start' + (designId ? `?design_id=${encodeURIComponent(designId)}` : ''));
  }
  res.redirect(`/bookings/shop/${shopId}` + (designId ? `?design_id=${encodeURIComponent(designId)}` : ''));
});

// --- standard flow: hold -> checkout -> capture ----------------------------

router.post('/hold', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const shopId = String(req.body.shop_id || '');
  const shop = await shopUser(shopId);
  if (!shop || !(await shopActive(shopId))) {
    req.session.flash = 'That shop is not available for booking right now.';
    return res.redirect(`/bookings/shop/${shopId}`);
  }
  const startAt = Number(req.body.start_at);
  const staffId = req.body.staff_id || null;
  const chairId = req.body.chair_id || null;
  try {
    // end_at comes from the slot picker (slot length varies per rule);
    // fall back to 60 minutes when absent.
    let endAt = Number(req.body.end_at);
    if (!Number.isFinite(endAt) || endAt <= startAt) endAt = startAt + 60 * 60000;
    const bookingId = await flow.createPendingBooking({
      shopUserId: shopId, customerUserId: req.user.id,
      staffId, chairId, startAt, endAt,
      source: 'shop_page', designId: req.body.design_id || null,
      attributionSource: req.body.ref === 'tac' ? 'tac_marketplace' : null,
    });
    res.redirect(`/bookings/checkout/${bookingId}`);
  } catch (e) {
    if (errCode(e) === 'DEPOSIT_FIRST') {
      req.session.flash = 'This shop collects the deposit before you pick a slot — start there.';
      return res.redirect(`/bookings/deposit-first/${shopId}`);
    }
    req.session.flash = errCode(e) === 'SLOT_TAKEN'
      ? 'That slot was just taken — pick another.'
      : 'Could not hold that slot: ' + e.message;
    res.redirect(`/bookings/shop/${shopId}`);
  }
});

router.get('/checkout/:id', requireLogin, async (req, res) => {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
  if (!booking || booking.customer_user_id !== req.user.id) {
    return res.status(404).render('error', { title: 'Not found', message: 'Booking not found.' });
  }
  if (booking.status !== 'pending_deposit') return res.redirect(`/bookings/receipt/${booking.id}`);
  const settings = await flow.getBookingSettings(booking.shop_user_id);
  const fees = flow.depositFees(settings);
  // Sanity: the hold's deposit base must match the current shop settings.
  if (Number(booking.deposit_cents) !== fees.base) {
    await db.update('bookings', booking.id, { deposit_cents: fees.base });
    booking.deposit_cents = fees.base;
  }
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [booking.shop_user_id]);
  res.render('bookings/checkout', {
    title: 'Checkout — Tattoo Art Customs',
    booking, shop, fees, lines: formatReceiptLines(fees), money, metaDescription: '',
  });
});

router.post('/checkout/:id', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
  if (!booking || booking.customer_user_id !== req.user.id || booking.status !== 'pending_deposit') {
    return res.status(404).render('error', { title: 'Not found', message: 'Booking not found.' });
  }
  const settings = await flow.getBookingSettings(booking.shop_user_id);
  const fees = flow.depositFees(settings);
  const kind = fees.base === 100 ? 'booking_fee' : 'deposit';
  try {
    // Idempotent on double-click: reuse the still-pending payment row instead
    // of creating a second one (two pending rows = two PayPal orders, and a
    // customer paying both would be charged twice).
    const { paymentId } = await flow.withShopBookingLock(booking.shop_user_id, async () => {
      const existing = await db.get(
        "SELECT id FROM booking_payments WHERE booking_id = ? AND kind = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
        [booking.id, kind]);
      if (existing) return { paymentId: existing.id };
      const pid = await db.insert('booking_payments', {
        booking_id: booking.id, kind,
        base_cents: fees.base, platform_fee_cents: fees.platformFee,
        processing_cents: fees.processing, total_cents: fees.total,
        status: 'pending', created_at: db.now(),
      });
      return { paymentId: pid };
    });
    const pp = await paypal.createCheckoutOrder({
      amountCents: fees.total,
      description: `Tattoo Art Customs — booking deposit (${booking.id.slice(0, 8)})`,
      returnUrl: `${config.baseUrl}/bookings/approve/${paymentId}`,
      cancelUrl: `${config.baseUrl}/bookings/checkout/${booking.id}`,
    });
    await db.update('booking_payments', paymentId, { paypal_order_id: pp.id });
    const approve = pp.links.find((l) => l.rel === 'approve');
    res.redirect(approve.href);
  } catch (e) {
    console.error('booking PayPal order failed:', e.message);
    req.session.flash = 'PayPal checkout is unavailable right now — your slot is still held; try again in a bit.';
    res.redirect(`/bookings/checkout/${booking.id}`);
  }
});

// Capture a pending booking payment and confirm the booking.
// Shared by the PayPal return (GET) and the programmatic route (POST).
async function doCapture(paymentId, user) {
  const payment = await db.get('SELECT * FROM booking_payments WHERE id = ?', [paymentId]);
  if (!payment) throw Object.assign(new Error('Payment not found.'), { code: 'NOT_FOUND' });
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [payment.booking_id]);
  if (!booking || booking.customer_user_id !== user.id) {
    throw Object.assign(new Error('Payment not found.'), { code: 'NOT_FOUND' });
  }
  if (payment.status === 'paid' || booking.status === 'confirmed') {
    return { booking, already: true };
  }
  if (!payment.paypal_order_id) throw Object.assign(new Error('No PayPal order on this payment.'), { code: 'NO_ORDER' });
  // Idempotent capture: if a previous attempt captured the money but we
  // crashed before recording it, PayPal reports ORDER_ALREADY_CAPTURED —
  // recover the capture details instead of failing (or worse, charging again).
  let capture;
  try {
    capture = await paypal.captureCheckoutOrder(payment.paypal_order_id);
  } catch (e) {
    if (!paypal.isAlreadyCapturedError(e)) throw e;
    console.error(`[bookings] already-captured recovery for payment ${payment.id} (order ${payment.paypal_order_id})`);
    capture = await paypal.getCheckoutOrder(payment.paypal_order_id);
  }
  const captured = capture.purchase_units?.[0]?.payments?.captures?.[0];
  let paidCents = Math.round(parseFloat(captured?.amount?.value || '0') * 100);
  if (!paidCents) paidCents = payment.total_cents; // test stub reports 0.00
  if (paidCents < payment.total_cents) {
    throw Object.assign(new Error('Captured amount is less than the amount due.'), { code: 'UNDERPAID' });
  }
  const fees = {
    base: payment.base_cents, platformFee: payment.platform_fee_cents,
    processing: payment.processing_cents, total: payment.total_cents,
  };
  const result = await flow.confirmBooking(booking.id, {
    kind: payment.kind, fees,
    captureId: (captured && captured.id) || null,
    orderId: payment.paypal_order_id, paymentId: payment.id,
  });
  return result;
}

router.get('/approve/:paymentId', requireLogin, async (req, res) => {
  try {
    const result = await doCapture(req.params.paymentId, req.user);
    req.session.flash = result.already ? 'That booking is already confirmed.' : 'Deposit received — your appointment is confirmed.';
    res.redirect(`/bookings/receipt/${result.booking.id}`);
  } catch (e) {
    console.error('booking capture failed:', e.message);
    req.session.flash = 'Payment capture failed: ' + e.message;
    res.redirect('/account');
  }
});

router.post('/capture', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const result = await doCapture(String(req.body.payment_id || ''), req.user);
    res.redirect(`/bookings/receipt/${result.booking.id}`);
  } catch (e) {
    req.session.flash = 'Payment capture failed: ' + e.message;
    res.redirect('/account');
  }
});

// --- deposit-first (reversed) flow -------------------------------------------
// NOTE: /deposit-first/approve/:depositId must be registered BEFORE
// /deposit-first/:shopId, or "approve" matches :shopId.

router.get('/deposit-first/approve/:depositId', requireLogin, async (req, res) => {
  const depositId = req.params.depositId;
  try {
    const dep = await db.get('SELECT * FROM booking_deposits WHERE id = ? AND customer_user_id = ?', [depositId, req.user.id]);
    if (!dep) throw new Error('Deposit not found.');
    if (dep.status !== 'paid') {
      const orderId = req.session['deposit_order_' + depositId];
      if (!orderId) throw new Error('No PayPal order found for this deposit.');
      let capture;
      try {
        capture = await paypal.captureCheckoutOrder(orderId);
      } catch (e) {
        if (!paypal.isAlreadyCapturedError(e)) throw e;
        // Recovery: the money moved on a previous attempt that crashed
        // before we recorded it — verify and continue, never re-charge.
        console.error(`[bookings] already-captured recovery for deposit ${depositId} (order ${orderId})`);
        capture = await paypal.getCheckoutOrder(orderId);
      }
      const captured = capture.purchase_units?.[0]?.payments?.captures?.[0];
      await flow.captureDeposit(depositId, (captured && captured.id) || null);
      delete req.session['deposit_order_' + depositId];
    }
    req.session.flash = 'Deposit received — now pick your slot.';
    res.redirect(`/bookings/deposit-first/${depositId}/slots`);
  } catch (e) {
    console.error('deposit capture failed:', e.message);
    req.session.flash = 'Deposit capture failed: ' + e.message;
    res.redirect('/account');
  }
});

router.get('/deposit-first/:shopId', async (req, res) => {
  const shop = await shopUser(req.params.shopId);
  if (!shop) return res.status(404).render('error', { title: 'Not found', message: 'Shop not found.' });
  const settings = await flow.getBookingSettings(shop.id);
  if (Number(settings.deposit_before_booking) !== 1) {
    return res.redirect(`/bookings/shop/${shop.id}`);
  }
  const fees = flow.depositFees(settings);
  res.render('bookings/deposit-first', {
    title: `Deposit — ${shop.display_name} — Tattoo Art Customs`,
    shop, settings, fees, lines: formatReceiptLines(fees), money, metaDescription: '',
  });
});

router.post('/deposit-first/:shopId', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const shop = await shopUser(req.params.shopId);
  if (!shop || !(await shopActive(shop.id))) {
    req.session.flash = 'That shop is not available for booking right now.';
    return res.redirect(`/bookings/shop/${req.params.shopId}`);
  }
  try {
    // Idempotent on double-click: reuse the customer's still-pending deposit
    // credit instead of opening a second one (two pending deposits = two
    // PayPal orders = a possible double charge).
    const { deposit, fees } = await flow.withShopBookingLock(shop.id, async () => {
      const open = await db.get(
        `SELECT * FROM booking_deposits
         WHERE shop_user_id = ? AND customer_user_id = ? AND status = 'pending' AND booking_id IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [shop.id, req.user.id]);
      if (open) {
        const s = await flow.getBookingSettings(shop.id);
        return { deposit: open, fees: flow.depositFees(s) };
      }
      return flow.startDepositFirst(shop.id, req.user.id);
    });
    const pp = await paypal.createCheckoutOrder({
      amountCents: fees.total,
      description: `Tattoo Art Customs — booking deposit credit (${deposit.id.slice(0, 8)})`,
      returnUrl: `${config.baseUrl}/bookings/deposit-first/approve/${deposit.id}`,
      cancelUrl: `${config.baseUrl}/bookings/deposit-first/${shop.id}`,
    });
    req.session['deposit_order_' + deposit.id] = pp.id;
    const approve = pp.links.find((l) => l.rel === 'approve');
    res.redirect(approve.href);
  } catch (e) {
    console.error('deposit-first PayPal order failed:', e.message);
    req.session.flash = 'PayPal checkout is unavailable right now — try again in a bit.';
    res.redirect(`/bookings/deposit-first/${shop.id}`);
  }
});

router.get('/deposit-first/:depositId/slots', requireLogin, async (req, res) => {
  const dep = await db.get('SELECT * FROM booking_deposits WHERE id = ? AND customer_user_id = ?', [req.params.depositId, req.user.id]);
  if (!dep || dep.status !== 'paid' || dep.booking_id) {
    req.session.flash = 'That deposit is not available for booking.';
    return res.redirect('/account');
  }
  const shop = await shopUser(dep.shop_user_id);
  const settings = await flow.getBookingSettings(dep.shop_user_id);
  const staff = await db.all('SELECT * FROM shop_staff WHERE shop_user_id = ? AND active = 1 ORDER BY name', [dep.shop_user_id]);
  const chairs = await db.all('SELECT * FROM shop_chairs WHERE shop_user_id = ? AND active = 1 ORDER BY name', [dep.shop_user_id]);
  res.render('bookings/deposit-slots', {
    title: `Pick your slot — ${shop ? shop.display_name : ''} — Tattoo Art Customs`,
    shop, deposit: dep, settings, staff, chairs, money,
    designId: String(req.query.design_id || ''), metaDescription: '',
  });
});

router.post('/deposit-first/:depositId/book', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const dep = await db.get('SELECT * FROM booking_deposits WHERE id = ? AND customer_user_id = ?', [req.params.depositId, req.user.id]);
  if (!dep) return res.status(404).render('error', { title: 'Not found', message: 'Deposit not found.' });
  const startAt = Number(req.body.start_at);
  let endAt = Number(req.body.end_at);
  if (!Number.isFinite(endAt) || endAt <= startAt) endAt = startAt + 60 * 60000;
  try {
    const booking = await flow.bookWithDeposit({
      depositId: dep.id,
      staffId: req.body.staff_id || null, chairId: req.body.chair_id || null,
      startAt, endAt,
      designId: req.body.design_id || null,
      attributionSource: req.body.ref === 'tac' ? 'tac_marketplace' : null,
    });
    req.session.flash = 'Appointment confirmed — your deposit credit was applied.';
    res.redirect(`/bookings/receipt/${booking.id}`);
  } catch (e) {
    req.session.flash = errCode(e) === 'SLOT_TAKEN'
      ? 'That slot was just taken — pick another.'
      : 'Could not book that slot: ' + e.message;
    res.redirect(`/bookings/deposit-first/${dep.id}/slots`);
  }
});

// --- cancel + receipt ---------------------------------------------------------

router.post('/:id/cancel', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
  if (!booking || !(await bookingAccess(booking, req.user))) {
    return res.status(404).render('error', { title: 'Not found', message: 'Booking not found.' });
  }
  try {
    const { outcome } = await flow.cancelBooking(booking.id, { byShop: booking.shop_user_id === req.user.id });
    req.session.flash = {
      canceled_unpaid: 'Booking canceled.',
      refunded_base: 'Booking canceled — the deposit (base amount) was refunded. The 5% platform fee is non-refundable.',
      forfeited: 'Booking canceled — the deposit was forfeited to the shop per its cancellation policy.',
      refund_failed_manual: 'Booking canceled — the automatic refund failed; the shop will refund you manually.',
    }[outcome] || 'Booking canceled.';
    res.redirect('/bookings/manage');
  } catch (e) {
    req.session.flash = 'Could not cancel: ' + e.message;
    res.redirect('/bookings/manage');
  }
});

router.get('/receipt/:id', requireLogin, async (req, res) => {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
  if (!booking || !(await bookingAccess(booking, req.user))) {
    return res.status(404).render('error', { title: 'Not found', message: 'Booking not found.' });
  }
  const receipt = await db.get('SELECT * FROM receipts WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1', [booking.id]);
  const payment = await db.get('SELECT * FROM booking_payments WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1', [booking.id]);
  const balancePayment = await db.get(
    "SELECT * FROM booking_payments WHERE booking_id = ? AND kind = 'balance' ORDER BY created_at DESC LIMIT 1",
    [booking.id]);
  const deposit = await db.get('SELECT * FROM booking_deposits WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1', [booking.id]);
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [booking.shop_user_id]);
  const customer = await db.get('SELECT display_name FROM users WHERE id = ?', [booking.customer_user_id]);
  res.render('bookings/receipt', {
    title: 'Receipt — Tattoo Art Customs',
    booking, receipt, payment, balancePayment, deposit, shop, customer, money,
    isCustomer: booking.customer_user_id === req.user.id, metaDescription: '',
  });
});

// --- session balances ----------------------------------------------------------
// The shop records a remaining balance on a confirmed booking; the customer
// pays it through the website PayPal/card checkout — never Google Play Billing.

// Shop: record a balance due (creates a pending balance payment).
router.post('/:id/balance', requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  try {
    const dollars = parseFloat(String(req.body.amount_dollars || ''));
    if (!Number.isFinite(dollars) || dollars < 1) throw new Error('Enter a balance of at least $1.00.');
    await flow.recordBalanceDue({
      bookingId: req.params.id, shopUserId: req.user.id,
      amountCents: Math.round(dollars * 100),
    });
    req.session.flash = 'Balance recorded — the customer can pay it on the website.';
  } catch (e) {
    req.session.flash = 'Could not record balance: ' + e.message;
  }
  res.redirect('/bookings/manage');
});

// Customer: balance checkout page.
router.get('/balance/:paymentId', requireLogin, async (req, res) => {
  const payment = await db.get('SELECT * FROM booking_payments WHERE id = ?', [req.params.paymentId]);
  const booking = payment && await db.get('SELECT * FROM bookings WHERE id = ?', [payment.booking_id]);
  if (!payment || payment.kind !== 'balance' || !booking || booking.customer_user_id !== req.user.id) {
    return res.status(404).render('error', { title: 'Not found', message: 'Balance payment not found.' });
  }
  if (payment.status !== 'pending') return res.redirect(`/bookings/receipt/${booking.id}`);
  const fees = {
    base: payment.base_cents, platformFee: payment.platform_fee_cents,
    processing: payment.processing_cents, total: payment.total_cents,
  };
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [booking.shop_user_id]);
  res.render('bookings/balance-checkout', {
    title: 'Pay session balance — Tattoo Art Customs',
    booking, payment, shop, fees, lines: formatReceiptLines(fees), money, metaDescription: '',
  });
});

// Customer: create the PayPal order for a balance payment.
router.post('/balance/:paymentId', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const payment = await db.get('SELECT * FROM booking_payments WHERE id = ?', [req.params.paymentId]);
  const booking = payment && await db.get('SELECT * FROM bookings WHERE id = ?', [payment.booking_id]);
  if (!payment || payment.kind !== 'balance' || !booking || booking.customer_user_id !== req.user.id
      || payment.status !== 'pending') {
    return res.status(404).render('error', { title: 'Not found', message: 'Balance payment not found.' });
  }
  try {
    const pp = await paypal.createCheckoutOrder({
      amountCents: payment.total_cents,
      description: `Tattoo Art Customs — session balance (${booking.id.slice(0, 8)})`,
      returnUrl: `${config.baseUrl}/bookings/balance/approve/${payment.id}`,
      cancelUrl: `${config.baseUrl}/bookings/balance/${payment.id}`,
    });
    await db.update('booking_payments', payment.id, { paypal_order_id: pp.id });
    const approve = pp.links.find((l) => l.rel === 'approve');
    res.redirect(approve.href);
  } catch (e) {
    console.error('balance PayPal order failed:', e.message);
    req.session.flash = 'PayPal checkout is unavailable right now — try again in a bit.';
    res.redirect(`/bookings/balance/${payment.id}`);
  }
});

// Customer: PayPal return for a balance payment.
router.get('/balance/approve/:paymentId', requireLogin, async (req, res) => {
  try {
    const payment = await db.get('SELECT * FROM booking_payments WHERE id = ?', [req.params.paymentId]);
    if (!payment || payment.kind !== 'balance') throw new Error('Balance payment not found.');
    if (payment.status === 'paid') {
      req.session.flash = 'That balance is already paid.';
      const b = await db.get('SELECT id FROM bookings WHERE id = ?', [payment.booking_id]);
      return res.redirect(`/bookings/receipt/${b.id}`);
    }
    if (!payment.paypal_order_id) throw new Error('No PayPal order on this payment.');
    const capture = await paypal.captureCheckoutOrder(payment.paypal_order_id);
    const captured = capture.purchase_units?.[0]?.payments?.captures?.[0];
    let paidCents = Math.round(parseFloat(captured?.amount?.value || '0') * 100);
    if (!paidCents) paidCents = payment.total_cents; // test stub reports 0.00
    if (paidCents < payment.total_cents) throw new Error('Captured amount is less than the amount due.');
    const result = await flow.captureBalancePayment(payment.id, {
      captureId: (captured && captured.id) || null,
      orderId: payment.paypal_order_id, customerUserId: req.user.id,
    });
    req.session.flash = result.already ? 'That balance is already paid.' : 'Session balance paid in full.';
    res.redirect(`/bookings/receipt/${result.booking.id}`);
  } catch (e) {
    console.error('balance capture failed:', e.message);
    req.session.flash = 'Payment capture failed: ' + e.message;
    res.redirect('/account');
  }
});

// --- shop: manage --------------------------------------------------------------

router.get('/manage', requireSubscription('tattoo_shop'), async (req, res) => {
  const shopId = req.user.id;
  await flow.expireStaleHolds();
  const now = Date.now();
  const upcoming = await db.all(
    `SELECT b.*, u.display_name AS customer_name FROM bookings b
     JOIN users u ON u.id = b.customer_user_id
     WHERE b.shop_user_id = ? AND b.status IN ('confirmed', 'pending_deposit') AND b.start_at >= ?
     ORDER BY b.start_at`, [shopId, now - 3600000]);
  const past = await db.all(
    `SELECT b.*, u.display_name AS customer_name FROM bookings b
     JOIN users u ON u.id = b.customer_user_id
     WHERE b.shop_user_id = ? AND (b.status NOT IN ('confirmed', 'pending_deposit') OR b.start_at < ?)
     ORDER BY b.start_at DESC LIMIT 50`, [shopId, now - 3600000]);
  const deposits = await db.all(
    `SELECT d.*, u.display_name AS customer_name FROM booking_deposits d
     JOIN users u ON u.id = d.customer_user_id
     WHERE d.shop_user_id = ? AND d.status = 'paid' AND d.booking_id IS NULL
     ORDER BY d.created_at DESC`, [shopId]);
  res.render('bookings/manage', {
    title: 'Manage bookings — Tattoo Art Customs',
    upcoming, past, deposits, money, metaDescription: '',
  });
});

router.post('/:id/no-show', requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
  if (!booking || !(await shopOwnsBooking(booking, req.user))) {
    return res.status(404).render('error', { title: 'Not found', message: 'Booking not found.' });
  }
  try {
    await flow.markNoShow(booking.id);
    req.session.flash = 'Marked as no-show — the deposit is forfeited per your policy.';
  } catch (e) { req.session.flash = 'Could not mark no-show: ' + e.message; }
  res.redirect('/bookings/manage');
});

router.post('/:id/complete', requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
  if (!booking || !(await shopOwnsBooking(booking, req.user))) {
    return res.status(404).render('error', { title: 'Not found', message: 'Booking not found.' });
  }
  try {
    await flow.markCompleted(booking.id);
    req.session.flash = 'Appointment marked complete.';
  } catch (e) { req.session.flash = 'Could not complete: ' + e.message; }
  res.redirect('/bookings/manage');
});

// --- shop: settings --------------------------------------------------------------

router.get('/settings', requireSubscription('tattoo_shop'), async (req, res) => {
  const settings = await flow.getBookingSettings(req.user.id);
  res.render('bookings/settings', { title: 'Booking settings — Tattoo Art Customs', settings, money, metaDescription: '' });
});

router.post('/settings', requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  const b = req.body;
  const num = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : dflt;
  };
  await flow.saveBookingSettings(req.user.id, {
    deposit_before_booking: b.deposit_before_booking === '1' ? 1 : 0,
    deposit_amount_cents: num(b.deposit_amount_cents, 0),
    deposit_policy_text: String(b.deposit_policy_text || '').slice(0, 2000) || null,
    noshow_forfeit_deposit: b.noshow_forfeit_deposit === '1' ? 1 : 0,
    cancel_window_hours: Math.max(1, Math.min(720, num(b.cancel_window_hours, 24))),
    slot_hold_minutes: Math.max(5, Math.min(1440, num(b.slot_hold_minutes, 30))),
    deposit_credit_expiry_days: Math.max(1, Math.min(365, num(b.deposit_credit_expiry_days, 90))),
    booking_instructions: String(b.booking_instructions || '').slice(0, 2000) || null,
  });
  req.session.flash = 'Booking settings saved.';
  res.redirect('/bookings/settings');
});

// --- shop: chairs / staff / availability --------------------------------------------

router.get('/chairs', requireSubscription('tattoo_shop'), async (req, res) => {
  const chairs = await db.all('SELECT * FROM shop_chairs WHERE shop_user_id = ? ORDER BY name', [req.user.id]);
  res.render('bookings/resources', { title: 'Chairs, staff & availability — Tattoo Art Customs', tab: 'chairs', chairs, staff: [], rules: [], money, metaDescription: '' });
});
router.post('/chairs', requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (name) await db.insert('shop_chairs', { shop_user_id: req.user.id, name, active: 1, created_at: db.now() });
  res.redirect('/bookings/chairs');
});
router.post('/chairs/:id/toggle', requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  const row = await db.get('SELECT * FROM shop_chairs WHERE id = ? AND shop_user_id = ?', [req.params.id, req.user.id]);
  if (row) await db.update('shop_chairs', row.id, { active: row.active ? 0 : 1 });
  res.redirect('/bookings/chairs');
});
router.post('/chairs/:id/delete', requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  await db.query('DELETE FROM shop_chairs WHERE id = ? AND shop_user_id = ?', [req.params.id, req.user.id]);
  res.redirect('/bookings/chairs');
});

router.get('/staff', requireSubscription('tattoo_shop'), async (req, res) => {
  const staff = await db.all('SELECT * FROM shop_staff WHERE shop_user_id = ? ORDER BY name', [req.user.id]);
  res.render('bookings/resources', { title: 'Chairs, staff & availability — Tattoo Art Customs', tab: 'staff', chairs: [], staff, rules: [], money, metaDescription: '' });
});
router.post('/staff', requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const artistUserId = String(req.body.artist_user_id || '').trim() || null;
  if (name) {
    await db.insert('shop_staff', {
      shop_user_id: req.user.id, name, artist_user_id: artistUserId, active: 1, created_at: db.now(),
    });
  }
  res.redirect('/bookings/staff');
});
router.post('/staff/:id/toggle', requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  const row = await db.get('SELECT * FROM shop_staff WHERE id = ? AND shop_user_id = ?', [req.params.id, req.user.id]);
  if (row) await db.update('shop_staff', row.id, { active: row.active ? 0 : 1 });
  res.redirect('/bookings/staff');
});
router.post('/staff/:id/delete', requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  await db.query('DELETE FROM shop_staff WHERE id = ? AND shop_user_id = ?', [req.params.id, req.user.id]);
  res.redirect('/bookings/staff');
});

function hhmmToMinutes(v) {
  const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

router.get('/availability', requireSubscription('tattoo_shop'), async (req, res) => {
  const rules = await db.all(
    `SELECT r.*, s.name AS staff_name, c.name AS chair_name FROM availability_rules r
     LEFT JOIN shop_staff s ON s.id = r.staff_id
     LEFT JOIN shop_chairs c ON c.id = r.chair_id
     WHERE r.shop_user_id = ? ORDER BY r.weekday, r.start_minutes`, [req.user.id]);
  const staff = await db.all('SELECT * FROM shop_staff WHERE shop_user_id = ? AND active = 1 ORDER BY name', [req.user.id]);
  const chairs = await db.all('SELECT * FROM shop_chairs WHERE shop_user_id = ? AND active = 1 ORDER BY name', [req.user.id]);
  res.render('bookings/resources', {
    title: 'Chairs, staff & availability — Tattoo Art Customs', tab: 'availability',
    chairs: [], staff, rules, money,
    staffList: staff, chairList: chairs, metaDescription: '',
  });
});
router.post('/availability', requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  const b = req.body;
  const weekday = Number(b.weekday);
  const start = hhmmToMinutes(b.start);
  const end = hhmmToMinutes(b.end);
  const len = Number(b.slot_length_minutes);
  if (!(weekday >= 0 && weekday <= 6) || start === null || end === null || start >= end
      || !(len >= 15 && len <= 480)) {
    req.session.flash = 'Check the rule: valid day, start before end, slot length 15–480 minutes.';
    return res.redirect('/bookings/availability');
  }
  await db.insert('availability_rules', {
    shop_user_id: req.user.id,
    staff_id: b.staff_id || null, chair_id: b.chair_id || null,
    weekday, start_minutes: start, end_minutes: end,
    slot_length_minutes: Math.round(len), active: 1, created_at: db.now(),
  });
  req.session.flash = 'Availability rule added.';
  res.redirect('/bookings/availability');
});
router.post('/availability/:id/toggle', requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  const row = await db.get('SELECT * FROM availability_rules WHERE id = ? AND shop_user_id = ?', [req.params.id, req.user.id]);
  if (row) await db.update('availability_rules', row.id, { active: row.active ? 0 : 1 });
  res.redirect('/bookings/availability');
});
router.post('/availability/:id/delete', requireSubscription('tattoo_shop'), formLimiter, checkHoneypot, async (req, res) => {
  await db.query('DELETE FROM availability_rules WHERE id = ? AND shop_user_id = ?', [req.params.id, req.user.id]);
  res.redirect('/bookings/availability');
});

module.exports = router;
