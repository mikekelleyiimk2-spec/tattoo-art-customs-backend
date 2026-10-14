// House ads: OUR OWN ad creatives, shown in the existing ad slots when no
// direct-sold ad is booked (see views/partials/ad-slot.ejs chain:
// direct ad -> house ad -> AdSense remnant). Owner order 2026-10-14:
// "Make sure everything that can have ADS has ADS; make sure everything
// we sell is advertised" — AdSense is still in Google's review queue, so
// the slots promote what actually earns us money: our products and our
// affiliate partners. Zero cost, server-rendered, no client JS.
//
// HARD RULES (do not relax without a new owner ruling):
// - Kid-facing surfaces NEVER get tattoo affiliates. Creatives carry an
//   `audiences` list; the Little Inkers layout makes its own "no links
//   out" promise and carries no slot at all today — kid-safe creatives
//   (leda, littleinkers) exist for any future kid-safe surface that
//   permits outbound links.
// - CNC Tattoo is shop-subscriber-gated and NEVER appears here.
// - Affiliate creatives always render with the disclosure line and
//   rel="sponsored" (see views/partials/house-ad.ejs).
// - Kill switch: HOUSE_ADS=0 disables every house ad, everywhere.
//
// Copy lives in the locale catalogs under `houseads.*` (all 12 locales);
// this file holds only structure: ids, links, audience/pool membership.
const CREATIVES = [
  // --- Our products -------------------------------------------------------
  {
    id: 'odometer', kind: 'product', audiences: ['tattoo'], pools: ['any'],
    href: '/apps#odometer', external: false,
  },
  {
    id: 'aibutton', kind: 'product', audiences: ['tattoo'], pools: ['any'],
    href: '/apps#aibutton', external: false,
  },
  {
    id: 'tacpro', kind: 'product', audiences: ['tattoo'], pools: ['any'],
    href: '/apps', external: false,
  },
  {
    id: 'membership', kind: 'product', audiences: ['tattoo'], pools: ['any'],
    href: '/membership', external: false,
  },
  {
    id: 'bcards', kind: 'product', audiences: ['tattoo'], pools: ['any'],
    href: '/guides/for-tattoo-shops', external: false,
  },
  {
    id: 'merch', kind: 'product', audiences: ['tattoo'], pools: ['any'],
    href: '/merch', external: false,
  },
  {
    // Our own kids app — fine on the (adult) studio surfaces; the kids
    // pool exists for kid-safe pages. Never pair it with tattoo creative.
    id: 'littleinkers', kind: 'product', audiences: ['tattoo', 'kids'], pools: ['any'],
    href: '/little-inkers-android', external: false,
  },
  // --- Affiliates (tattoo surfaces only, except kid-safe Leda) ------------
  {
    id: 'baselabs', kind: 'affiliate', audiences: ['tattoo'], pools: ['any', 'aftercare'],
    href: 'https://baselabs.is/?coupon=TAC20', external: true,
  },
  {
    id: 'electrum', kind: 'affiliate', audiences: ['tattoo'], pools: ['any'],
    href: 'https://club.co/s/R6gQCOlWghEC9', external: true,
  },
  {
    id: 'drtattooskin', kind: 'affiliate', audiences: ['tattoo'], pools: ['any', 'aftercare'],
    href: 'https://www.drtattooskin.com/TATTOOARTCUSTOMS', external: true,
  },
  {
    id: 'recovery', kind: 'affiliate', audiences: ['tattoo'], pools: ['any', 'aftercare'],
    href: 'https://lasso.to/auGY590feE/', external: true,
  },
  {
    // Promotes the /aftercare guide from OTHER pages — deliberately not in
    // the 'aftercare' pool, or the slot on /aftercare would link to itself.
    id: 'amazonaftercare', kind: 'affiliate', audiences: ['tattoo'], pools: ['any'],
    href: '/aftercare', external: false,
  },
  {
    // Art supplies (kid-safe category, owner ruling 2026-10-14): the one
    // affiliate allowed in the kids pool.
    id: 'leda', kind: 'affiliate', audiences: ['tattoo', 'kids'], pools: ['any'],
    href: 'https://lasso.to/RfUlWaYEwK/', external: true,
  },
];

// Which audience/pool a named ad-slot renders with when it falls through
// to a house creative. Slots not listed default to tattoo/any.
const SLOT_CONTEXT = {
  leaderboard: { audience: 'tattoo', pool: 'any' },
  gallery_inline: { audience: 'tattoo', pool: 'any' },
  design_page: { audience: 'tattoo', pool: 'any' },
  home_inline: { audience: 'tattoo', pool: 'any' },
  aftercare_inline: { audience: 'tattoo', pool: 'aftercare' },
};

function enabled() {
  return process.env.HOUSE_ADS !== '0';
}

function candidates({ audience = 'tattoo', pool = 'any' } = {}) {
  return CREATIVES.filter(
    (c) => c.audiences.includes(audience) && (pool === 'any' || c.pools.includes(pool))
  );
}

// Deterministic rotation: the creative changes every minute and is salted
// per slot, so two slots on the same page never show the same creative and
// every visitor in the same minute sees the same page (cache-friendly).
// No JS, no impression writes — house promos don't need stats to earn.
function pick({ audience = 'tattoo', pool = 'any', slot = '' } = {}) {
  if (!enabled()) return null;
  const list = candidates({ audience, pool });
  if (!list.length) return null;
  let salt = 0;
  for (const ch of String(slot)) salt = (salt * 31 + ch.charCodeAt(0)) >>> 0;
  const bucket = Math.floor(Date.now() / 60000);
  return list[(bucket + salt) % list.length];
}

function pickForSlot(slot) {
  const ctx = SLOT_CONTEXT[slot] || { audience: 'tattoo', pool: 'any' };
  return pick({ ...ctx, slot });
}

// Entry point for views: explicit audience/pool win; anything omitted
// falls back to the slot's registered context, then the defaults.
function pickForContext({ slot = '', audience, pool } = {}) {
  const ctx = SLOT_CONTEXT[slot] || {};
  return pick({
    slot,
    audience: audience || ctx.audience || 'tattoo',
    pool: pool || ctx.pool || 'any',
  });
}

module.exports = { CREATIVES, SLOT_CONTEXT, enabled, candidates, pick, pickForSlot, pickForContext };
