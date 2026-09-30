// Shop purchase incentives (owner rule 2026-09-29).
//
// 1) Referral volume tiers: 20% base -> 22% at 25+ verified (paid,
//    unrefunded) referral sales in the calendar month -> 25% at 50+.
//    Tiers reset on the 1st of each month. The uplift comes ONLY from the
//    owner's share; designer percentages never move (applied in
//    commissions.recordSaleCommissions).
//
// 2) Booking-conversion bonus: a referred purchase (orders.referred_shop_id)
//    that converts into a CONFIRMED booking at the same shop, by the same
//    buyer, within 30 days earns the shop a bonus — flat $5 on premade
//    orders, 5% of the order base on customs (config.bookingBonus).
//    One bonus per order, even with multiple bookings. Funded from site
//    operations; designer and base shop splits are untouched.
const db = require('../db');
const config = require('../config');

// [startMs, endMs] of the America/Chicago calendar month containing nowMs.
// The business runs on Chicago time (sale windows, crons), so tiers reset
// on Chicago month boundaries.
function chicagoMonthBounds(nowMs = Date.now()) {
  const tz = 'America/Chicago';
  const dFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const tFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const partsOf = (fmt, ms) =>
    Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  // UTC instant of midnight on the 1st of (yy, mm) in Chicago. Refine from
  // a guess by the wall-clock error; converges since the UTC offset is
  // constant around midnight on the 1st (DST flips at 2am, never midnight).
  const monthStartChicago = (yy, mm) => {
    const target = Date.UTC(yy, mm - 1, 1, 0, 0);
    let guess = target + 6 * 3600000;
    for (let i = 0; i < 5; i++) {
      const c = partsOf(tFmt, guess);
      const wall = Date.UTC(+c.year, +c.month - 1, +c.day, (+c.hour) % 24, +c.minute);
      const diff = target - wall;
      if (diff === 0) break;
      guess += diff;
    }
    return guess;
  };
  const d = partsOf(dFmt, nowMs);
  const y = +d.year, m = +d.month;
  const start = monthStartChicago(y, m);
  const end = m === 12 ? monthStartChicago(y + 1, 1) : monthStartChicago(y, m + 1);
  return [start, end];
}

// Verified referral sales for a shop inside [startMs, endMs): paid and not
// refunded. (Refunds, if any, are recorded as status='refunded'.)
async function monthlyReferralSales(shopId, startMs, endMs) {
  if (!shopId) return 0;
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM orders
     WHERE referred_shop_id = ? AND status = 'paid' AND paid_at >= ? AND paid_at < ?`,
    [shopId, startMs, endMs]);
  return Number(row && row.n) || 0;
}

// The referral rate a shop's NEXT recorded sale earns, from its verified
// referral sales this calendar month. Called at commission time, when the
// just-paid order is already status='paid', so the count includes it —
// the sale that reaches the threshold earns the higher rate.
async function shopVolumeTierRate(shopId, nowMs = Date.now()) {
  const [start, end] = chicagoMonthBounds(nowMs);
  const n = await monthlyReferralSales(shopId, start, end);
  const tiers = [...(config.referralTiers.tiers || [])]
    .sort((a, b) => b.minMonthlySales - a.minMonthlySales);
  for (const t of tiers) {
    if (n >= t.minMonthlySales) return t.rate;
  }
  return config.referralTiers.baseRate;
}

// Dashboard view of a shop's tier: current rate, this month's verified
// referral sales, and progress to the next tier.
async function shopReferralTier(shopId, nowMs = Date.now()) {
  const [start, end] = chicagoMonthBounds(nowMs);
  const n = await monthlyReferralSales(shopId, start, end);
  const base = config.referralTiers.baseRate;
  const tiers = [...(config.referralTiers.tiers || [])]
    .sort((a, b) => a.minMonthlySales - b.minMonthlySales); // desc
  let rate = base;
  let next = null;
  for (const t of [...tiers].reverse()) { // asc
    if (n >= t.minMonthlySales) rate = t.rate;
    else if (!next) next = t;
  }
  return {
    rate,
    baseRate: base,
    salesThisMonth: n,
    nextTierRate: next ? next.rate : null,
    nextTierAt: next ? next.minMonthlySales : null,
    salesToNext: next ? next.minMonthlySales - n : 0,
  };
}

// Booking-conversion bonus. Called with a freshly CONFIRMED booking.
// Awards the shop a bonus when the booking's buyer made a referred
// purchase at this shop (orders.referred_shop_id) that was paid within
// the 30-day window — flat $5 on premades, 5% of the order base on
// customs. One bonus per order, even with multiple bookings.
// Returns the bonus cents, or null when nothing was awarded.
async function maybeAwardBookingBonus(booking) {
  if (!booking || booking.status !== 'confirmed') return null;
  const shopId = booking.shop_user_id;
  const buyerId = booking.customer_user_id;
  if (!shopId || !buyerId) return null;
  const windowStart = booking.created_at - config.bookingBonus.windowDays * 86400000;
  // The most recent qualifying purchase: paid, attributed to this shop,
  // inside the window, of a bonus-eligible type, with no bonus yet.
  const order = await db.get(
    `SELECT * FROM orders
     WHERE buyer_id = ? AND referred_shop_id = ?
       AND status = 'paid' AND paid_at >= ? AND paid_at <= ?
       AND order_type IN ('premade', 'custom')
       AND NOT EXISTS (SELECT 1 FROM commission_ledger
                       WHERE order_id = orders.id AND commission_type = 'booking_bonus')
     ORDER BY paid_at DESC LIMIT 1`,
    [buyerId, shopId, windowStart, booking.created_at]);
  if (!order) return null;
  const bonus = order.order_type === 'custom'
    ? Math.round(order.amount_cents * config.bookingBonus.customRate)
    : config.bookingBonus.premadeFlatCents;
  if (!(bonus > 0)) return null;
  // Funded from site operations; designer and base shop splits untouched.
  // Payable when the shop can receive payouts, otherwise forfeited to
  // the site per the standing forfeiture rule (no payout destination).
  const { recipientEligible } = require('../lib/commissions');
  const eligible = await recipientEligible(shopId, 'shop');
  await db.insert('commission_ledger', {
    order_id: order.id,
    recipient_type: 'shop',
    recipient_id: shopId,
    amount_cents: bonus,
    commission_type: 'booking_bonus',
    status: eligible ? 'payable' : 'site_kept',
    created_at: db.now(),
  });
  return bonus;
}

module.exports = {
  chicagoMonthBounds,
  monthlyReferralSales,
  shopVolumeTierRate,
  shopReferralTier,
  maybeAwardBookingBonus,
};
