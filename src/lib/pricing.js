// Pricing logic. Single source of truth for the Saturday sale window.
//
// Saturday sale: every Saturday 7:00 PM -> Sunday 5:00 AM America/Chicago.
// During the window premade designs are $50 (regular $75) and custom designs
// are $125 (regular $150). Custom deposit is always 50%, 48-hour delivery.
//
// Subscriber perk: active members enter the sale at 6:00 PM CT (one hour
// before the public 7:00 PM start). Pass member=true (resolved via the async
// salePriceActive(user) helper) to price for a member.
const config = require('../config');
const { isActiveMember } = require('../middleware/auth');

function chicagoParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', hour: 'numeric', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, hour: parseInt(parts.hour, 10) % 24 };
}

function isSaleWindow(date = new Date()) {
  const { weekday, hour } = chicagoParts(date);
  // Saturday 19:00-23:59, or Sunday 00:00-04:59 (i.e. before 5 AM)
  return (weekday === 'Sat' && hour >= 19) || (weekday === 'Sun' && hour < 5);
}

// Member early-entry window: Saturday 18:00 -> Sunday 05:00 America/Chicago.
function isMemberSaleWindow(date = new Date()) {
  const { weekday, hour } = chicagoParts(date);
  return (weekday === 'Sat' && hour >= 18) || (weekday === 'Sun' && hour < 5);
}

// Is the sale price in effect for this user right now? Members see sale
// prices from 6 PM Saturday; everyone sees them from 7 PM.
async function salePriceActive(user, date = new Date()) {
  if (isSaleWindow(date)) return true;
  if (!isMemberSaleWindow(date)) return false;
  return isActiveMember(user);
}

function premadePriceCents(date = new Date(), member = false) {
  return (isSaleWindow(date) || (member && isMemberSaleWindow(date)))
    ? config.pricing.premadeSale
    : config.pricing.premadeRegular;
}

// Custom design full price: $125 during the Saturday sale, $150 regular.
function customFullCents(date = new Date(), member = false) {
  return (isSaleWindow(date) || (member && isMemberSaleWindow(date)))
    ? config.pricing.customSaleFull
    : config.pricing.customFull;
}

// Custom deposit is always 50% of the current full price.
function customDepositCents(date = new Date(), member = false) {
  return Math.round(customFullCents(date, member) / 2);
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// Linework-only purchase discount (owner rule: the discount may never exceed
// 3% — the value below is clamped to that ceiling, so raising it here can
// never silently break the rule).
const LINEWORK_ONLY_DISCOUNT = Math.min(Math.max(0.03, 0), 0.03);

// Price for a linework-only purchase: list price minus the discount.
function lineworkOnlyPriceCents(fullCents) {
  return Math.round(fullCents * (1 - LINEWORK_ONLY_DISCOUNT));
}

// STANDING RULE: processing fees are always passed through into prices,
// never absorbed. Web transactions carry +3.5% + $0.49 (covers the ~3.49%
// + $0.49 PayPal/card fee); in-app membership sales carry +15% (covers
// Google Play's 15% cut). Any new processing charge gets added the same way.

// One-time first-custom discount (owner rule 2026-09-29): an eligible
// subscriber's FIRST custom commission is 20% off the advertised custom
// price ($155.74 -> $124.59 base). The processing fee is computed on the
// discounted amount, never absorbed; splits keep their percentages on the
// discounted base. Never stackable with the Saturday sale or any other
// discount — best-deal-wins (see customPriceQuote in lib/firstCustom.js).
const FIRST_CUSTOM_DISCOUNT_RATE = 0.20;
const FIRST_CUSTOM_DISCOUNT_CODE = 'first_custom_20';

// Discounted base for an eligible first custom: 20% off the advertised
// (fee-inclusive) regular custom price. = 12459 ($124.59).
function firstCustomFullCents() {
  return Math.round(withFeeCents(config.pricing.customFull) * (1 - FIRST_CUSTOM_DISCOUNT_RATE));
}

// First-custom deposit: always 50% of the discounted full price.
function firstCustomDepositCents() {
  return Math.round(firstCustomFullCents() / 2);
}

// Processing fee added to a web transaction (cents): 3.5% of the base + 49c.
function processingFeeCents(baseCents) {
  return Math.round(baseCents * 0.035) + 49;
}

// Total the customer pays on the website for a base price: price + fee.
function withFeeCents(baseCents) {
  return baseCents + processingFeeCents(baseCents);
}

// In-app (Google Play) membership price: base + 15% store cut.
function withPlayFeeCents(baseCents) {
  return Math.round(baseCents * 1.15);
}

// Rush custom option (owner rule 2026-09-30): at custom checkout the buyer
// may add a $30 rush fee for 24-hour delivery instead of the standard 48h.
// The fee is split 60/40 — $18 to the fulfilling designer/admin as the rush
// incentive (a 0c explicit row when the designer is suspended or ineligible,
// the site keeps it), $12 to site overhead — booked as
// dedicated commission_ledger rows (commission_type 'rush_fee') at routing
// time, NEVER folded into the 70/30 custom designer commission. The rush fee
// is disclosed at checkout and included in the processing-fee pass-through.
const RUSH_FEE_CENTS = 3000;
const RUSH_DESIGNER_CENTS = 1800;
const RUSH_SITE_CENTS = 1200;
const RUSH_SLA_HOURS = 24;
const STANDARD_SLA_HOURS = 48;

// POD custom tee (owner rule 2026-09-30): Bella + Canvas 3001 via Printful.
// Verified 2026-09-30: base ~$11.92 S-XL (+$2.00 per size above XL),
// US shipping $4.95, Stripe 2.9% + $0.30. Retail holds ~$10-11 margin per
// shirt after the processing-fee pass-through:
//   S-XL $28.99 -> 2899 - 114 (fee) - 1192 (base) - 495 (ship) = $10.98
//   2XL  $30.99 -> 3099 - 120 (fee) - 1392 (base) - 495 (ship) = $10.92
//   3XL  $32.99 -> 3299 - 126 (fee) - 1592 (base) - 495 (ship) = $10.86
const TEE_SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL'];
const TEE_COLORS = ['black', 'white'];
const TEE_PRICE_CENTS = { S: 2899, M: 2899, L: 2899, XL: 2899, '2XL': 3099, '3XL': 3299 };
function teePriceCents(size) {
  const s = String(size || 'M').toUpperCase();
  return TEE_PRICE_CENTS[s] || TEE_PRICE_CENTS.M;
}
function teeSizeLabel(size) {
  const s = String(size || 'M').toUpperCase();
  return TEE_SIZES.includes(s) ? s : 'M';
}
function teeColorLabel(color) {
  const c = String(color || 'black').toLowerCase();
  return TEE_COLORS.includes(c) ? c : 'black';
}

module.exports = { isSaleWindow, isMemberSaleWindow, salePriceActive, premadePriceCents, customFullCents, customDepositCents, money, chicagoParts, LINEWORK_ONLY_DISCOUNT, lineworkOnlyPriceCents, processingFeeCents, withFeeCents, withPlayFeeCents, FIRST_CUSTOM_DISCOUNT_RATE, FIRST_CUSTOM_DISCOUNT_CODE, firstCustomFullCents, firstCustomDepositCents, RUSH_FEE_CENTS, RUSH_DESIGNER_CENTS, RUSH_SITE_CENTS, RUSH_SLA_HOURS, STANDARD_SLA_HOURS, TEE_SIZES, TEE_COLORS, TEE_PRICE_CENTS, teePriceCents, teeSizeLabel, teeColorLabel };
