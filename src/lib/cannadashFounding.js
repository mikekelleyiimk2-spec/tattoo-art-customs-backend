// CannaDash — founding dispensary partner fee structure (config only).
//
// BUILD: Bundle C Build 1, 2026-10-28. The dispensary email campaign
// already running promised a founding rate LOCKED with NO dollar
// figure quoted. This module is the rate sheet behind that promise —
// it is NOT a public price list yet.
//
// OWNER-STRIKE GATE (the whole point of this file):
//   pricesLive is false and status is 'PENDING OWNER STRIKE'.
//   While pricesLive is false, NO assessed dollar figure from this
//   file may render on any public page. Public surfaces render the
//   structure (what is charged, and how) plus WITHHELD_LABEL in every
//   price cell. The owner strikes the founding price in the approval
//   batch; only then does pricesLive flip to true — in this file, in
//   one place — and the assessed figures below start rendering.
//
// ASSESSED FIGURES — justification from the spec
// (~/workspace/your_files/cannadash-spec-2026-10-26.md):
//   §3 already assessed this stack, and this config aligns to it
//   rather than inventing a second set of numbers:
//   - Dispensary platform subscription, per location: $99/mo standard,
//     with a launch/founding rate of $49/mo for the first 12 months.
//     So the Founding Partner tier below is assessedMonthly 49, locked
//     12 months; the Standard Partner tier it locks AGAINST is 99.
//   - Per-order toll: 15% of order subtotal (§3) — inside DoorDash's
//     15–30% restaurant-commission band (§3 benchmarks), at its floor.
//   - X Rule check (§3): a dispensary buys a delivery fleet it does
//     not have to hire, insure, or schedule, for less than a single
//     part-time driver's weekly wage. $49/mo founding clears that bar
//     with room; a $0-monthly + per-order-only model was considered
//     and NOT chosen because §3 already assessed the subscription +
//     toll stack and §11 records those assessed numbers as standing
//     unless the owner strikes them.
//   - Drafting (§3 note, §12b): money flows to the retailer, never
//     through CannaDash. The subscription and the toll are billed to
//     the retailer separately as B2B software / dispatch fees, never
//     drafted as a share of cannabis sales.
//   - Cohort cap: 30 partner locations. §7 counts Louisiana's whole
//     licensed footprint at 10 permit holders / ~30 locations — a
//     first cohort the Gear A (retailer-staff dispatch, §5) launch
//     can actually support, market by market, counsel-cleared first.
//
// Nothing here takes a payment, opens a market, or onboards a real
// dispensary. The gate to live in spec §10 still stands: counsel
// clears the market in writing AND a licensed partner signs.

const STATUS = 'PENDING OWNER STRIKE';
const pricesLive = false;

// The exact sentence every public price cell carries while the owner
// strike is pending. It keeps the campaign's promise (a founding rate
// locked at joining, no figure quoted) intact on the founding page.
const WITHHELD_LABEL =
  'Founding rate locked at joining — rate sheet goes to founding partners first';

const LOCK_PROMISE =
  'Your founding rate is locked at joining for your first 12 months — ' +
  'the rate you join at is the rate you keep for the full lock period, ' +
  'even when standard partner rates move.';

const TIERS = Object.freeze([
  Object.freeze({
    id: 'founding-partner',
    name: 'Founding Partner',
    cohort: 'first cohort',
    // Assessed per spec §3: founding rate, first 12 months, per location.
    assessedMonthly: 49,
    assessedMonthlyCents: 4900,
    assessedPerOrderPercent: 15,
    billing: 'per location, billed to the retailer as a B2B software fee',
    lockMonths: 12,
    lockPromise: LOCK_PROMISE,
    cohortCapLocations: 30,
    includes: Object.freeze([
      'Listing on the CannaDash platform at launch, in your licensed market',
      'Founding Partner badge on your listing',
      'Locked per-order economics for the full lock period (see the fee table)',
      'The dispensary order board: accept, pack, seal, hand to driver',
      'Delivery dispatch under the retailer-staff model (Gear A, spec §5)',
      'Chain-of-custody records: seal numbers, timestamps, ID attestations',
      'The rate sheet first: founding partners see final rates before anyone else',
    ]),
  }),
  Object.freeze({
    id: 'standard-partner',
    name: 'Standard Partner',
    cohort: 'after the founding cohort',
    // Assessed per spec §3: the standard rate the founding rate locks against.
    assessedMonthly: 99,
    assessedMonthlyCents: 9900,
    assessedPerOrderPercent: 15,
    billing: 'per location, billed to the retailer as a B2B software fee',
    lockMonths: 0,
    lockPromise: null,
    cohortCapLocations: null,
    includes: Object.freeze([
      'Listing on the CannaDash platform, in your licensed market',
      'The dispensary order board: accept, pack, seal, hand to driver',
      'Delivery dispatch under the retailer-staff model (Gear A, spec §5)',
      'Chain-of-custody records: seal numbers, timestamps, ID attestations',
    ]),
  }),
]);

// The fee table's structure — what is charged and how it works. The
// price cell is NEVER part of this data; it is computed by
// publicFeeRows() under the pricesLive gate, so a caller cannot
// accidentally render an assessed figure while the strike is pending.
const FEE_ROWS = Object.freeze([
  Object.freeze({
    key: 'platform_subscription',
    charge: 'Platform subscription',
    tierId: 'founding-partner',
    howItWorks: 'Per dispensary location, per month. Billed to the retailer ' +
      'as a B2B software fee — the customer never pays this, and it is ' +
      'never taken out of a cannabis sale.',
  }),
  Object.freeze({
    key: 'per_order_toll',
    charge: 'Per-order toll',
    tierId: 'founding-partner',
    howItWorks: 'A percentage of the order subtotal, per delivered order, ' +
      'billed to the retailer separately as a fee for software and ' +
      'dispatch services (spec §3 drafting note).',
  }),
  Object.freeze({
    key: 'standard_subscription_reference',
    charge: 'Standard partner subscription (what founding locks against)',
    tierId: 'standard-partner',
    howItWorks: 'Per dispensary location, per month, for partners who join ' +
      'after the founding cohort. Shown here so founding partners can see ' +
      'exactly what their lock protects them from.',
  }),
]);

function tier(id) {
  return TIERS.find((t) => t.id === id) || null;
}

function foundingTier() {
  return tier('founding-partner');
}

// Internal-only formatting for an assessed monthly figure. Callers on
// public surfaces must go through publicFeeRows(), which withholds it.
function formatAssessedMonthly(t) {
  return `$${t.assessedMonthly}/mo per location`;
}

// Rows safe to render on a public page. While pricesLive is false,
// every price cell is WITHHELD_LABEL and no assessed figure (monthly
// or per-order percent) appears anywhere in the returned rows. When
// the owner strikes the price and pricesLive flips true, the cells
// carry the assessed terms from the tier each row belongs to.
function publicFeeRows() {
  return FEE_ROWS.map((row) => {
    const t = tier(row.tierId);
    let priceCell = WITHHELD_LABEL;
    if (pricesLive && t) {
      priceCell = row.key === 'per_order_toll'
        ? `${t.assessedPerOrderPercent}% of order subtotal`
        : formatAssessedMonthly(t);
    }
    return {
      key: row.key,
      charge: row.charge,
      howItWorks: row.howItWorks,
      priceCell,
    };
  });
}

// What a public page may say about the founding tier: structure,
// includes, lock term, and cap — never a dollar figure while the
// strike is pending.
function publicFoundingOffer() {
  const t = foundingTier();
  return {
    name: t.name,
    cohort: t.cohort,
    includes: [...t.includes],
    lockMonths: t.lockMonths,
    lockPromise: t.lockPromise,
    cohortCapLocations: t.cohortCapLocations,
    pricesLive,
    status: STATUS,
    withheldLabel: WITHHELD_LABEL,
  };
}

module.exports = {
  STATUS,
  status: STATUS,
  pricesLive,
  PRICES_LIVE: pricesLive,
  WITHHELD_LABEL,
  LOCK_PROMISE,
  TIERS,
  tiers: TIERS,
  FEE_ROWS,
  tier,
  foundingTier,
  publicFeeRows,
  publicFoundingOffer,
  // Internal assessed-terms access (reports / admin / tests only —
  // never render the result on a public page while pricesLive is false).
  formatAssessedMonthly,
};
