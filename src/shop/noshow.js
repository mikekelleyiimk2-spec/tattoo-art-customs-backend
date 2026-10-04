// No-show enforcement for shop bookings (shop toolset).
//
// When a booking is marked no_show (or cancelled inside the shop's
// cancellation window), the shop's policy decides whether the customer
// deposit is forfeited or released. The decision is recorded on the
// deposit_holds row. Auto-collection happens ONLY when PayPal is live AND
// config.autoChargeEnabled is on; until then every decided hold stays
// 'authorized' and the shop UI shows "PayPal connection needed to auto-collect".
//
// OWNER RULE: charging stays DISABLED until explicitly enabled. Nothing in
// this module ever touches a live payment — executeHoldDecision() is the
// single seam the PayPal wiring replaces later; today it always refuses.
const db = require('../db');
const config = require('../config');
const { getBookingSettings } = require('./bookingFlow');

// PayPal "live" check: credentials present. Mirrors config.paypalConfigured()
// but evaluated here so sweeps share one reading.
const paypalLive = !!(config.paypal && config.paypal.clientId && config.paypal.clientSecret);

// PURE policy evaluation — no DB, fully deterministic, unit-testable.
// Returns { outcome: 'forfeit'|'release', reason: string }.
function evaluateForfeit(booking, settings) {
  const policyOn = Number(settings && settings.noshow_forfeit_deposit) === 1;
  if (!policyOn) return { outcome: 'release', reason: 'policy_off' };
  if (booking && booking.status === 'no_show') return { outcome: 'forfeit', reason: 'no_show' };
  if (booking && booking.status === 'cancelled' && booking.cancelled_at) {
    const hoursBefore = (Number(booking.start_at) - Number(booking.cancelled_at)) / 3600000;
    const windowHours = Number(settings.cancel_window_hours);
    if (hoursBefore < windowHours) return { outcome: 'forfeit', reason: 'late_cancel' };
    return { outcome: 'release', reason: 'in_window' };
  }
  return { outcome: 'release', reason: 'default' };
}

// Idempotent: one hold per booking. Called when a booking becomes confirmed
// with a paid deposit (the router calls it; exported here for that use).
async function ensureHoldForBooking(booking) {
  const existing = await db.get('SELECT * FROM deposit_holds WHERE booking_id = ?', [booking.id]);
  if (existing) return existing;
  const id = await db.insert('deposit_holds', {
    booking_id: booking.id,
    customer_user_id: booking.customer_user_id,
    shop_user_id: booking.shop_user_id,
    amount_cents: Number(booking.deposit_cents) || 0,
    status: 'authorized',
    created_at: Date.now(),
  });
  return db.get('SELECT * FROM deposit_holds WHERE id = ?', [id]);
}

// Stamps the policy decision on the hold row. Auto-collects ONLY when
// forfeit + PayPal live + autoChargeEnabled; otherwise the hold stays
// 'authorized' and is collected manually later.
async function recordHoldDecision(bookingId, { outcome, reason } = {}) {
  const hold = await db.get('SELECT * FROM deposit_holds WHERE booking_id = ?', [bookingId]);
  if (!hold) return null;
  console.log(`[noshow] hold ${hold.id} decision: ${outcome} (${reason})`);
  const decidedAt = Date.now();
  await db.update('deposit_holds', hold.id, { decision: outcome, decided_at: decidedAt });
  if (outcome === 'forfeit' && paypalLive && config.autoChargeEnabled === true) {
    return executeHoldDecision({ ...hold, decision: outcome, decided_at: decidedAt });
  }
  // Until charging is enabled the shop UI shows
  // "PayPal connection needed to auto-collect" for decided forfeits.
  return db.get('SELECT * FROM deposit_holds WHERE id = ?', [hold.id]);
}

// THE single seam for live PayPal later. Today: refuse, and do NOT touch
// the hold. When PayPal is wired, this is the only function that changes.
function executeHoldDecision(hold) {
  return { ok: false, reason: 'paypal_not_live_or_disabled' };
}

// Re-attempt decided-but-unauthorized holds. NEVER charges today: on a
// declined seam the hold is logged and re-queued untouched.
async function runForfeitureSweep(now) {
  // 'now' is accepted for scheduler-signature parity; the sweep is driven
  // entirely by decided hold rows, not by time.
  const holds = await db.all(
    "SELECT * FROM deposit_holds WHERE decision IS NOT NULL AND status = 'authorized'"
  );
  for (const hold of holds) {
    try {
      const res = await executeHoldDecision(hold);
      if (!res || !res.ok) {
        console.log(`forfeiture sweep: hold ${hold.id} decided ${hold.decision} but PayPal not live/disabled — re-queued`);
      }
    } catch (e) {
      console.log(`forfeiture sweep: hold ${hold.id} decided ${hold.decision} but PayPal not live/disabled — re-queued`);
    }
  }
  return holds.length;
}

// Marks a confirmed booking no-show, ensures its deposit hold, and records
// the policy decision. Returns { booking, hold, decision }.
// Deposit holds for a shop's UI, with customer names, newest first.
async function getHoldsForShop(shopUserId, limit = 50) {
  return db.all(
    `SELECT dh.*, u.display_name AS customer_name
     FROM deposit_holds dh LEFT JOIN users u ON u.id = dh.customer_user_id
     WHERE dh.shop_user_id = ? ORDER BY dh.created_at DESC LIMIT ?`,
    [shopUserId, limit]
  );
}

module.exports = {
  evaluateForfeit,
  ensureHoldForBooking,
  recordHoldDecision,
  executeHoldDecision,
  runForfeitureSweep,
  getHoldsForShop,
};
