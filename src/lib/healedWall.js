// Healed Wall — paid ADD-ON for Tattoo Shop members
// (Bundle C Build 3, owner-approved build order 2026-10-28).
//
// What it is: a member shop's healed-work wall on its Tattoo Art Customs
// storefront (/store/<shop id>, src/shop/routes-storefront.js). The shop
// toolkit already runs an aftercare autopilot (src/shop/aftercare.js:
// day-3/7/14 check-ins with a one-tap healed-photo upload, photos held in
// the shop's toolkit queue). The Healed Wall is the public face of that
// pipeline: moderated healed-client photos + the house aftercare content
// pack, carried on the shop's own storefront under the shop's name.
//
// Base tier it rides on: the Tattoo Shop membership, $103.98/year
// (settled tier, owner rule 2026-09-29 — the shop plan INCLUDES the full
// Design Artist membership). The Healed Wall is NOT part of that tier:
// it is optional, separately priced, and never bundled silently.
//
// PRICE — OWNER-STRUCK 2026-10-30 (was: assessed, pending strike):
//   Add-on price: $24.99/year (2499 cents, yearly — matching
//   the base shop plan's yearly cycle so a shop sees one renewal date).
//   Assessed justification (2026-10-28): roughly a quarter of the
//   $103.98 base — priced as a visibility extra, not a second
//   membership. It covers the real cost driver, human moderation of
//   healed photos before anything posts publicly, without approaching
//   the base tier's price. ONE number, yearly only (no monthly
//   variant — shops already think in the yearly shop-plan cycle).
//   The owner struck this price on 2026-10-30 at the assessed figure
//   exactly ("Your picks — set all three"), so pricesLive is true
//   and public surfaces show the figure through pricePresentation().
//   (While it was unstruck, pricePresentation() returned a null
//   amount plus PRICE_PENDING_LABEL, so no view could print the
//   assessed figure by accident — that gate is why every surface
//   reads its price from this module only.)
//
// PAYMENT STATE — honest, no fakery:
//   There is no Healed Wall checkout today: no plans-table row, no
//   PayPal plan, no buy button. The start path is an inquiry through
//   the house contact desk (POST /contact, topic 'shop', message marker
//   CONTACT_MARKER) — the same admin-notification machinery every other
//   desk request rides. Fulfillment follows FULFILLMENT_CHECKLIST
//   below, starting with payment confirmed through that desk pattern
//   (the pattern in place when the owner struck the price).
//   Nothing in this module charges, bills, or implies a charge.
//
// STOREFRONT FLAG — no schema yet, on purpose:
//   A real per-shop on/off flag needs a column (e.g.
//   shop_storefront_settings.healed_wall_enabled) — a migration this
//   build deliberately does NOT add. Until fulfillment wires that flag,
//   storefrontEnabled() is driven by DEMO_ENABLED (default false) or by
//   an explicit flag object a future route passes in. The storefront
//   view renders the wall ONLY when handed an enabled flag, so every
//   shop without the add-on sees a byte-identical storefront.

const KEY = 'healed_wall';
const NAME = 'Healed Wall';

// The settled base tier this add-on attaches to (config.pricing / plans
// table own the live row; this is the documented reference figure).
const BASE_PLAN_SLUG = 'tattoo_shop';
const BASE_PLAN_PRICE_CENTS = 10398; // $103.98/year, includes Design Artist

// The struck price (see header): assessed 2026-10-28, struck
// as-is by the owner 2026-10-30. Surface amountCents on public
// pages ONLY through pricePresentation(), which gates on
// pricesLive.
const ASSESSED_PRICE = {
  amountCents: 2499, // $24.99
  interval: 'year',
  label: '$24.99/year',
};
const pricesLive = true;
const PRICE_STATUS = 'owner_struck_live';
const PRICE_PENDING_LABEL = 'Founding add-on rate — announced to member shops first';

// What a shop gets. Grounded in what exists today: the storefront
// (src/views/shop/storefront.ejs), the house aftercare content
// (/aftercare product picks + /guides/aftercare, carried under the
// shop's name), and the toolkit aftercare check-in flow
// (src/shop/aftercare.js) that already collects healed photos.
const INCLUDES = [
  {
    key: 'wall_section',
    title: 'A healed-work wall on your storefront',
    detail: 'A dedicated healed-work section on your Tattoo Art Customs storefront, under your shop\u2019s name — finished, healed results next to the flash and designs you sell, which is what turns browsers into bookings.',
  },
  {
    key: 'aftercare_pack',
    title: 'The house aftercare content pack, under your name',
    detail: 'The house aftercare guide and aftercare product picks (the same content behind /guides/aftercare and /aftercare) carried on your storefront as your shop\u2019s aftercare page — clients get your shop\u2019s instructions where they already look, and the affiliate disclosure rides with it.',
  },
  {
    key: 'submission_flow',
    title: 'A healed-photo submission flow for your clients',
    detail: 'Rides the aftercare check-ins your shop toolkit already sends (day 3 / 7 / 14): clients answer the check-in and upload their healed photo on the one-tap page. Photos land in your toolkit queue first — nothing reaches the wall without passing moderation.',
  },
  {
    key: 'moderation',
    title: 'Moderation before anything posts',
    detail: 'Every healed photo is moderated before it appears on your public wall. Your wall shows healed work you are proud of — never an unreviewed upload.',
  },
];

// Eligibility: an ACTIVE Tattoo Shop subscription. The add-on never
// sells standalone and never outlives the base membership — if the shop
// subscription lapses, the wall comes down with the storefront.
const ELIGIBILITY = {
  requiresPlanSlug: BASE_PLAN_SLUG,
  rule: 'Active Tattoo Shop membership required — the Healed Wall is an add-on to the shop tier, never a standalone product.',
  lapsesWithBase: true,
};

function isEligible({ hasActiveShopSubscription } = {}) {
  return hasActiveShopSubscription === true;
}

// Fulfillment, in order. Honest states only: every step is a desk /
// manual step today (states say so). The price was struck
// 2026-10-30; step 1 runs through the house contact desk — there
// is no self-serve checkout for this add-on.
const FULFILLMENT_CHECKLIST = [
  {
    step: 1, key: 'payment_confirmed',
    label: 'Payment confirmed',
    detail: 'Payment confirmed via the house contact desk: the shop sends the /contact inquiry (marker below) and the desk confirms payment of the struck $24.99/year (PayPal, like everything in the house). No self-serve checkout exists for this add-on — nothing is charged from the page itself.',
    state: 'live_via_contact_desk',
  },
  {
    step: 2, key: 'wall_enabled',
    label: 'Wall enabled on the shop\u2019s storefront',
    detail: 'The per-shop flag is flipped so the storefront renders the healed-wall section. Needs the flag column (see header — no migration in this build); until it exists this step is the manual flip of the lib demo flag for the fulfilling shop.',
    state: 'manual_step',
  },
  {
    step: 3, key: 'aftercare_pack_attached',
    label: 'Aftercare pack attached',
    detail: 'The house aftercare content pack is attached to the shop\u2019s storefront under the shop\u2019s name, with the affiliate disclosure intact.',
    state: 'manual_step',
  },
  {
    step: 4, key: 'shop_notified',
    label: 'Shop notified',
    detail: 'The shop is told the wall is live, where it appears, and how client healed photos reach it (the aftercare check-in flow).',
    state: 'manual_step',
  },
  {
    step: 5, key: 'first_photos_moderated',
    label: 'First healed photos moderated',
    detail: 'The shop\u2019s first healed photos from the toolkit queue are moderated and posted — the wall never launches empty or unreviewed.',
    state: 'manual_step',
  },
];

// POST /contact message marker (topic 'shop'): the desk identifies a
// Healed Wall start request by this exact prefix, followed by the shop
// name: "Healed Wall add-on: <shop>".
const CONTACT_MARKER = 'Healed Wall add-on: ';
const CONTACT_TOPIC = 'shop';

// Demo flag: the ONLY switch that can light the storefront wall section
// until a real per-shop flag exists. Default OFF — flipping this in a
// fulfillment change is step 2 of the checklist, per shop, never a
// fleet-wide default.
const DEMO_ENABLED = false;

// pricePresentation(): the ONLY price shape views may render.
// While unstruck it carried no amount at all — the pending label
// was the whole price presentation. Since the owner's 2026-10-30
// strike (pricesLive true), amountCents/label are the real figures.
function pricePresentation() {
  if (!pricesLive) {
    return { pricesLive: false, status: PRICE_STATUS, label: PRICE_PENDING_LABEL, amountCents: null, interval: ASSESSED_PRICE.interval };
  }
  return { pricesLive: true, status: 'live', label: ASSESSED_PRICE.label, amountCents: ASSESSED_PRICE.amountCents, interval: ASSESSED_PRICE.interval };
}

// storefrontEnabled(flag): the storefront view renders the wall only
// when handed a truthy enabled flag. `flag` is the future per-shop
// value (routes-storefront passes healedWall.forStorefront(shop) once
// the flag column exists); today nothing passes one, and DEMO_ENABLED
// is false, so every storefront is unchanged.
function storefrontEnabled(flag) {
  return DEMO_ENABLED || flag === true;
}

// forStorefront(shop): the locals object the storefront route hands the
// view at fulfillment time. `photos` are moderated healed photos only
// ({ src, alt }) — the route fills them from the shop's toolkit queue
// (aftercare.getHealedPhotosForShop) after moderation.
function forStorefront(shop, { enabled, photos } = {}) {
  return {
    enabled: storefrontEnabled(enabled),
    shopName: (shop && (shop.display_name || shop.business_name)) || 'this shop',
    photos: Array.isArray(photos) ? photos : [],
    aftercareGuideUrl: '/guides/aftercare',
    aftercarePicksUrl: '/aftercare',
  };
}

module.exports = {
  KEY, NAME,
  BASE_PLAN_SLUG, BASE_PLAN_PRICE_CENTS,
  ASSESSED_PRICE, pricesLive, PRICE_STATUS, PRICE_PENDING_LABEL,
  INCLUDES, ELIGIBILITY, isEligible,
  FULFILLMENT_CHECKLIST,
  CONTACT_MARKER, CONTACT_TOPIC,
  DEMO_ENABLED, storefrontEnabled, forStorefront,
  pricePresentation,
};
