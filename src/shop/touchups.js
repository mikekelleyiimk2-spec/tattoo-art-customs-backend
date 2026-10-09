// Touch-up bookings (shop toolset).
//
// A touch-up is a follow-up booking linked to a completed booking
// (bookings.parent_booking_id, bookings.booking_type = 'touchup').
// The deposit comes from shop_booking_settings.touchup_deposit_cents
// (default 0). A $0 touch-up deposit skips payment entirely and confirms
// immediately; a positive touch-up deposit goes through the normal
// pending_deposit checkout, priced from the booking's own deposit_cents.
const db = require('../db');
const { isSlotFree } = require('./bookingSlots');
const { computeBookingFees } = require('./bookingFees');
const {
  getBookingSettings, withShopBookingLock,
} = require('./bookingFlow');

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function touchupDepositBase(settings) {
  const amt = Number(settings && settings.touchup_deposit_cents);
  return Number.isInteger(amt) && amt >= 0 ? amt : 0;
}

// Fees for a touch-up booking: priced from the booking's own deposit_cents
// (not the shop's standard deposit settings).
function touchupFees(booking) {
  return computeBookingFees(Number(booking.deposit_cents) || 0);
}

// Completed bookings by this customer at this shop that do not already have
// a touch-up booked against them.
async function getTouchupEligible(customerUserId, shopUserId) {
  return db.all(
    `SELECT b.* FROM bookings b
     WHERE b.customer_user_id = ? AND b.shop_user_id = ?
       AND b.status = 'completed'
       AND (b.booking_type IS NULL OR b.booking_type = 'standard')
       AND NOT EXISTS (
         SELECT 1 FROM bookings t
         WHERE t.parent_booking_id = b.id AND t.status NOT IN ('cancelled')
       )
     ORDER BY b.completed_at DESC`,
    [customerUserId, shopUserId]);
}

async function createTouchupBooking({ shopUserId, customerUserId, parentBookingId,
  staffId = null, chairId = null, startAt, endAt, now = Date.now() }) {
  const parent = await db.get('SELECT * FROM bookings WHERE id = ?', [parentBookingId]);
  if (!parent) throw err('NOT_FOUND', 'Original booking not found.');
  if (String(parent.customer_user_id) !== String(customerUserId)) {
    throw err('FORBIDDEN', 'That booking is not yours.');
  }
  if (String(parent.shop_user_id) !== String(shopUserId)) {
    throw err('BAD_SHOP', 'That booking belongs to a different shop.');
  }
  if (parent.status !== 'completed') {
    throw err('BAD_STATUS', 'Touch-ups can only be booked for completed tattoos.');
  }
  const existing = await db.get(
    "SELECT id FROM bookings WHERE parent_booking_id = ? AND status NOT IN ('cancelled') LIMIT 1",
    [parentBookingId]);
  if (existing) throw err('DUP', 'A touch-up is already booked for this tattoo.');
  return withShopBookingLock(shopUserId, async () => {
    const settings = await getBookingSettings(shopUserId);
    if (Number(settings.deposit_before_booking) === 1) {
      throw err('DEPOSIT_FIRST', 'This shop collects deposits before booking — touch-ups are not available in that mode yet.');
    }
    const free = await isSlotFree(shopUserId, { staffId, chairId, startAt, endAt, now });
    if (!free) throw err('SLOT_TAKEN', 'That slot is no longer available.');
    const depositBase = touchupDepositBase(settings);
    const status = depositBase === 0 ? 'confirmed' : 'pending_deposit';
    const id = await db.insert('bookings', {
      shop_user_id: shopUserId, customer_user_id: customerUserId,
      staff_id: staffId || null, chair_id: chairId || null,
      start_at: startAt, end_at: endAt, status,
      deposit_cents: depositBase, source: 'touchup',
      design_id: parent.design_id || null,
      booking_type: 'touchup', parent_booking_id: parentBookingId,
      created_at: now,
    });
    if (status === 'confirmed') {
      // Free touch-up: no payment, no ledger credit — the confirmed status is
      // enough for reminders/aftercare to fire like a normal booking.
    }
    return db.get('SELECT * FROM bookings WHERE id = ?', [id]);
  });
}

module.exports = {
  touchupDepositBase, touchupFees, getTouchupEligible, createTouchupBooking,
};
