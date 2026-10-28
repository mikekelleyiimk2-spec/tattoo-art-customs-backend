// The Big One — the house publication's web money surfaces
// (owner order 2026-10-27, Lane A: web edition + money doors).
//
// ONE config place for the publication's prices: the subscription plan
// prices themselves live in config.pricing.plans (the register every
// plan reads — see src/config.js); everything publication-specific
// that is NOT a membership plan (sponsor rate card, classifieds /
// notices listing fees, feed licensing, the founding cap) lives here.
// Routes and views read from this module only — no price is ever
// typed twice.
//
// Checkout state, stated plainly (no invented payment path):
// - The five subscription products are real rows in the `plans` table
//   (seeded from config by seed.js and by ensurePlans() below), bought
//   through the existing membership machinery: POST
//   /membership/subscribe/:slug (PayPal) and /membership/credit/:slug
//   (site credit).
// - PayPal recurring checkout for these plans is PARKED until the
//   owner creates the plans in the PayPal dashboard (mk4) and the
//   PAYPAL_PLAN_THE_BIG_ONE* env vars land — the exact same parked
//   state the annual / 6-month / founding-shop plans shipped in.
//   paypalReadyFor() reports it per plan; the subscribe route refuses
//   with the house-standard "being set up" flash instead of failing.
// - The site-credit path needs no PayPal plan and works today, like
//   every other plan's credit path.
// - Classifieds / notices are one-time register products: the
//   submission lands in `orders` (order_type 'the_big_one_listing',
//   status 'pending_review') for desk review — nothing auto-publishes.
//   Payment follows the house manual-confirmation pattern used by
//   gift cards (PayPal mk4 link + admin confirmation); the desk does
//   not mark a listing paid until payment is confirmed by hand.
const db = require('../db');
const config = require('../config');
const pricing = require('./pricing');

// Business PayPal (mk4) tip jar — the house jar, same link the shared
// tip-jar partial carries (verified in views/partials/tip-jar.ejs).
const TIP_JAR_URL = 'https://www.paypal.com/ncp/payment/WA9DS6J8ERSHW';

// Founding Member cap: the $2.99/mo locked rate belongs to the first
// 500 founding subscriptions, counted on subscription rows (pending +
// active) so concurrent checkouts cannot oversell the cap.
const FOUNDING_CAP = 500;

const PLAN_SLUGS = [
  'the_big_one',
  'the_big_one_annual',
  'the_big_one_founding',
  'the_big_one_supporter',
  'the_big_one_waiting_room',
];

const PLAN_DESCRIPTIONS = {
  the_big_one: 'The Big One, every morning: every department, every day, the big Sunday edition, and the Library shelves behind the Documentary page. $4.99/month.',
  the_big_one_annual: 'The Big One for a full year — every department, every day, every Sunday edition. $39.99/year (two months free vs monthly).',
  the_big_one_founding: 'Founding Member rate: The Big One at $2.99/month, locked for as long as the subscription stays active. First 500 members only — when they are gone, this rate is gone.',
  the_big_one_supporter: 'Supporter tier: everything in the subscription, plus your name in the masthead supporter roll — the readers who keep the desk lit. $9.99/month.',
  the_big_one_waiting_room: 'Waiting Room edition for businesses: The Big One delivered for your waiting room, lobby, or shop counter — one business subscription, your customers read while they wait. $19.99/month.',
};

// One-time listing products (register prices INCLUDE the house fee
// pass-through, computed from the base with pricing.withFeeCents).
const LISTINGS = {
  classifieds: {
    kind: 'classifieds',
    name: 'Classifieds listing — 30 days',
    baseCents: 500, // $5.00
    days: 30,
  },
  notices: {
    kind: 'notices',
    name: 'Notices listing — 30 days',
    baseCents: 300, // $3.00
    days: 30,
  },
};
function listingPriceCents(kind) {
  const l = LISTINGS[kind];
  return l ? pricing.withFeeCents(l.baseCents) : null;
}

// Sponsor rate card (founding rates, owner order 2026-10-27). Base
// prices; the register price adds the house fee pass-through at
// display time (pricing.withFeeCents), same as the /advertise slots.
// Honest founding copy rule: the audience is growing and NO reach
// numbers are claimed anywhere on the sponsors page.
const SPONSORS = [
  {
    key: 'presented_by',
    name: 'Edition “Presented by” sponsorship',
    baseCents: 7500, // $75/mo
    per: 'month',
    blurb: 'Your name on the masthead line of every edition that month — “Today’s edition, presented by …” — the first sponsorship line a reader sees, on the page every finisher reads.',
  },
  {
    key: 'department',
    name: 'Department sponsorship',
    baseCents: 2500, // $25/mo
    per: 'month',
    blurb: 'One department carries your name for a month — “Money in Plain Words, presented by …” Pick the department your customers already read.',
  },
  {
    key: 'sponsored_puzzle',
    name: 'Sponsored puzzle contest',
    baseCents: 5000, // $50 per Sunday edition
    per: 'Sunday edition',
    blurb: 'Sponsor the big Sunday IN ORDER! — your name on the flagship puzzle, with a prize you provide for the week’s finishers.',
  },
  {
    key: 'waiting_room',
    name: 'Waiting Room subscription for shops',
    baseCents: 1999, // $19.99/mo — the the_big_one_waiting_room plan
    per: 'month',
    blurb: 'The business rate: The Big One in your waiting room, lobby, or shop, every morning. Bought as the Waiting Room plan at the register below.',
    planSlug: 'the_big_one_waiting_room',
  },
  {
    key: 'acadiana_bundle',
    name: 'Local edition (Acadiana) sponsorship bundle',
    baseCents: 9900, // $99/mo
    per: 'month',
    blurb: 'The hometown bundle: “Presented by” on the local weather and Acadiana lines, a department sponsorship, and a classifieds listing every month — one bundle for the businesses Abbeville already knows.',
  },
  {
    key: 'feed_license',
    name: 'Feed licensing — departments & IN ORDER! for your app or newsletter',
    baseCents: 4900, // $49/mo per feed
    per: 'month, per feed',
    blurb: 'License a department — or the daily IN ORDER! puzzle — as a feed for your own app, site, or newsletter. Priced per feed, plus the house toll on the flow across the plug (the Codex price law: the toll is on the flow, never a second charge on the door). Your readers finish something every day; the desk does the writing.',
  },
];

// Idempotent plan registration, mirroring src/db/seed.js: plans are
// upserted from config so a fresh deploy (or a DB where seed has not
// run since these plans were added) still carries the products in the
// register. Runs at most once per process; failures are logged, never
// fatal to a page render.
let plansEnsured = null;
function ensurePlans() {
  if (!plansEnsured) {
    plansEnsured = (async () => {
      for (const key of Object.keys(config.pricing.plans)) {
        const p = config.pricing.plans[key];
        if (!PLAN_SLUGS.includes(p.slug)) continue;
        const paypalPlanId = config.paypal.planIds[key] || '';
        const existing = await db.get('SELECT id FROM plans WHERE slug = ?', [p.slug]);
        if (existing) {
          await db.update('plans', existing.id, {
            name: p.name, price_cents: p.priceCents, interval: p.interval,
            paypal_plan_id: paypalPlanId, description: PLAN_DESCRIPTIONS[p.slug] || '',
          });
        } else {
          await db.insert('plans', {
            slug: p.slug, name: p.name, price_cents: p.priceCents,
            interval: p.interval, paypal_plan_id: paypalPlanId, active: 1,
            description: PLAN_DESCRIPTIONS[p.slug] || '',
          });
        }
      }
    })().catch((e) => {
      console.error('thebigone ensurePlans failed:', e.message);
      plansEnsured = null; // allow a later request to retry
    });
  }
  return plansEnsured;
}

async function getPlans() {
  await ensurePlans();
  const rows = await db.all(
    `SELECT * FROM plans WHERE slug IN (${PLAN_SLUGS.map(() => '?').join(',')}) AND active = 1`,
    PLAN_SLUGS);
  const bySlug = {};
  for (const r of rows) bySlug[r.slug] = r;
  return bySlug;
}

// Per-plan PayPal checkout readiness (parked until the dashboard plan
// ID lands — see the header note).
function paypalReadyFor(slug) {
  return config.paypalBigOnePlanConfigured(slug);
}
function anyPaypalReady() {
  return PLAN_SLUGS.some((s) => paypalReadyFor(s));
}

// Founding cap accounting: pending + active founding subscriptions
// hold spots (a pending checkout is a claim in flight, like the
// founding-shop pattern's counters).
async function foundingClaimed() {
  try {
    const row = await db.get(
      `SELECT COUNT(*) AS n FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE p.slug = 'the_big_one_founding' AND s.status IN ('pending','active')`);
    return row ? Number(row.n) || 0 : 0;
  } catch (e) {
    return 0;
  }
}
async function foundingSpotsLeft() {
  return Math.max(0, FOUNDING_CAP - (await foundingClaimed()));
}

// Founder recognition: the signed-in reader's own place in the
// Founding 500. A user's rank is the count of founding claims
// (pending + active, same set foundingClaimed() counts) whose
// created_at is at or before that user's EARLIEST founding
// subscription — so a reader who holds more than one founding row
// is ranked by the first claim they made, and tied timestamps rank
// together rather than arbitrarily. Returns null for anyone who is
// not a founder (and on any DB error: a recognition lookup must
// never break the page it decorates).
async function founderInfo(userId) {
  if (!userId) return null;
  try {
    const mine = await db.get(
      `SELECT MIN(s.created_at) AS first_at FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE p.slug = 'the_big_one_founding' AND s.status IN ('pending','active') AND s.user_id = ?`,
      [userId]);
    if (!mine || mine.first_at === null || mine.first_at === undefined) return null;
    const rank = await db.get(
      `SELECT COUNT(*) AS n FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE p.slug = 'the_big_one_founding' AND s.status IN ('pending','active') AND s.created_at <= ?`,
      [mine.first_at]);
    const ordinal = rank ? Number(rank.n) || 0 : 0;
    return ordinal > 0 ? { ordinal } : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  TIP_JAR_URL, FOUNDING_CAP, PLAN_SLUGS, PLAN_DESCRIPTIONS,
  LISTINGS, listingPriceCents, SPONSORS,
  ensurePlans, getPlans, paypalReadyFor, anyPaypalReady,
  foundingClaimed, foundingSpotsLeft, founderInfo,
};
