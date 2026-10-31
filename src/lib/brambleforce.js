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
    priceCents: 1699,
    blurb: 'Every mode, skin and extra below, plus the expansion. One price.',
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
};

const PRODUCT_IDS = Object.keys(PRODUCTS);

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
//   { product: '<id>' }  — code found + unspent (now marked spent)
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
  PACKAGE, PRODUCTS, PRODUCT_IDS, product, orderType,
  generateCode, normalizeCode, hashCode, issueCodeForOrder, redeemCode,
  sendCodeEmail, sendGameEmail, baseUrl,
};
