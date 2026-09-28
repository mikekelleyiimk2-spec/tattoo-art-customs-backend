// Pricing logic. Single source of truth for the Saturday sale window.
//
// Saturday sale: every Saturday 7:00 PM -> Sunday 5:00 AM America/Chicago.
// During the window premade designs are $50 (regular $75).
// Custom designs are always $150 with a 50% deposit and 48-hour delivery.
const config = require('../config');

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

function premadePriceCents(date = new Date()) {
  return isSaleWindow(date)
    ? config.pricing.premadeSale
    : config.pricing.premadeRegular;
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

module.exports = { isSaleWindow, premadePriceCents, money, chicagoParts };
