// One-time setup: create the 5 Dawnfold publication billing plans in
// PayPal (money hole: Dawnfold PayPal checkout parked at "being set
// up" until these plan IDs exist — see src/lib/thebigone.js).
//
// The plans are plain single-cycle plans at the REGISTER prices from
// src/config.js pricing.plans (the prices subscribers actually pay —
// base + the house fee pass-through, the same convention the shop and
// 6-month plans were created at). Prices are read from config, never
// typed twice.
//
// Run in the Render shell of the tattoo-art-customs service (the
// service's own PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET must be in
// env — the same live app the checkout uses, Business PayPal mk4):
//   node scripts/create-dawnfold-plans.js
// It creates ONE catalog product ("Dawnfold") unless
// PAYPAL_PRODUCT_DAWNFOLD is already set to an existing product ID,
// then the 5 plans under it, and prints the five env lines. Set those
// 5 variables in the Render environment of BOTH services
// (tattoo-art-customs AND the OneMind standalone service — the same
// plan IDs work for both, they live in the one mk4 PayPal account)
// and redeploy. Safe to re-run (creates fresh plans each time; use
// the latest printed IDs).
const config = require('../src/config');
const paypal = require('../src/lib/paypal');

const PLANS = [
  { key: 'the_big_one', env: 'PAYPAL_PLAN_THE_BIG_ONE', name: 'Dawnfold — Subscription', description: 'Dawnfold, every morning: every department, every day, the big Sunday edition. Monthly.' },
  { key: 'the_big_one_annual', env: 'PAYPAL_PLAN_THE_BIG_ONE_ANNUAL', name: 'Dawnfold — Subscription (Annual)', description: 'Dawnfold for a full year — every department, every day, every Sunday edition.' },
  { key: 'the_big_one_founding', env: 'PAYPAL_PLAN_THE_BIG_ONE_FOUNDING', name: 'Dawnfold — Founding Member', description: 'Founding Member rate, locked for as long as the subscription stays active. First 500 members only.' },
  { key: 'the_big_one_supporter', env: 'PAYPAL_PLAN_THE_BIG_ONE_SUPPORTER', name: 'Dawnfold — Supporter', description: 'Supporter tier: everything in the subscription, plus your name in the masthead supporter roll.' },
  { key: 'the_big_one_waiting_room', env: 'PAYPAL_PLAN_THE_BIG_ONE_WAITING_ROOM', name: 'Dawnfold — Waiting Room', description: 'Waiting Room edition for businesses: Dawnfold delivered for your waiting room, lobby, or shop counter.' },
];

(async () => {
  if (!config.paypalConfigured()) {
    console.error('PLAN_CREATE_FAILED: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set in this service env.');
    process.exit(1);
  }
  let productId = process.env.PAYPAL_PRODUCT_DAWNFOLD || '';
  if (!productId) {
    const product = await paypal.createCatalogProduct({
      name: 'Dawnfold',
      description: 'Dawnfold — the house publication: a daily finite edition with a big Sunday edition.',
    });
    productId = product.id;
    console.log('PRODUCT_CREATED=' + productId);
    console.log('(Optional: set PAYPAL_PRODUCT_DAWNFOLD=' + productId + ' to reuse this product on a re-run.)');
  } else {
    console.log('PRODUCT_REUSED=' + productId);
  }
  for (const p of PLANS) {
    const row = config.pricing.plans[p.key];
    if (!row) { console.error('PLAN_CREATE_FAILED: config.pricing.plans.' + p.key + ' missing'); process.exit(1); }
    const plan = await paypal.createSimpleBillingPlan({
      productId,
      name: p.name,
      description: p.description,
      regularCents: row.priceCents,
      intervalUnit: row.interval === 'year' ? 'YEAR' : 'MONTH',
      intervalCount: 1,
    });
    console.log(p.env + '=' + plan.id);
  }
  console.log('Set the 5 PAYPAL_PLAN_THE_BIG_ONE* variables above in the Render environment of BOTH services, then redeploy.');
})().catch((e) => { console.error('PLAN_CREATE_FAILED: ' + e.message); process.exit(1); });
