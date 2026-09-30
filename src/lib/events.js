// Flash events lib (shop toolset, Phase 3).
//
// Shops post pop-up flash events; customers sign up. Capacity is enforced
// inside a transaction (count of 'signed_up' < cap), and the
// UNIQUE(event_id, customer_user_id) pair plus an explicit check reject
// duplicate signups.
const db = require('../db');
const { computeBookingFees, formatReceiptLines } = require('../shop/bookingFees');

function parsePriceCents(v) {
  if (v == null || String(v).trim() === '') return 0;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0) throw new Error('Registration price must be $0 or more.');
  return n;
}

function parseWhen(v) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

async function createEvent({ shopUserId, title, description, startsAt, endsAt, cap }) {
  const t = String(title || '').trim().slice(0, 120);
  if (!t) throw new Error('Give the event a title.');
  const start = typeof startsAt === 'number' ? startsAt : parseWhen(startsAt);
  if (!start || start <= Date.now()) throw new Error('The start time must be in the future.');
  const end = endsAt == null || endsAt === '' ? null
    : (typeof endsAt === 'number' ? endsAt : parseWhen(endsAt));
  if (end && end <= start) throw new Error('The end time must be after the start.');
  let c = null;
  if (cap != null && String(cap).trim() !== '') {
    c = parseInt(cap, 10);
    if (!Number.isInteger(c) || c < 1) throw new Error('Capacity must be a positive number.');
  }
  return db.insert('shop_events', {
    shop_user_id: String(shopUserId), title: t,
    description: String(description || '').trim().slice(0, 2000) || null,
    starts_at: start, ends_at: end, cap: c, status: 'open',
  });
}

async function createEvent({ shopUserId, title, description, startsAt, endsAt, cap, registrationPriceCents }) {
  const t = String(title || '').trim().slice(0, 120);
  if (!t) throw new Error('Give the event a title.');
  const start = typeof startsAt === 'number' ? startsAt : parseWhen(startsAt);
  if (!start || start <= Date.now()) throw new Error('The start time must be in the future.');
  const end = endsAt == null || endsAt === '' ? null
    : (typeof endsAt === 'number' ? endsAt : parseWhen(endsAt));
  if (end && end <= start) throw new Error('The end time must be after the start.');
  let c = null;
  if (cap != null && String(cap).trim() !== '') {
    c = parseInt(cap, 10);
    if (!Number.isInteger(c) || c < 1) throw new Error('Capacity must be a positive number.');
  }
  const priceCents = parsePriceCents(registrationPriceCents);
  return db.insert('shop_events', {
    shop_user_id: String(shopUserId), title: t,
    description: String(description || '').trim().slice(0, 2000) || null,
    starts_at: start, ends_at: end, cap: c, status: 'open',
    registration_price_cents: priceCents,
  });
}

// Sign up for an event. Free events confirm immediately. Paid events
// (registration_price_cents > 0) create a 'pending_payment' signup plus a
// pending event_signup_payments row and return { needsPayment: true } so the
// caller can send the customer through website PayPal/card checkout —
// tool-suite payments never use Google Play Billing.
async function signupForEvent({ eventId, customerUserId }) {
  return db.transaction(async (tx) => {
    const ev = await tx.get('SELECT * FROM shop_events WHERE id = ?', [String(eventId)]);
    if (!ev || ev.status !== 'open') throw new Error('This event is not open for signups.');
    if (ev.starts_at <= Date.now()) throw new Error('This event has already started.');
    const mine = await tx.get(
      'SELECT * FROM event_signups WHERE event_id = ? AND customer_user_id = ?',
      [ev.id, String(customerUserId)]);
    if (mine && mine.status === 'signed_up') throw new Error('You are already signed up for this event.');
    const priceCents = Number(ev.registration_price_cents) || 0;
    if (priceCents <= 0) {
      if (ev.cap != null) {
        const cnt = await tx.get(
          "SELECT COUNT(*) AS n FROM event_signups WHERE event_id = ? AND status = 'signed_up'", [ev.id]);
        if ((cnt.n || 0) >= ev.cap) throw new Error('This event is full.');
      }
      if (mine) {
        await tx.query("UPDATE event_signups SET status = 'signed_up' WHERE id = ?", [mine.id]);
        return { signupId: mine.id, needsPayment: false };
      }
      const signupId = db.newId();
      await tx.query(
        'INSERT INTO event_signups (id, event_id, customer_user_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
        [signupId, ev.id, String(customerUserId), 'signed_up', db.now()]);
      return { signupId, needsPayment: false };
    }
    // Paid event: reuse an in-progress payment if one exists.
    if (mine && mine.status === 'pending_payment') {
      const pay = await tx.get(
        "SELECT * FROM event_signup_payments WHERE signup_id = ? AND status = 'pending'", [mine.id]);
      if (pay) return { signupId: mine.id, paymentId: pay.id, needsPayment: true };
    }
    if (ev.cap != null) {
      const cnt = await tx.get(
        "SELECT COUNT(*) AS n FROM event_signups WHERE event_id = ? AND status = 'signed_up'", [ev.id]);
      if ((cnt.n || 0) >= ev.cap) throw new Error('This event is full.');
    }
    const fees = computeBookingFees(priceCents);
    const signupId = db.newId();
    await tx.query(
      'INSERT INTO event_signups (id, event_id, customer_user_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
      [signupId, ev.id, String(customerUserId), 'pending_payment', db.now()]);
    const paymentId = db.newId();
    await tx.query(
      `INSERT INTO event_signup_payments
         (id, signup_id, event_id, customer_user_id, base_cents, platform_fee_cents,
          processing_cents, total_cents, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [paymentId, signupId, ev.id, String(customerUserId),
        fees.base, fees.platformFee, fees.processing, fees.total, db.now()]);
    return { signupId, paymentId, needsPayment: true, fees };
  });
}

// Confirm a paid event signup after the website checkout captures.
// Idempotent. Credits the shop exactly `base` (100% of its listed price).
async function confirmEventSignupPayment(paymentId, { captureId = null, orderId = null, customerUserId = null } = {}) {
  const pay = await db.get('SELECT * FROM event_signup_payments WHERE id = ?', [String(paymentId)]);
  if (!pay) throw new Error('Payment not found.');
  if (customerUserId && pay.customer_user_id !== String(customerUserId)) throw new Error('Payment not found.');
  if (pay.status === 'paid') {
    const signup = await db.get('SELECT * FROM event_signups WHERE id = ?', [pay.signup_id]);
    return { signup, payment: pay, already: true };
  }
  if (pay.status !== 'pending') throw new Error('This payment is no longer pending.');
  const ev = await db.get('SELECT * FROM shop_events WHERE id = ?', [pay.event_id]);
  if (!ev || ev.status !== 'open') throw new Error('This event is no longer open for signups.');
  if (ev.starts_at <= Date.now()) throw new Error('This event has already started.');
  const fees = {
    base: pay.base_cents, platformFee: pay.platform_fee_cents,
    processing: pay.processing_cents, total: pay.total_cents,
  };
  const now = db.now();
  await db.update('event_signup_payments', pay.id, {
    status: 'paid', paypal_capture_id: captureId || null,
    paypal_order_id: orderId || pay.paypal_order_id || null,
  });
  await db.update('event_signups', pay.signup_id, { status: 'signed_up' });
  await db.insert('receipts', {
    booking_id: null, gift_card_id: null, kind: 'event_registration',
    lines_json: JSON.stringify({
      lines: formatReceiptLines(fees), event_id: ev.id, event_title: ev.title,
      captured_at: now, capture_id: captureId || null,
    }),
    shop_receives_cents: fees.base, customer_total_cents: fees.total, created_at: now,
  });
  const { creditShopForBase } = require('../shop/bookingFlow');
  await creditShopForBase({
    shopUserId: ev.shop_user_id, baseCents: fees.base,
    refId: 'event:' + pay.signup_id, commissionType: 'event_registration',
  });
  const signup = await db.get('SELECT * FROM event_signups WHERE id = ?', [pay.signup_id]);
  const { notifyUser } = require('./notify');
  await notifyUser(ev.shop_user_id, {
    kind: 'event-signup', title: 'New paid event signup',
    body: `A customer registered for "${ev.title}" (${(fees.base / 100).toFixed(2)} to you).`,
    link: '/events/manage',
  });
  return { signup, payment: await db.get('SELECT * FROM event_signup_payments WHERE id = ?', [pay.id]), already: false };
}

// Leave an event. Paid signups left before the event starts get `base`
// refunded via PayPal (the 5% platform fee is never refunded); after the
// event starts the registration is forfeited.
async function leaveEvent({ eventId, customerUserId }) {
  const signup = await db.get(
    'SELECT * FROM event_signups WHERE event_id = ? AND customer_user_id = ? AND status IN (\'signed_up\', \'pending_payment\')',
    [String(eventId), String(customerUserId)]);
  if (!signup) return { outcome: 'not_signed_up' };
  const pay = await db.get(
    'SELECT * FROM event_signup_payments WHERE signup_id = ? ORDER BY created_at DESC LIMIT 1', [signup.id]);
  let outcome = 'left';
  if (pay && pay.status === 'paid') {
    const ev = await db.get('SELECT * FROM shop_events WHERE id = ?', [signup.event_id]);
    if (ev && ev.starts_at > Date.now() && pay.paypal_capture_id) {
      let refunded = false;
      try {
        const paypal = require('./paypal');
        await paypal.refundCheckoutCapture(pay.paypal_capture_id, pay.base_cents);
        refunded = true;
      } catch (e) { console.error('event refund failed:', e.message); }
      if (refunded) {
        await db.update('event_signup_payments', pay.id, { status: 'refunded', refunded_cents: pay.base_cents });
        const { reduceShopCredit } = require('../shop/bookingFlow');
        await reduceShopCredit('event:' + signup.id, pay.base_cents);
        outcome = 'refunded_base';
      } else {
        outcome = 'refund_failed_manual';
      }
    } else if (ev && ev.starts_at <= Date.now()) {
      await db.update('event_signup_payments', pay.id, { status: 'forfeited' });
      outcome = 'forfeited';
    }
  } else if (pay && pay.status === 'pending') {
    await db.update('event_signup_payments', pay.id, { status: 'cancelled' });
  }
  await db.update('event_signups', signup.id, { status: 'cancelled' });
  return { outcome };
}

async function closeEvent({ eventId, shopUserId }) {
  const ev = await db.get('SELECT * FROM shop_events WHERE id = ? AND shop_user_id = ?',
    [String(eventId), String(shopUserId)]);
  if (!ev) throw new Error('Event not found.');
  await db.update('shop_events', ev.id, { status: 'closed' });
  return ev;
}

async function getUpcomingEvents(customerUserId) {
  return db.all(
    `SELECT e.*, u.display_name AS shop_name,
            (SELECT COUNT(*) FROM event_signups s WHERE s.event_id = e.id AND s.status = 'signed_up') AS signup_count,
            (SELECT s2.id FROM event_signups s2 WHERE s2.event_id = e.id AND s2.customer_user_id = ? AND s2.status = 'signed_up') AS my_signup
     FROM shop_events e JOIN users u ON u.id = e.shop_user_id
     WHERE e.status = 'open' AND e.starts_at > ?
     ORDER BY e.starts_at ASC LIMIT 100`, [String(customerUserId), Date.now()]);
}

async function getShopEvents(shopUserId) {
  return db.all(
    `SELECT e.*,
            (SELECT COUNT(*) FROM event_signups s WHERE s.event_id = e.id AND s.status = 'signed_up') AS signup_count
     FROM shop_events e WHERE e.shop_user_id = ?
     ORDER BY e.starts_at DESC LIMIT 100`, [String(shopUserId)]);
}

async function getEventWithCount(eventId) {
  const ev = await db.get(
    `SELECT e.*, u.display_name AS shop_name FROM shop_events e
     JOIN users u ON u.id = e.shop_user_id WHERE e.id = ?`, [String(eventId)]);
  if (!ev) return null;
  const c = await db.get(
    "SELECT COUNT(*) AS n FROM event_signups WHERE event_id = ? AND status = 'signed_up'", [eventId]);
  ev.signup_count = (c && c.n) || 0;
  return ev;
}

async function getEventAttendees(eventId) {
  return db.all(
    `SELECT s.*, u.display_name, u.email FROM event_signups s
     JOIN users u ON u.id = s.customer_user_id
     WHERE s.event_id = ? AND s.status = 'signed_up' ORDER BY s.created_at ASC`,
    [String(eventId)]);
}

module.exports = {
  parseWhen, parsePriceCents, createEvent, signupForEvent, confirmEventSignupPayment,
  leaveEvent, closeEvent, getUpcomingEvents, getShopEvents, getEventWithCount, getEventAttendees,
};
