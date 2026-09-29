// Booking slot engine (shop toolset, Phase 2).
//
// Expands a shop's availability_rules into concrete bookable slots and
// subtracts the slots already taken by bookings.
//
// All slot math is done in UTC: rule start/end minutes are minutes-of-day
// UTC (shops state their hours in UTC on the settings page). Rule weekday
// follows Date.getUTCDay() (0 = Sunday .. 6 = Saturday), matching the
// availability_rules.weekday column.
//
// A booking blocks a slot when:
//   - status 'confirmed' (always), or
//   - status 'pending_deposit' AND the hold has not expired yet
//     (created_at within the shop's slot_hold_minutes), and
//   - the time windows overlap, and the staff/chair scopes overlap
//     (NULL on either side = applies to any staff/chair).
const db = require('../db');

const DAY_MS = 86400000;

function dayStartUtc(ts) { return Math.floor(ts / DAY_MS) * DAY_MS; }
function weekdayUtc(ts) { return new Date(ts).getUTCDay(); }

// Slot hold window for a shop, in ms (defaults from the settings row).
async function holdWindowMs(shopUserId) {
  const s = await db.get(
    'SELECT slot_hold_minutes FROM shop_booking_settings WHERE shop_user_id = ?', [shopUserId]);
  const mins = s && Number(s.slot_hold_minutes) > 0 ? Number(s.slot_hold_minutes) : 30;
  return mins * 60000;
}

// Active availability rules for a shop, filtered by staff/chair specificity.
// A rule with staff_id NULL applies to every staff member; a rule with a
// staff_id set applies only to that member (same for chairs).
async function matchingRules(shopUserId, staffId, chairId) {
  return db.all(
    `SELECT * FROM availability_rules
     WHERE shop_user_id = ? AND active = 1
       AND (staff_id IS NULL OR staff_id = ?)
       AND (chair_id IS NULL OR chair_id = ?)
     ORDER BY weekday, start_minutes`,
    [shopUserId, staffId || '', chairId || '']);
}

// Bookings that currently hold a slot: confirmed, plus pending_deposit
// bookings whose hold window has not expired yet.
async function blockingBookings(shopUserId, now) {
  const holdMs = await holdWindowMs(shopUserId);
  return db.all(
    `SELECT id, staff_id, chair_id, start_at, end_at, status, created_at
     FROM bookings
     WHERE shop_user_id = ? AND status IN ('pending_deposit', 'confirmed')`,
    [shopUserId]
  ).then((rows) => rows.filter((b) => {
    if (b.status === 'confirmed') return true;
    return (b.created_at || 0) + holdMs > now; // pending_deposit inside hold window
  }));
}

function timeOverlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Scope overlap: NULL on either side means "any".
function scopeOverlaps(slotVal, bookingVal) {
  return !slotVal || !bookingVal || slotVal === bookingVal;
}

function bookingBlocksSlot(slot, booking) {
  return timeOverlaps(slot.start_at, slot.end_at, booking.start_at, booking.end_at)
    && scopeOverlaps(slot.staff_id, booking.staff_id)
    && scopeOverlaps(slot.chair_id, booking.chair_id);
}

// Expand availability_rules into candidate slots in [fromTs, toTs).
// Each slot: { start_at, end_at, staff_id, chair_id } (staff/chair may be
// NULL = any). Slots already held by bookings are removed.
async function getOpenSlots(shopUserId, { staffId = null, chairId = null, fromTs, toTs, now = Date.now() } = {}) {
  if (!shopUserId || !Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) return [];
  const rules = await matchingRules(shopUserId, staffId, chairId);
  const candidates = [];
  for (let d = dayStartUtc(fromTs); d < toTs; d += DAY_MS) {
    const wd = weekdayUtc(d);
    for (const r of rules) {
      if (Number(r.weekday) !== wd) continue;
      const len = Number(r.slot_length_minutes) > 0 ? Number(r.slot_length_minutes) : 60;
      const startMin = Number(r.start_minutes);
      const endMin = Number(r.end_minutes);
      for (let m = startMin; m + len <= endMin; m += len) {
        const start = d + m * 60000;
        const end = start + len * 60000;
        if (start < fromTs || end > toTs) continue;
        candidates.push({
          start_at: start, end_at: end,
          staff_id: r.staff_id || null, chair_id: r.chair_id || null,
        });
      }
    }
  }
  const blockers = await blockingBookings(shopUserId, now);
  return candidates.filter((slot) => !blockers.some((b) => bookingBlocksSlot(slot, b)));
}

// True when the window [startAt, endAt) falls fully inside an active rule
// (matching staff/chair scope) AND no booking currently holds it.
// excludeBookingId: skip one booking (used when re-checking a booking's own slot).
async function isSlotFree(shopUserId, { staffId = null, chairId = null, startAt, endAt, excludeBookingId = null, now = Date.now() } = {}) {
  if (!shopUserId || !Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return false;
  // Must sit inside an active availability rule.
  const rules = await matchingRules(shopUserId, staffId, chairId);
  const dayStart = dayStartUtc(startAt);
  const wd = weekdayUtc(startAt);
  const inside = rules.some((r) => {
    if (Number(r.weekday) !== wd) return false;
    const ruleStart = dayStart + Number(r.start_minutes) * 60000;
    const ruleEnd = dayStart + Number(r.end_minutes) * 60000;
    return startAt >= ruleStart && endAt <= ruleEnd;
  });
  if (!inside) return false;
  const blockers = (await blockingBookings(shopUserId, now))
    .filter((b) => b.id !== excludeBookingId);
  const slot = { start_at: startAt, end_at: endAt, staff_id: staffId || null, chair_id: chairId || null };
  return !blockers.some((b) => bookingBlocksSlot(slot, b));
}

module.exports = { getOpenSlots, isSlotFree, holdWindowMs };
