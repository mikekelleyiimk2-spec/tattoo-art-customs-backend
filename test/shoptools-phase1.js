// Phase 1 shop toolset: booking fee engine unit tests.
// The coordinator (test/run.js) wires this in; do not run from here.
const { computeBookingFees, flatBookingFee, formatReceiptLines } = require('../src/shop/bookingFees');

function runUnitTests(ok) {
  console.log('bookingFees:');
  const eq = (f, want, name) => ok(
    f.base === want.base && f.platformFee === want.platformFee &&
    f.processing === want.processing && f.total === want.total, name);

  eq(computeBookingFees(5000), { base: 5000, platformFee: 250, processing: 241, total: 5491 }, 'base 5000 vector');
  // NOTE: the brief's 10000 vector listed total 10930/processing 430, but the
  // owner-locked formula (Math.round((base+fee+49)/0.965)) yields 10932/432.
  // The formula is authoritative; this vector reflects its true output.
  eq(computeBookingFees(10000), { base: 10000, platformFee: 500, processing: 432, total: 10932 }, 'base 10000 vector');
  eq(computeBookingFees(100), { base: 100, platformFee: 5, processing: 55, total: 160 }, 'base 100 vector');
  eq(computeBookingFees(0), { base: 0, platformFee: 0, processing: 51, total: 51 }, 'base 0 vector');

  const flat = flatBookingFee();
  eq(flat, { base: 100, platformFee: 5, processing: 55, total: 160 }, 'flatBookingFee = computeBookingFees(100)');

  for (const b of [0, 1, 99, 100, 499, 5000, 19999, 100000]) {
    const f = computeBookingFees(b);
    ok(f.total - f.processing === f.base + f.platformFee, `invariant holds at base ${b}`);
  }

  const lines = formatReceiptLines(computeBookingFees(5000));
  ok(Array.isArray(lines) && lines.length === 4, 'receipt has 4 lines');
  ok(lines[0] === 'Shop receives: $50.00 (100%)', 'shop line');
  ok(lines[1] === 'Platform fee (5%): $2.50 (non-refundable)', 'platform line');
  ok(lines[2] === 'Processing: $2.41', 'processing line');
  ok(lines[3] === 'Total charged: $54.91', 'total line');

  let threw = false;
  try { computeBookingFees(-1); } catch (e) { threw = true; }
  ok(threw, 'negative base throws');
  threw = false;
  try { computeBookingFees(12.5); } catch (e) { threw = true; }
  ok(threw, 'non-integer base throws');
  threw = false;
  try { computeBookingFees('5000'); } catch (e) { threw = true; }
  ok(threw, 'string base throws');
}

module.exports = { runUnitTests };
