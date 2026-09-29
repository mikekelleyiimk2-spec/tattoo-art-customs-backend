// Booking flow state machine (shop toolset, Phase 2).
//
// Two flows (the shop picks one in settings):
//
//   STANDARD (deposit_before_booking = 0):
//     pending_deposit --(hold, slot reserved slot_hold_minutes)-->
//       checkout --(PayPal capture)--> confirmed --(shop)--> completed
//                                            \--(shop)--> no_show
//                                            \--(either)--> cancelled
//
//   REVERSED / deposit-first (deposit_before_booking = 1):
//     booking_deposits 'pending' --(PayPal capture)--> 'paid' (credit)
//       --(slot picker)--> bookings 'confirmed' (linked to the deposit)
//       --(shop)--> completed / no_show / cancelled
//
// Money rules (owner-locked):
//   - the SHOP always nets exactly `base` (its deposit price)
//   - the PLATFORM always nets exactly the 5% platform fee (NEVER refunded,
//     NEVER in the ledger)
//   - the CUSTOMER pays the grossed-up total (computeBookingFees)
//   - cancel inside the cancel window: refund `base` via PayPal, platform
//     fee kept by the platform
//   - cancel outside the window / no-show: deposit forfeited to the shop
//     (payment or deposit row status 'forfeited'; the shop's ledger credit
//     stands)
const db = require('../db');
const { computeBookingFees, flatBookingFee, formatReceiptLines } = require('./bookingFees');
const { isSlotFree } = require('./bookingSlots');
const { recipientEligible, verifyOrderCommissions } = require('./commissions');
const { notifyUser } = require('./notify');
const { sendMail } = require('./mail');

const DAY_MS = 86400000;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// --- Settings -------------------------------------------------------------
// WARNING: shop_booking_settings has no id column — never db.insert() it.
const SETTING_COLS = [
  'deposit_before_booking', 'deposit_amount_cents', 'deposit_policy_text',
  'noshow_forfeit_deposit', 'cancel_window_hours', 'slot_hold_minutes',
  'deposit_credit_expiry_days', 'booking_instructions',
];

async function getBookingSettings(shopUserId) {
  let s = await db.get('SELECT * FROM shop_booking_settings WHERE shop_user_id = ?', [shopUserId]);
  if (!s) {
    await db.query('INSERT INTO shop_booking_settings (shop_user_id) VALUES (?)', [shopUserId]);
    s = await db.get('SELECT * FROM shop_booking_settings WHERE shop_user_id = ?', [shopUserId]);
  }
  return s;
}

async function saveBookingSettings(shopUserId, fields) {
  const existing = await db.get('SELECT shop_user_id FROM shop_booking_settings WHERE shop_user_id = ?', [shopUserId]);
  const cols = SETTING_COLS.filter((c) => fields[c] !== undefined);
  if (!cols.length) return getBookingSettings(shopUserId);
  if (existing) {
    await db.query(
      `UPDATE shop_booking_settings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE shop_user_id = ?`,
      [...cols.map((c) => fields[c]), shopUserId]);
  } else {
    await db.query(
      `INSERT INTO shop_booking_settings (shop_user_id, ${cols.join(', ')}) VALUES (${['?', ...cols.map(() => '?')].join(', ')})`,
      [shopUserId, ...cols.map((c) => fields[c])]);
  }
  return getBookingSettings(shopUserId);
}

// The deposit base for a shop: its configured amount, or the $1 flat
// booking fee when no deposit is set ($0-deposit bookings).
function depositBaseCents(settings) {
  const amt = Number(settings && settings.deposit_amount_cents);
  return Number.isInteger(amt) && amt > 0 ? amt : 100;
}

function depositFees(settings) {
  return computeBookingFees(depositBaseCents(settings));
}

// --- Ledger ---------------------------------------------------------------
// Credit the shop 100% of base for a booking/deposit. The 5% platform fee
// NEVER enters the ledger and is NEVER refunded. Idempotent per refId.
async function creditShopForBase({ shopUserId, baseCents, refId, commissionType }) {
  const existing = await db.get(
    `SELECT id FROM commission_ledger WHERE order_id = ? AND recipient_type = 'shop' AND commission_type = ?`,
    [refId, commissionType]);
  if (existing) return { already: true };
  const eligible = await recipientEligible(shopUserId, 'tattoo_shop');
  await db.insert('commission_ledger', {
    order_id: refId, recipient_type: 'shop', recipient_id: shopUserId,
    amount_cents: baseCents,
    status: eligible ? 'pending' : 'site_kept',
    commission_type: commissionType, created_at: db.now(),
  });
  await verifyOrderCommissions(refId); // pending -> payable
  return { already: false, status: eligible ? 'payable' : 'site_kept' };
}

// Reduce the shop's booking credit when base is refunded (floor 0; never
// touch rows already included in a completed payout).
async function reduceShopCredit(refId, baseCents) {
  const rows = await db.all(
    `SELECT id, amount_cents FROM commission_ledger
     WHERE order_id = ? AND recipient_type = 'shop' AND status IN ('pending','payable')`,
    [refId]);
  for (const r of rows) {
    await db.update('commission_ledger', r.id, {
      amount_cents: Math.max(0, Number(r.amount_cents) - baseCents),
    });
  }
}

// Verify-booking-commissions: the existing verifyOrderCommissions, keyed on
// the booking/deposit id (stored in commission_ledger.order_id).
async function verifyBookingCommissions(refId) {
  return verifyOrderCommissions(refId);
}

// --- Standard flow --------------------------------------------------------

// Create a pending_deposit booking (holds the slot for slot_hold_minutes).
// Throws {code:'DEPOSIT_FIRST'} when the shop runs the reversed flow,
// {code:'SLOT_TAKEN'} when the slot is not free.
async function createPendingBooking({ shopUserId, customerUserId, staffId = null, chairId = null,
  startAt, endAt, source = 'shop_page', designId = null, now = Date.now() }) {
  const settings = await getBookingSettings(shopUserId);
  if (Number(settings.deposit_before_booking) === 1) {
    throw err('DEPOSIT_FIRST', 'This shop collects the deposit before booking — start at the deposit page.');
  }
  const free = await isSlotFree(shopUserId, { staffId, chairId, startAt, endAt, now });
  if (!free) throw err('SLOT_TAKEN', 'That slot is no longer available.');
  return db.insert('bookings', {
    shop_user_id: shopUserId, customer_user_id: customerUserId,
    staff_id: staffId || null, chair_id: chairId || null,
    start_at: startAt, end_at: endAt, status: 'pending_deposit',
    deposit_cents: depositBaseCents(settings),
    source, design_id: designId || null, created_at: now,
  });
}

// Confirm a booking on payment capture. Creates the booking_payments row,
// the receipt, credits the shop 100% of base, and notifies both sides.
// Idempotent: a second call for an already-confirmed booking returns the
// existing rows without double-crediting.
async function confirmBooking(bookingId, { kind = 'deposit', fees, captureId = null, orderId = null, paymentId = null } = {}) {
  if (!fees || !Number.isInteger(fees.base)) throw err('BAD_FEES', 'fees required');
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
  if (!booking) throw err('NOT_FOUND', 'Booking not found.');
  if (booking.status === 'confirmed') {
    const payment = await db.get('SELECT * FROM booking_payments WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1', [bookingId]);
    const receipt = await db.get('SELECT * FROM receipts WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1', [bookingId]);
    return { booking, payment, receipt, already: true };
  }
  if (!['pending_deposit'].includes(booking.status)) {
    throw err('BAD_STATUS', `Booking cannot be confirmed from status '${booking.status}'.`);
  }
  const now = db.now();
  let payId = paymentId;
  if (payId) {
    // Payment row was created at checkout time ('pending') — flip it to paid.
    await db.update('booking_payments', payId, {
      status: 'paid', paypal_capture_id: captureId || null,
    });
  } else {
    payId = await db.insert('booking_payments', {
      booking_id: bookingId, kind,
      base_cents: fees.base, platform_fee_cents: fees.platformFee,
      processing_cents: fees.processing, total_cents: fees.total,
      status: 'paid', paypal_order_id: orderId || null, paypal_capture_id: captureId || null,
      created_at: now,
    });
  }
  await db.update('bookings', bookingId, { status: 'confirmed' });
  const receiptId = await db.insert('receipts', {
    booking_id: bookingId, kind: 'booking',
    lines_json: JSON.stringify({
      lines: formatReceiptLines(fees), booking_id: bookingId,
      captured_at: now, capture_id: captureId || null,
    }),
    shop_receives_cents: fees.base, customer_total_cents: fees.total, created_at: now,
  });
  await creditShopForBase({
    shopUserId: booking.shop_user_id, baseCents: fees.base,
    refId: bookingId, commissionType: 'booking',
  });
  const fresh = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
  await notifyBookingConfirmed(fresh, fees);
  return {
    booking: fresh,
    payment: await db.get('SELECT * FROM booking_payments WHERE id = ?', [payId]),
    receipt: await db.get('SELECT * FROM receipts WHERE id = ?', [receiptId]),
    already: false,
  };
}

// --- Deposit-first (reversed) flow ----------------------------------------

// Step 1: open a deposit credit (booking_deposits 'pending') for the shop's
// configured deposit amount.
async function startDepositFirst(shopUserId, customerUserId) {
  const settings = await getBookingSettings(shopUserId);
  if (Number(settings.deposit_before_booking) !== 1) {
    throw err('NOT_DEPOSIT_FIRST', 'This shop does not use deposit-before-booking.');
  }
  const fees = depositFees(settings);
  const depositId = await db.insert('booking_deposits', {
    shop_user_id: shopUserId, customer_user_id: customerUserId,
    amount_cents: fees.base, platform_fee_cents: fees.platformFee,
    processing_cents: fees.processing, total_cents: fees.total,
    status: 'pending', created_at: db.now(),
  });
  return { deposit: await db.get('SELECT * FROM booking_deposits WHERE id = ?', [depositId]), fees };
}

// Step 2: capture the deposit payment -> status 'paid', shop credited,
// receipt issued. Idempotent.
async function captureDeposit(depositId, captureId = null) {
  const dep = await db.get('SELECT * FROM booking_deposits WHERE id = ?', [depositId]);
  if (!dep) throw err('NOT_FOUND', 'Deposit not found.');
  if (dep.status === 'paid') {
    return { deposit: dep, already: true };
  }
  if (dep.status !== 'pending') throw err('BAD_STATUS', `Deposit cannot be captured from status '${dep.status}'.`);
  await db.update('booking_deposits', depositId, { status: 'paid', paypal_capture_id: captureId || null });
  const fees = {
    base: dep.amount_cents, platformFee: dep.platform_fee_cents,
    processing: dep.processing_cents, total: dep.total_cents,
  };
  await db.insert('receipts', {
    booking_id: null, kind: 'booking_deposit',
    lines_json: JSON.stringify({
      lines: formatReceiptLines(fees), deposit_id: depositId,
      captured_at: db.now(), capture_id: captureId || null,
    }),
    shop_receives_cents: dep.amount_cents, customer_total_cents: dep.total_cents,
    created_at: db.now(),
  });
  await creditShopForBase({
    shopUserId: dep.shop_user_id, baseCents: dep.amount_cents,
    refId: depositId, commissionType: 'booking_deposit',
  });
  const fresh = await db.get('SELECT * FROM booking_deposits WHERE id = ?', [depositId]);
  await notifyDepositPaid(fresh);
  return { deposit: fresh, already: false };
}

// Step 3: spend a paid, unexpired, unlinked deposit on a slot -> booking
// created directly 'confirmed'.
async function bookWithDeposit({ depositId, staffId = null, chairId = null,
  startAt, endAt, designId = null, now = Date.now() }) {
  const dep = await db.get('SELECT * FROM booking_deposits WHERE id = ?', [depositId]);
  if (!dep) throw err('NOT_FOUND', 'Deposit not found.');
  if (dep.status !== 'paid') throw err('DEPOSIT_UNPAID', 'That deposit has not been paid yet.');
  if (dep.booking_id) throw err('DEPOSIT_USED', 'That deposit is already linked to a booking.');
  const settings = await getBookingSettings(dep.shop_user_id);
  const expiryDays = Number(settings.deposit_credit_expiry_days) || 90;
  if (Number(dep.created_at) + expiryDays * DAY_MS < now) {
    throw err('DEPOSIT_EXPIRED', 'That deposit credit has expired.');
  }
  const free = await isSlotFree(dep.shop_user_id, { staffId, chairId, startAt, endAt, now });
  if (!free) throw err('SLOT_TAKEN', 'That slot is no longer available.');
  const bookingId = await db.insert('bookings', {
    shop_user_id: dep.shop_user_id, customer_user_id: dep.customer_user_id,
    staff_id: staffId || null, chair_id: chairId || null,
    start_at: startAt, end_at: endAt, status: 'confirmed',
    deposit_cents: dep.amount_cents, source: 'deposit_first',
    design_id: designId || null, created_at: now,
  });
  await db.update('booking_deposits', depositId, { booking_id: bookingId });
  // Attach the deposit receipt (created with booking_id NULL at capture time)
  // to the new booking so /bookings/receipt/:id can find it.
  await db.query(
    `UPDATE receipts SET booking_id = ? WHERE kind = 'booking_deposit' AND booking_id IS NULL AND lines_json LIKE ?`,
    [bookingId, `%"deposit_id":"${String(depositId).replace(/"/g, '')}"%`]
  );
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
  await notifyBookingConfirmed(booking, {
    base: dep.amount_cents, platformFee: dep.platform_fee_cents,
    processing: dep.processing_cents, total: dep.total_cents,
  });
  return booking;
}

// --- Cancel / no-show / complete ------------------------------------------

// Find the captured money behind a booking: standard flow -> booking_payments
// 'paid' row; deposit-first -> linked booking_deposits 'paid' row.
async function paidMoneyFor(booking) {
  const payment = await db.get(
    `SELECT * FROM booking_payments WHERE booking_id = ? AND status = 'paid' ORDER BY created_at DESC LIMIT 1`,
    [booking.id]);
  if (payment) return { kind: 'payment', row: payment, captureId: payment.paypal_capture_id, base: payment.base_cents };
  const dep = await db.get(
    `SELECT * FROM booking_deposits WHERE booking_id = ? AND status = 'paid' ORDER BY created_at DESC LIMIT 1`,
    [booking.id]);
  if (dep) return { kind: 'deposit', row: dep, captureId: dep.paypal_capture_id, base: dep.amount_cents };
  return null;
}

function cancelWindowMs(settings) {
  const h = Number(settings.cancel_window_hours);
  return (Number.isFinite(h) && h > 0 ? h : 24) * 3600000;
}

// Cancel a booking. Inside the cancel window the customer gets `base` back
// via PayPal (platform fee kept); outside the window the deposit is
// forfeited per the shop's noshow_forfeit_deposit setting.
async function cancelBooking(bookingId, { byShop = false, now = Date.now() } = {}) {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
  if (!booking) throw err('NOT_FOUND', 'Booking not found.');
  if (!['pending_deposit', 'confirmed'].includes(booking.status)) {
    throw err('BAD_STATUS', `Booking cannot be canceled from status '${booking.status}'.`);
  }
  const settings = await getBookingSettings(booking.shop_user_id);
  const money = await paidMoneyFor(booking);
  let outcome = 'canceled_unpaid';
  if (money) {
    const insideWindow = now <= Number(booking.start_at) - cancelWindowMs(settings);
    const forfeit = !insideWindow && Number(settings.noshow_forfeit_deposit) === 1;
    if (forfeit) {
      if (money.kind === 'payment') {
        await db.update('booking_payments', money.row.id, { status: 'forfeited' });
      } else {
        await db.update('booking_deposits', money.row.id, { status: 'forfeited' });
      }
      outcome = 'forfeited';
    } else {
      // Refund base via PayPal; the platform fee is never refunded.
      let refunded = false;
      let refundError = null;
      if (money.captureId) {
        try {
          const paypal = require('./paypal');
          await paypal.refundCheckoutCapture(money.captureId, money.base);
          refunded = true;
        } catch (e) { refundError = e.message; }
      }
      if (money.kind === 'payment') {
        await db.update('booking_payments', money.row.id, refunded
          ? { status: 'refunded', refunded_cents: money.base }
          : { status: 'paid' });
      } else if (refunded) {
        await db.update('booking_deposits', money.row.id, { status: 'refunded' });
      }
      if (refunded) {
        await reduceShopCredit(money.kind === 'payment' ? booking.id : money.row.id, money.base);
        outcome = 'refunded_base';
      } else {
        outcome = 'refund_failed_manual';
      }
      if (refundError) console.error('booking refund failed:', refundError);
    }
  }
  await db.update('bookings', bookingId, { status: 'cancelled', cancelled_at: now });
  await notifyBookingCanceled(booking, outcome, byShop);
  // Freed slot -> offer it to the waitlist head (never breaks cancellation).
  try {
    const { offerNextInLine } = require('./waitlist');
    await offerNextInLine({
      shopUserId: booking.shop_user_id, staffId: booking.staff_id,
      startAt: booking.start_at, endAt: booking.end_at,
    });
  } catch (e) { console.error('waitlist offer failed:', e.message); }
  return { booking: await db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]), outcome };
}

// Shop marks a confirmed booking as a no-show: deposit forfeited to the
// shop per policy (payment/deposit row -> 'forfeited'; the shop's ledger
// credit stands).
async function markNoShow(bookingId, { now = Date.now() } = {}) {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
  if (!booking) throw err('NOT_FOUND', 'Booking not found.');
  if (booking.status !== 'confirmed') throw err('BAD_STATUS', 'Only confirmed bookings can be marked no-show.');
  const money = await paidMoneyFor(booking);
  if (money) {
    if (money.kind === 'payment') {
      await db.update('booking_payments', money.row.id, { status: 'forfeited' });
    } else {
      await db.update('booking_deposits', money.row.id, { status: 'forfeited' });
    }
  }
  await db.update('bookings', bookingId, { status: 'no_show', cancelled_at: now });
  const fresh = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [booking.shop_user_id]);
  await notifyUser(booking.customer_user_id, {
    kind: 'booking', title: 'Marked as no-show',
    body: `Your appointment at ${shop ? shop.display_name : 'the shop'} was marked as a no-show. Per the shop's policy the deposit is forfeited.`,
    link: '/bookings/manage',
  });
  await notifyUser(booking.shop_user_id, {
    kind: 'booking', title: 'No-show recorded',
    body: `Booking ${booking.id.slice(0, 8)} marked as no-show — deposit forfeited to you per your policy.`,
    link: '/bookings/manage',
  });
  return fresh;
}

// Shop marks a confirmed booking completed.
async function markCompleted(bookingId, { now = Date.now() } = {}) {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
  if (!booking) throw err('NOT_FOUND', 'Booking not found.');
  if (booking.status !== 'confirmed') throw err('BAD_STATUS', 'Only confirmed bookings can be completed.');
  await db.update('bookings', bookingId, { status: 'completed', completed_at: now });
  const fresh = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [booking.shop_user_id]);
  await notifyUser(booking.customer_user_id, {
    kind: 'booking', title: 'Appointment completed',
    body: `Your appointment at ${shop ? shop.display_name : 'the shop'} is marked complete. Thanks for booking through Tattoo Art Customs!`,
    link: `/bookings/receipt/${booking.id}`,
  });
  return fresh;
}

// Expire stale pending_deposit holds (per-shop slot_hold_minutes).
async function expireStaleHolds(now = Date.now()) {
  const pendings = await db.all(
    `SELECT b.id, b.shop_user_id, b.created_at, COALESCE(s.slot_hold_minutes, 30) AS hold_min
     FROM bookings b LEFT JOIN shop_booking_settings s ON s.shop_user_id = b.shop_user_id
     WHERE b.status = 'pending_deposit'`);
  let expired = 0;
  for (const p of pendings) {
    const holdMs = (Number(p.hold_min) > 0 ? Number(p.hold_min) : 30) * 60000;
    if (Number(p.created_at) + holdMs <= now) {
      await db.update('bookings', p.id, { status: 'expired' });
      expired += 1;
    }
  }
  return expired;
}

// --- Notifications ---------------------------------------------------------

async function shopDisplayName(shopUserId) {
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [String(shopUserId)]);
  return shop ? shop.display_name : 'the shop';
}

function fmtWhen(ts) {
  return new Date(Number(ts)).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

async function notifyBookingConfirmed(booking, fees) {
  const shop = await db.get('SELECT display_name, email FROM users WHERE id = ?', [booking.shop_user_id]);
  const customer = await db.get('SELECT display_name, email FROM users WHERE id = ?', [booking.customer_user_id]);
  const when = fmtWhen(booking.start_at);
  const shopName = shop ? shop.display_name : 'the shop';
  await notifyUser(booking.customer_user_id, {
    kind: 'booking', title: 'Booking confirmed',
    body: `Your appointment at ${shopName} is confirmed for ${when}. Total charged: $${(fees.total / 100).toFixed(2)}.`,
    link: `/bookings/receipt/${booking.id}`,
  });
  await notifyUser(booking.shop_user_id, {
    kind: 'booking', title: 'New booking',
    body: `${customer ? customer.display_name : 'A customer'} booked ${when}. You receive $${(fees.base / 100).toFixed(2)} (100%).`,
    link: '/bookings/manage',
  });
  if (customer && customer.email) {
    try {
      await sendMail({
        to: customer.email,
        subject: `Booking confirmed — ${shopName} on ${when}`,
        text: `Your appointment at ${shopName} is confirmed for ${when}.\n\n`
          + formatReceiptLines(fees).join('\n')
          + `\n\nThe 5% platform fee is non-refundable. See your receipt: /bookings/receipt/${booking.id}`,
      });
    } catch (e) { console.error('booking confirm mail failed:', e.message); }
  }
}

async function notifyDepositPaid(dep) {
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [dep.shop_user_id]);
  const customer = await db.get('SELECT display_name FROM users WHERE id = ?', [dep.customer_user_id]);
  await notifyUser(dep.customer_user_id, {
    kind: 'booking', title: 'Deposit received',
    body: `Your $${(dep.total_cents / 100).toFixed(2)} deposit for ${shop ? shop.display_name : 'the shop'} is paid. Now pick your slot to lock in the appointment.`,
    link: `/bookings/deposit-first/${dep.id}/slots`,
  });
  await notifyUser(dep.shop_user_id, {
    kind: 'booking', title: 'Deposit received',
    body: `${customer ? customer.display_name : 'A customer'} paid a $${(dep.amount_cents / 100).toFixed(2)} deposit (you receive 100%).`,
    link: '/bookings/manage',
  });
}

async function notifyBookingCanceled(booking, outcome, byShop) {
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [booking.shop_user_id]);
  const customer = await db.get('SELECT display_name FROM users WHERE id = ?', [booking.customer_user_id]);
  const shopName = shop ? shop.display_name : 'the shop';
  const custName = customer ? customer.display_name : 'A customer';
  const outcomeText = {
    canceled_unpaid: 'No payment had been made, so nothing was charged.',
    refunded_base: 'The deposit (base amount) was refunded. The 5% platform fee is non-refundable.',
    forfeited: 'The cancellation was outside the free-cancel window, so the deposit is forfeited to the shop per its policy.',
    refund_failed_manual: 'The automatic refund failed — the shop will handle your refund manually.',
  }[outcome] || '';
  await notifyUser(booking.customer_user_id, {
    kind: 'booking', title: 'Booking canceled',
    body: `Your appointment at ${shopName} (${fmtWhen(booking.start_at)}) was canceled. ${outcomeText}`,
    link: '/bookings/manage',
  });
  await notifyUser(booking.shop_user_id, {
    kind: 'booking', title: 'Booking canceled',
    body: `${byShop ? 'You canceled' : custName + ' canceled'} the ${fmtWhen(booking.start_at)} appointment. ${outcomeText}`,
    link: '/bookings/manage',
  });
}

// --- Session balances ----------------------------------------------------------
// The shop records a remaining session balance on a confirmed booking; the
// customer pays it through the website PayPal/card checkout (never Google
// Play Billing). Idempotent; the shop nets exactly `base`.
async function recordBalanceDue({ bookingId, shopUserId, amountCents, now = Date.now() }) {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [String(bookingId)]);
  if (!booking) throw err('NOT_FOUND', 'Booking not found.');
  if (booking.shop_user_id !== String(shopUserId)) throw err('FORBIDDEN', 'Not your booking.');
  if (!['confirmed', 'completed'].includes(booking.status)) {
    throw err('BAD_STATUS', 'A balance can only be recorded on a confirmed booking.');
  }
  const amt = Number(amountCents);
  if (!Number.isInteger(amt) || amt < 100) throw err('BAD_AMOUNT', 'Balance must be at least $1.00.');
  const existing = await db.get(
    "SELECT id FROM booking_payments WHERE booking_id = ? AND kind = 'balance' AND status IN ('pending', 'paid')",
    [booking.id]);
  if (existing) throw err('EXISTS', 'A balance payment already exists for this booking.');
  const fees = computeBookingFees(amt);
  const paymentId = await db.insert('booking_payments', {
    booking_id: booking.id, kind: 'balance',
    base_cents: fees.base, platform_fee_cents: fees.platformFee,
    processing_cents: fees.processing, total_cents: fees.total,
    status: 'pending', created_at: now,
  });
  const shopName = await shopDisplayName(booking.shop_user_id);
  await notifyUser(booking.customer_user_id, {
    kind: 'booking', title: 'Session balance due',
    body: `${shopName} recorded a session balance of ${(fees.total / 100).toFixed(2)} on your booking — pay it on the website whenever you're ready.`,
    link: `/bookings/receipt/${booking.id}`,
  });
  return { paymentId, fees };
}

// Capture a pending balance payment after website checkout. The booking stays
// confirmed; the shop is credited exactly `base`.
async function captureBalancePayment(paymentId, { captureId = null, orderId = null, customerUserId = null } = {}) {
  const payment = await db.get('SELECT * FROM booking_payments WHERE id = ?', [String(paymentId)]);
  if (!payment || payment.kind !== 'balance') throw err('NOT_FOUND', 'Balance payment not found.');
  if (customerUserId && payment.booking_id) {
    const b = await db.get('SELECT customer_user_id FROM bookings WHERE id = ?', [payment.booking_id]);
    if (!b || b.customer_user_id !== String(customerUserId)) throw err('NOT_FOUND', 'Balance payment not found.');
  }
  if (payment.status === 'paid') {
    return { payment, already: true };
  }
  if (payment.status !== 'pending') throw err('BAD_STATUS', 'This balance payment is no longer pending.');
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [payment.booking_id]);
  if (!booking) throw err('NOT_FOUND', 'Booking not found.');
  const fees = {
    base: payment.base_cents, platformFee: payment.platform_fee_cents,
    processing: payment.processing_cents, total: payment.total_cents,
  };
  const now = db.now();
  await db.update('booking_payments', payment.id, {
    status: 'paid', paypal_capture_id: captureId || null,
    paypal_order_id: orderId || payment.paypal_order_id || null,
  });
  const receiptId = await db.insert('receipts', {
    booking_id: booking.id, kind: 'balance',
    lines_json: JSON.stringify({
      lines: formatReceiptLines(fees), booking_id: booking.id,
      captured_at: now, capture_id: captureId || null,
    }),
    shop_receives_cents: fees.base, customer_total_cents: fees.total, created_at: now,
  });
  await creditShopForBase({
    shopUserId: booking.shop_user_id, baseCents: fees.base,
    refId: booking.id, commissionType: 'booking_balance',
  });
  const shopName = await shopDisplayName(booking.shop_user_id);
  await notifyUser(booking.customer_user_id, {
    kind: 'booking', title: 'Balance paid',
    body: `Your session balance at ${shopName} is paid in full.`,
    link: `/bookings/receipt/${booking.id}`,
  });
  return {
    booking, payment: await db.get('SELECT * FROM booking_payments WHERE id = ?', [payment.id]),
    receipt: await db.get('SELECT * FROM receipts WHERE id = ?', [receiptId]), already: false,
  };
}

module.exports = {
  getBookingSettings, saveBookingSettings, depositBaseCents, depositFees,
  createPendingBooking, confirmBooking,
  startDepositFirst, captureDeposit, bookWithDeposit,
  cancelBooking, markNoShow, markCompleted, expireStaleHolds,
  recordBalanceDue, captureBalancePayment,
  creditShopForBase, reduceShopCredit, verifyBookingCommissions,
};
