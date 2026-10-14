// Business cards for tattoo-shop subscribers (owner order 2026-10-14).
//
// Pricing — FINAL (owner, 2026-10-14): BOTH models combined — paid
// orders at real Printful fulfillment cost x 1.25 per quantity tier,
// PLUS one FREE box for annual-plan shops (smallest set only, 50
// cards, once per shop ever). The cost inputs live in
// config.businessCards.tiers (see config.js for the evidence trail —
// live Printful estimate-costs quotes, 2026-10-14). This module is the
// single place the pricing + free-box math happens, so it stays
// auditable.
//
// Fulfillment: Printful product 724 "Set of Business Cards" (3.5"x2",
// double-sided). The shop's chosen art is the card FRONT; the card BACK
// is composed here from the shop's contact lines (SVG -> PNG via sharp)
// so a card ordered with just a logo still carries the shop's details.
// Both files are served to Printful through the token-gated
// /prints/file/:id route (see routes/prints.js + lib/printful.js).
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');

function tiers() {
  return config.businessCards.tiers;
}

function tierKeys() {
  return Object.keys(tiers());
}

function getTier(key) {
  return tiers()[String(key)] || null;
}

// Selling price in cents: cost x (1 + margin), rounded to the cent.
// Returns null for an unknown tier — callers must treat that tier as
// unpurchasable (no verifiable cost, no sale; owner rule).
function priceCentsFor(key) {
  const tier = getTier(key);
  if (!tier || !tier.cost || !tier.cost.totalCents) return null;
  return Math.round(tier.cost.totalCents * (1 + config.businessCards.marginRate));
}

// --- Free first box (owner ruling 2026-10-14) ---
// Shops on the ANNUAL tattoo_shop plan get ONE free box of the
// smallest set (freeTierKey = 50 cards), once per shop account, ever.
// "Annual" is read from the plan itself: plans.interval = 'year' on
// the tattoo_shop plan (the shop plan is sold annual-only; a monthly
// shop plan, if one is ever added, has interval 'month' and does NOT
// qualify). The subscription must be active at order time, using the
// same active semantics as hasActiveSubscription (status 'active' and
// the current period not ended; lifetime rows have a NULL end and
// count as active). Redemption is the is_free_box flag on
// business_card_orders (migration 088) — one row with the flag set
// means the shop's free box is spent, forever.
function freeTierKey() {
  return String(config.businessCards.freeTierKey || '50');
}

async function annualShopSubscription(userId) {
  return db.get(
    `SELECT s.id FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = ? AND p.slug = 'tattoo_shop' AND p.interval = 'year'
       AND s.status = 'active'
       AND (s.current_period_end IS NULL OR s.current_period_end > ?)`,
    [userId, Date.now()]).catch(() => null);
}

async function freeBoxRedeemed(userId) {
  const row = await db.get(
    'SELECT id FROM business_card_orders WHERE user_id = ? AND is_free_box = 1 LIMIT 1',
    [userId]).catch(() => null);
  return !!row;
}

// { available, annual, redeemed } — the offer is only ever SHOWN (and
// only ever honored) when available is true.
async function freeBoxStatus(userId) {
  const annual = !!(await annualShopSubscription(userId));
  const redeemed = annual ? await freeBoxRedeemed(userId) : false;
  return { available: annual && !redeemed, annual, redeemed };
}

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Compose the card BACK as a print-ready PNG (1125x675 = 3.75"x2.25" at
// 300 DPI, Printful's business-card file size including bleed): white
// stock, shop name prominent, then the contact lines the shop entered.
// Returns the absolute path of the written file (uploads/bcards/).
async function composeBackImage({ outDir, fileBase, shopName, lines }) {
  const sharp = require('sharp');
  const W = 1125;
  const H = 675;
  const clean = (lines || []).map((l) => String(l || '').trim()).filter(Boolean).slice(0, 6);
  const parts = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<text x="${W / 2}" y="200" font-family="DejaVu Sans, Arial, sans-serif" font-size="72" font-weight="bold" fill="#111111" text-anchor="middle">${xmlEscape(shopName || '')}</text>`);
  let y = 300;
  for (const line of clean) {
    parts.push(`<text x="${W / 2}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="44" fill="#333333" text-anchor="middle">${xmlEscape(line)}</text>`);
    y += 68;
  }
  parts.push(`<text x="${W / 2}" y="${H - 40}" font-family="DejaVu Sans, Arial, sans-serif" font-size="26" fill="#888888" text-anchor="middle">tattoo-art-customs.onrender.com</text>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`;
  fs.mkdirSync(outDir, { recursive: true });
  const abs = path.join(outDir, `${fileBase}-back.png`);
  await sharp(Buffer.from(svg)).png().toFile(abs);
  return abs;
}

module.exports = {
  tiers, tierKeys, getTier, priceCentsFor, composeBackImage,
  freeTierKey, annualShopSubscription, freeBoxRedeemed, freeBoxStatus,
};
