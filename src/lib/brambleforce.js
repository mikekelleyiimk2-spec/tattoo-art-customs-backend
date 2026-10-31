// Brambleforce sideload store (owner orders 2026-10-30: the completed
// game goes on sale on our own doors first — website door first — at
// full price with every in-app purchase available).
//
// The game side speaks a fixed contract (game www store block +
// MainActivity door allowlist):
//   buy taps open  <BASE>/brambleforce/buy/<product_id>
//   REDEEM CODE    POST <BASE>/api/brambleforce/redeem {code}
//                  -> 200 {product} | {error: "spent"} | {error: "unknown"}
//
// Prices + blurbs are the struck catalogue (design plan sections 8/17,
// mirrored in the game's STORE array — keep the two in lockstep).
// Lives, continues, health and difficulty relief are NEVER sold
// (fairness law) and are not in this catalogue.
//
// ROTATION (owner order 2026-10-31): the storefront is a monthly
// updated thing — skins / weapon effects / limited editions cycle in
// dated DROPS. A product may carry:
//   availableFrom / availableTo — 'YYYY-MM-DD' window bounds, read in
//     America/Chicago (the house timezone). Outside the window the
//     product is NOT purchasable: hidden from the storefront, its buy
//     page refuses, checkout cannot mint it. No window = always on
//     (every launch product).
//   drop — the id of a named drop in DROPS below; drop members render
//     in the storefront's "This Month's Drop" section, not the
//     permanent grid, while their drop is live.
//   disabled: true — defined but dark: not visible, not purchasable,
//     buy page 404s. This is how a future drop is seeded ahead of its
//     art/content; flipping it off is one step of going live.
// Windows gate PURCHASE only, never ownership: an unlock code already
// issued redeems forever, window or no window (redeemCode below never
// consults the window — by design, do not "fix" that).
//
// BUNDLE BOUNDARY (owner ruling 2026-10-31, verbatim sense: "the big
// buy it all button does not cover limited editions and monthly
// cycles, just the initial expansions and skins that we offered"):
// the Everything Bundle grants the LAUNCH catalogue's extras only —
// permanently. Drop / limited-edition products are NEVER in the grant
// set, even when they share a product class with launch items (a drop
// skin is still a skin; it is still not in the bundle). The gate is
// drop membership, enforced in BUNDLE_GRANTS below — do not widen it
// without a fresh owner ruling.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { sendMail } = require('./mail');

const PACKAGE = 'com.usefulappz.game2runandgun';

// id -> { name, priceCents, blurb, kind }
// kind 'game' delivers the sideload APK (gated app-updates store);
// kind 'iap' issues a single-use unlock code on payment.
const PRODUCTS = {
  game: {
    name: 'Brambleforce — Full Game (Android APK)',
    priceCents: 699,
    blurb: 'Run-and-gun through a killer garden. 10 missions, 4 fighters, 11 bosses. Zero ads — it is a paid game, it acts like one.',
    kind: 'game',
  },
  everything_bundle: {
    name: 'Everything Bundle — All Of It',
    priceCents: 2799,
    blurb: 'Everything: every mode, skin, extra and fighter below, plus the expansion. One price.',
    kind: 'iap',
  },
  iron_garden_expansion: {
    name: 'The Iron Garden — Sequel Campaign',
    priceCents: 499,
    blurb: 'The expansion campaign. A post-launch drop — buying today locks it in.',
    kind: 'iap',
  },
  boss_rush_time_attack: {
    name: 'Boss Rush + Time Attack',
    priceCents: 199,
    blurb: 'All eleven bosses back to back on one stock, and the clock on every mission.',
    kind: 'iap',
  },
  queens_hunt: {
    name: "Queen's Hunt — Mother Orchid Survival",
    priceCents: 199,
    blurb: 'She hunts you in her garden. Last as long as you can.',
    kind: 'iap',
  },
  fighter_zola: {
    name: 'Fighter — Zola "Sickle" Adeyemi',
    priceCents: 199,
    blurb: 'New fighter. Pendulum grapple-swing physics — hook, swing, release — with full voice and her full kit.',
    kind: 'iap',
  },
  fighter_otto: {
    name: 'Fighter — Otto "Auger" Fenn',
    priceCents: 199,
    blurb: 'New fighter. Committed drill-dash physics — point the auger, pull the trigger, ride it through.',
    kind: 'iap',
  },
  fighter_yusuf: {
    name: 'Fighter — Yusuf "Trowel" Barakat',
    priceCents: 199,
    blurb: 'New fighter. Planter/setup kit — turrets, decoy and snare, laid before the fight starts.',
    kind: 'iap',
  },
  skin_tor: {
    name: 'Skin — Tor: Neon Spectre',
    priceCents: 99,
    blurb: 'Cosmetic palette for Tor. Visual only.',
    kind: 'iap',
  },
  skin_selene: {
    name: 'Skin — Selene: Neon Spectre',
    priceCents: 99,
    blurb: 'Cosmetic palette for Selene Marroquín. Visual only.',
    kind: 'iap',
  },
  skin_dane: {
    name: 'Skin — Dane: Neon Spectre',
    priceCents: 99,
    blurb: 'Cosmetic palette for Dane. Visual only.',
    kind: 'iap',
  },
  skin_mara: {
    name: 'Skin — Mara: Neon Spectre',
    priceCents: 99,
    blurb: 'Cosmetic palette for Mara. Visual only.',
    kind: 'iap',
  },
  weapon_tracers: {
    name: 'Weapon Tracers + Muzzle FX',
    priceCents: 99,
    blurb: 'A glow on every shot. Visual only — prettier violence.',
    kind: 'iap',
  },
  crt_filter: {
    name: 'Retro CRT / 8-Bit Filter Pack',
    priceCents: 99,
    blurb: 'Scanlines, glow and vignette, like the old cabinet.',
    kind: 'iap',
  },
  soundtrack: {
    name: 'Soundtrack',
    priceCents: 199,
    blurb: 'The original score, playable in the in-game jukebox.',
    kind: 'iap',
  },
  art_vault: {
    name: 'Cast Art Vault',
    priceCents: 99,
    blurb: 'The official cast cards at full size.',
    kind: 'iap',
  },
  war_bond: {
    name: 'War Bond — Supporter Pack',
    priceCents: 499,
    blurb: 'Zero gameplay. Pure support — and our thanks on the title screen.',
    kind: 'iap',
  },

  // ---- SEEDED FUTURE DROP (proof of shape, NOT stock) ----------------
  // The December 2026 holiday drop, defined ahead of its content.
  // Every entry is disabled:true — invisible, unpurchasable, buy pages
  // 404 — until the drop's art + game content exists and a sitting
  // flips them live (see the go-live checklist in
  // your_files/brambleforce-rotation-system-2026-10-31.md). Prices
  // match the launch cosmetic pattern ($0.99 class). These ids are
  // deliberately NOT mirrored in the game's STORE array or Play yet:
  // there is nothing to unlock until the content ships.
  skin_tor_frostpine: {
    name: 'Skin — Tor: Frostpine',
    priceCents: 99,
    blurb: 'Holiday drop. Frosted pine-and-snow palette for Tor. Visual only.',
    kind: 'iap',
    drop: '2026-12-winter',
    availableFrom: '2026-12-01',
    availableTo: '2026-12-31',
    disabled: true,
  },
  skin_mara_holly: {
    name: 'Skin — Mara: Hollybright',
    priceCents: 99,
    blurb: 'Holiday drop. Holly-red and winter-green palette for Mara. Visual only.',
    kind: 'iap',
    drop: '2026-12-winter',
    availableFrom: '2026-12-01',
    availableTo: '2026-12-31',
    disabled: true,
  },
  tracer_snowfall: {
    name: 'Weapon Tracers — Snowfall',
    priceCents: 99,
    blurb: 'Holiday drop. Every shot trails drifting snow. Visual only.',
    kind: 'iap',
    drop: '2026-12-winter',
    availableFrom: '2026-12-01',
    availableTo: '2026-12-31',
    disabled: true,
  },
  weapon_fx_frostbite: {
    name: 'Weapon Effect — Frostbite Bloom',
    priceCents: 99,
    blurb: 'Holiday drop. Hits bloom with frost crystals. Visual only.',
    kind: 'iap',
    drop: '2026-12-winter',
    availableFrom: '2026-12-01',
    availableTo: '2026-12-31',
    disabled: true,
  },
};

// Named drops. Products point here with their `drop` field; the label
// is what the storefront section is headed with.
const DROPS = {
  '2026-12-winter': {
    label: "Kringle's Garden — Holiday Drop",
    blurb: 'Winter in the killer garden: holiday skins and effects, here for December and then retired.',
  },
};

const PRODUCT_IDS = Object.keys(PRODUCTS);

// The launch catalogue, frozen by id (owner order 2026-10-30). The
// bundle boundary is read against THIS list, never against whatever
// the catalogue happens to hold later — new products (drops, limited
// editions) join PRODUCTS freely without ever touching it.
const LAUNCH_PRODUCT_IDS = [
  'game', 'everything_bundle', 'iron_garden_expansion',
  'boss_rush_time_attack', 'queens_hunt',
  'fighter_zola', 'fighter_otto', 'fighter_yusuf',
  'skin_tor', 'skin_selene', 'skin_dane', 'skin_mara',
  'weapon_tracers', 'crt_filter', 'soundtrack', 'art_vault', 'war_bond',
];

// The Everything Bundle's grant set (owner rulings 2026-10-30 +
// 2026-10-31): a bundle unlock code grants the LAUNCH extras — the
// original 12 plus the three fighters (fighter_zola / fighter_otto /
// fighter_yusuf), 15 in all. Extras bought separately total $28.85;
// the bundle is struck at $27.99.
//
// BOUNDARY, enforced three ways so it cannot drift:
//   1. the set is derived from LAUNCH_PRODUCT_IDS, not PRODUCT_IDS —
//      a product added to the catalogue later is not granted, period;
//   2. any product carrying a `drop` is filtered out — drop membership
//      is the gate, not product class (a drop skin is not granted
//      even though launch skins are);
//   3. test/brambleforce.js pins the set at exactly these 15 ids.
// Limited editions and monthly-cycle products always sell separately.
const BUNDLE_GRANTS = LAUNCH_PRODUCT_IDS.filter(
  (id) => id !== 'game' && id !== 'everything_bundle' && !(PRODUCTS[id] && PRODUCTS[id].drop)
);

// ---- availability windows + drops ------------------------------------
// Window bounds are calendar dates in America/Chicago. All helpers
// take an explicit today ('YYYY-MM-DD') so tests can travel in time;
// the routes call them with chicagoToday().
const chicagoDateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
});

function chicagoToday(now = new Date()) {
  const parts = {};
  for (const p of chicagoDateFmt.formatToParts(now)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// 'before' | 'open' | 'after' — a product with no window is always
// 'open'. Bounds are inclusive: availableFrom is the first sale day,
// availableTo the last.
function windowState(p, todayStr) {
  if (!p) return 'after';
  const t = todayStr || chicagoToday();
  if (p.availableFrom && t < p.availableFrom) return 'before';
  if (p.availableTo && t > p.availableTo) return 'after';
  return 'open';
}

function isPurchasable(p, todayStr) {
  return Boolean(p) && !p.disabled && windowState(p, todayStr) === 'open';
}

function purchasableIds(todayStr) {
  return PRODUCT_IDS.filter((id) => isPurchasable(PRODUCTS[id], todayStr));
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// '2026-12-31' -> 'Dec 31' (the storefront's plain window language).
function dayLabel(dateStr) {
  if (!dateStr) return '';
  const parts = String(dateStr).split('-').map(Number);
  return `${MONTH_NAMES[(parts[1] || 1) - 1]} ${parts[2] || ''}`.trim();
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}

// The drop the storefront section should show, or null:
//   { mode: 'active', ... } — at least one member is purchasable now;
//     the section sells those members and states the window end.
//   { mode: 'ended', ... } — every member's window has passed within
//     the last 30 days; the section shows them retired, not buyable.
// A drop whose members are all disabled (a seeded future drop) is in
// neither mode: it does not exist as far as the storefront is concerned.
function dropInfo(todayStr) {
  const t = todayStr || chicagoToday();
  const byDrop = {};
  for (const id of PRODUCT_IDS) {
    const p = PRODUCTS[id];
    if (p.drop) (byDrop[p.drop] = byDrop[p.drop] || []).push(id);
  }
  for (const [dropId, ids] of Object.entries(byDrop)) {
    const live = ids.filter((id) => isPurchasable(PRODUCTS[id], t));
    if (!live.length) continue;
    const ends = ids.map((id) => PRODUCTS[id].availableTo).filter(Boolean).sort().pop() || null;
    const meta = DROPS[dropId] || {};
    return {
      mode: 'active', id: dropId, label: meta.label || dropId, blurb: meta.blurb || '',
      productIds: live, ends, endsLabel: ends ? dayLabel(ends) : null,
    };
  }
  let best = null;
  for (const [dropId, ids] of Object.entries(byDrop)) {
    // Retired display covers only members that were ever live: a
    // still-disabled member was never sold and is not "retired", it
    // simply never shipped.
    const sold = ids.filter((id) => !PRODUCTS[id].disabled);
    if (!sold.length) continue;
    if (!sold.every((id) => windowState(PRODUCTS[id], t) === 'after')) continue;
    const endedOn = sold.map((id) => PRODUCTS[id].availableTo).filter(Boolean).sort().pop();
    if (!endedOn) continue;
    const age = daysBetween(endedOn, t);
    if (age < 1 || age > 30) continue;
    if (best && endedOn <= best.endedOn) continue;
    const meta = DROPS[dropId] || {};
    best = {
      mode: 'ended', id: dropId, label: meta.label || dropId, blurb: meta.blurb || '',
      productIds: sold, endedOn, endedLabel: dayLabel(endedOn),
    };
  }
  return best;
}

function product(id) {
  return Object.prototype.hasOwnProperty.call(PRODUCTS, id) ? PRODUCTS[id] : null;
}

// Order type per product. The game order MUST carry the buyApp
// convention (`sideload:<package>`) — the gated app-updates APK route
// DB-checks exactly that string before serving a byte.
function orderType(id) {
  const p = product(id);
  if (!p) return null;
  return p.kind === 'game' ? `sideload:${PACKAGE}` : `brambleforce:${id}`;
}

// ---- unlock codes ----------------------------------------------------
// 16 chars from A-Z / 2-9 (no confusables: no 0/O/1/I), grouped
// XXXX-XXXX-XXXX-XXXX. Only the SHA-256 of the normalized (dashless,
// uppercase) form is stored.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode() {
  const bytes = crypto.randomBytes(16);
  let raw = '';
  for (let i = 0; i < 16; i += 1) raw += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return raw.replace(/(.{4})(?=.)/g, '$1-');
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
}

function hashCode(code) {
  return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}

// Issue the (single) unlock code for a paid IAP order. Idempotent: a
// capture retry / double-approve returns the existing code row's raw
// code only when it was minted in this call — the raw code is never
// stored, so a re-issue after the fact cannot recover it; in that case
// this returns { code: null, alreadyIssued: true } and the caller
// points the buyer at their email copy.
async function issueCodeForOrder(order, productId) {
  const existing = await db.get('SELECT * FROM brambleforce_codes WHERE order_id = ?', [order.id]);
  if (existing) return { code: null, alreadyIssued: true, row: existing };
  // A hash collision on a fresh random code is astronomically unlikely;
  // retry a couple of times rather than failing a paid order.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = generateCode();
    try {
      const id = await db.insert('brambleforce_codes', {
        code_hash: hashCode(code), product: productId, order_id: order.id,
        spent: 0, spent_at: null, created_at: db.now(),
      });
      const row = await db.get('SELECT * FROM brambleforce_codes WHERE id = ?', [id]);
      return { code, alreadyIssued: false, row };
    } catch (e) {
      if (!/unique|duplicate/i.test(String(e && e.message))) throw e;
    }
  }
  throw new Error('could not mint a unique unlock code');
}

// Redeem per the game contract. Returns exactly one of:
//   { product: '<id>' }  — code found + unspent (now marked spent).
//     A bundle code additionally carries `grants`: the full grant set
//     (BUNDLE_GRANTS, all 15 extras) so the game grants everything the
//     bundle promises from the server's own mapping, not a hardcoded
//     list that can age out when the catalogue grows.
//   { error: 'spent' }   — code found but already redeemed
//   { error: 'unknown' } — no such code (incl. malformed input)
async function redeemCode(rawCode) {
  const normalized = normalizeCode(rawCode);
  if (normalized.length !== 16) return { error: 'unknown' };
  const row = await db.get('SELECT * FROM brambleforce_codes WHERE code_hash = ?', [hashCode(normalized)]);
  if (!row) return { error: 'unknown' };
  if (row.spent) return { error: 'spent' };
  // Race-safe flip: the UPDATE only lands while spent is still 0, and
  // db.query reports the affected-row count in both db modes — a
  // simultaneous double-redeem loses with changes = 0 and reads spent.
  const { changes } = await db.query(
    'UPDATE brambleforce_codes SET spent = 1, spent_at = ? WHERE id = ? AND spent = 0',
    [db.now(), row.id]
  );
  if (!changes) return { error: 'spent' };
  if (row.product === 'everything_bundle') return { product: row.product, grants: BUNDLE_GRANTS.slice() };
  return { product: row.product };
}

// Email the unlock code to the buyer (success page shows it too; mail
// is the durable copy). Best-effort like the guest receipts: payment is
// already captured when this runs, a mail failure never breaks the
// buyer's flow — it is logged, and the success page carries the code.
async function sendCodeEmail({ to, productId, code, successUrl }) {
  if (!to || !code) return false;
  const p = product(productId);
  const lines = [
    'Hi there,',
    '',
    `Thanks for your purchase — payment is complete.`,
    '',
    `${p ? p.name : productId} unlock code:`,
    code,
    '',
    'To use it: open Brambleforce -> EXTRAS (B on the title screen) -> REDEEM CODE -> type this code.',
    'Codes are single-use — once redeemed, the unlock lives in your game for good.',
    '',
    `Your purchase page (receipt) is here:`,
    successUrl,
    '',
    'If you have any trouble, just reply to this email.',
    '',
    '— Useful Appz / Tattoo Art Customs',
  ];
  try {
    await sendMail({
      to,
      subject: `Your Brambleforce unlock code — ${p ? p.name : productId}`,
      text: lines.join('\n'),
    });
    return true;
  } catch (e) {
    console.error('brambleforce code email failed:', e.message);
    return false;
  }
}

// Email the game buyer their download page (the fleet paid-download
// pattern: the page link is durable, the APK itself stays gated).
async function sendGameEmail({ to, successUrl }) {
  if (!to) return false;
  const lines = [
    'Hi there,',
    '',
    'Thanks for your purchase — payment is complete.',
    '',
    'Download Brambleforce (Android APK) from your purchase page:',
    successUrl,
    '',
    'Open the file on your Android phone — allow installs from this source if asked — and tap Install.',
    'Built for controllers, keyboard, and touch. Zero ads.',
    '',
    'Keep this email — it is your receipt and your way back to the download page.',
    'If you have any trouble installing, just reply to this email.',
    '',
    '— Useful Appz / Tattoo Art Customs',
  ];
  try {
    await sendMail({
      to,
      subject: 'Your download is ready — Brambleforce (Android)',
      text: lines.join('\n'),
    });
    return true;
  } catch (e) {
    console.error('brambleforce game email failed:', e.message);
    return false;
  }
}

function baseUrl() {
  return config.baseUrl;
}

module.exports = {
  PACKAGE, PRODUCTS, PRODUCT_IDS, LAUNCH_PRODUCT_IDS, DROPS, BUNDLE_GRANTS,
  product, orderType,
  chicagoToday, windowState, isPurchasable, purchasableIds, dayLabel, dropInfo,
  generateCode, normalizeCode, hashCode, issueCodeForOrder, redeemCode,
  sendCodeEmail, sendGameEmail, baseUrl,
};
