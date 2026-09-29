// Booking fee engine (shop toolset, Phase 1).
//
// Owner-locked model for shop bookings:
//  - the SHOP always nets exactly `base` (its appointment/deposit price)
//  - the PLATFORM always nets exactly `platformFee` (5% of base, customer-paid)
//  - the CUSTOMER pays the grossed-up total so the ~3.49% + $0.49 processor
//    cut lands on nobody's net: total = round((base + platformFee + 49) / 0.965)
//
// The platform fee is NON-REFUNDABLE: when a booking is cancelled/refunded,
// refunds return `base` (to the shop's customer credit or cash) but the
// platform fee stays with the platform. Later phases must never refund it.
//
// Invariant: total - processing === base + platformFee.
const { money } = require('./pricing');

function computeBookingFees(baseCents) {
  if (!Number.isInteger(baseCents) || baseCents < 0) {
    throw new Error('baseCents must be a non-negative integer');
  }
  const base = baseCents;
  const platformFee = Math.round(baseCents * 0.05);
  const total = Math.round((baseCents + platformFee + 49) / 0.965);
  const processing = total - baseCents - platformFee;
  return { base, platformFee, processing, total };
}

// $1.00 flat fee for $0-deposit bookings (same gross-up as any other base).
function flatBookingFee() {
  return computeBookingFees(100);
}

function formatReceiptLines(fees) {
  const f = fees;
  return [
    `Shop receives: ${money(f.base)} (100%)`,
    `Platform fee (5%): ${money(f.platformFee)} (non-refundable)`,
    `Processing: ${money(f.processing)}`,
    `Total charged: ${money(f.total)}`,
  ];
}

module.exports = { computeBookingFees, flatBookingFee, formatReceiptLines };
