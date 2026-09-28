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

module.exports = { isSaleWindow, isMemberSaleWindow, salePriceActive, premadePriceCents, customFullCents, customDepositCents, money, chicagoParts, LINEWORK_ONLY_DISCOUNT, lineworkOnlyPriceCents, processingFeeCents, withFeeCents, withPlayFeeCents };
