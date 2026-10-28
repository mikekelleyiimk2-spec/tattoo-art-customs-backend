// Healed Wall shop add-on (Bundle C Build 3, 2026-10-28).
// Lib phase: the add-on definition as config — price ASSESSED and
// pending owner strike (pricesLive:false), eligibility, fulfillment
// checklist, storefront flag default-off.
// HTTP phase: the offer page renders with NO dollar figure for the
// add-on while unstruck, the start path is the /contact inquiry with
// the desk marker, and the shops membership page + shop landing carry
// the add-on block linking to it.
// The coordinator (test/run.js) wires this in; do not run from here.
const fs = require('fs');
const path = require('path');

async function runDbTests(ok) {
  console.log('healed wall (add-on config):');
  const hw = require('../src/lib/healedWall');

  // Price: assessed, pending owner strike — never live, never public.
  ok(hw.pricesLive === false, 'healed wall pricesLive is false (unstruck)');
  ok(hw.PRICE_STATUS === 'assessed_pending_owner_strike', 'price status flagged ASSESSED — PENDING OWNER STRIKE');
  ok(hw.ASSESSED_PRICE.amountCents === 2499 && hw.ASSESSED_PRICE.interval === 'year',
    'assessed add-on price is the one proposed figure: $24.99/year');
  const pres = hw.pricePresentation();
  ok(pres.pricesLive === false && pres.amountCents === null,
    'price presentation exposes NO amount while unstruck (a view cannot print the assessed figure)');
  ok(pres.label === 'Founding add-on rate — announced to member shops first',
    'price presentation is the founding-rate notice while unstruck');

  // It rides the settled shop tier, as an add-on — never standalone.
  ok(hw.BASE_PLAN_SLUG === 'tattoo_shop' && hw.BASE_PLAN_PRICE_CENTS === 10398,
    'add-on attaches to the tattoo_shop tier at its settled $103.98/year');
  ok(hw.ELIGIBILITY.requiresPlanSlug === 'tattoo_shop' && hw.ELIGIBILITY.lapsesWithBase === true,
    'eligibility: active shop subscription required, wall lapses with the base membership');
  ok(hw.isEligible({ hasActiveShopSubscription: true }) === true
    && hw.isEligible({ hasActiveShopSubscription: false }) === false
    && hw.isEligible({}) === false,
    'isEligible requires an active shop subscription');

  // What's included: wall, aftercare pack, submission flow, moderation.
  const keys = hw.INCLUDES.map((i) => i.key);
  ok(['wall_section', 'aftercare_pack', 'submission_flow', 'moderation'].every((k) => keys.includes(k)),
    'includes: storefront wall + aftercare pack + client submission flow + moderation');

  // Fulfillment checklist: five honest steps, payment first and not live.
  ok(hw.FULFILLMENT_CHECKLIST.length === 5
    && hw.FULFILLMENT_CHECKLIST[0].key === 'payment_confirmed'
    && hw.FULFILLMENT_CHECKLIST[0].state === 'not_live_pending_price_strike',
    'fulfillment starts with payment confirmed — honestly not live until the price is struck');
  ok(hw.FULFILLMENT_CHECKLIST.map((s) => s.key).join(',')
    === 'payment_confirmed,wall_enabled,aftercare_pack_attached,shop_notified,first_photos_moderated',
    'fulfillment order: payment -> wall enabled -> aftercare attached -> shop notified -> first photos moderated');

  // Start path marker + storefront flag default-off (no schema yet).
  ok(hw.CONTACT_MARKER === 'Healed Wall add-on: ' && hw.CONTACT_TOPIC === 'shop',
    'inquiry rides POST /contact topic shop with the desk marker');
  ok(hw.DEMO_ENABLED === false && hw.storefrontEnabled() === false && hw.storefrontEnabled(true) === true,
    'storefront wall flag defaults OFF (demo flag false; only an explicit fulfillment flag lights it)');
  const sf = hw.forStorefront({ display_name: 'Ink Shop' });
  ok(sf.enabled === false && Array.isArray(sf.photos) && sf.aftercareGuideUrl === '/guides/aftercare',
    'forStorefront defaults disabled with the house aftercare links');

  // Storefront view hook is guarded: no flag local -> no-op render.
  const storefrontView = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'shop', 'storefront.ejs'), 'utf8');
  ok(storefrontView.includes("typeof healedWall !== 'undefined' && healedWall && healedWall.enabled"),
    'storefront view renders the wall only behind an enabled healedWall flag (no-op otherwise)');
}

async function runHttpTests(ok, req) {
  console.log('healed wall (offer page + blocks):');

  // Offer page: public, renders from the lib, no figure while unstruck.
  let r = await req('GET', '/membership/healed-wall');
  ok(r.status === 200, 'GET /membership/healed-wall -> 200');
  ok(r.text.includes('The Healed Wall'), 'offer page names the add-on');
  ok(r.text.includes('Founding add-on rate — announced to member shops first'),
    'offer page shows the founding-rate notice instead of a price');
  ok(!r.text.includes('$24.99') && !/\$\d+\.\d{2}/.test(r.text),
    'offer page carries NO dollar figure while the price is unstruck');
  ok(r.text.includes('Active Tattoo Shop membership required'), 'offer page states eligibility');
  ok(r.text.includes('action="/contact"') && r.text.includes('Healed Wall add-on: '),
    'start path is the /contact inquiry prefilled with the desk marker');
  ok(!r.text.includes('/membership/subscribe'),
    'offer page has no checkout/buy fakery (no subscribe form — inquiry only)');

  // Shops membership page carries the add-on block next to the tier.
  r = await req('GET', '/membership/shops');
  ok(r.status === 200 && r.text.includes('Optional add-on: the Healed Wall'),
    'shops membership page carries the Healed Wall add-on block');
  ok(r.text.includes('href="/membership/healed-wall"'), 'shops page block links to the add-on page');
  ok(r.text.includes('Founding add-on rate — announced to member shops first'),
    'shops page block shows the founding-rate notice, not a figure');

  // Public shop landing carries the block too.
  r = await req('GET', '/shop');
  ok(r.status === 200 && r.text.includes('href="/membership/healed-wall"'),
    'shop landing carries the Healed Wall add-on block linking to the offer page');
}

module.exports = { runDbTests, runHttpTests };
