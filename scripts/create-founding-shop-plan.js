// One-time setup: create the founding tattoo-shop billing plan in PayPal.
//
// The founding offer ($83.28 first year, then $103.98/year) cannot be done
// as a subscription-creation override — PayPal rejects a 1-year TRIAL
// billing cycle there ("billing cycle sequence is not available"). The
// PayPal-native approach is a dedicated plan with the trial defined in it.
//
// Run in the Render shell:
//   node scripts/create-founding-shop-plan.js
// Then set the printed plan ID as PAYPAL_PLAN_FOUNDING_SHOP in the Render
// environment and redeploy. Safe to re-run (creates a new plan each time;
// use the latest printed ID).
const config = require('../src/config');
const paypal = require('../src/lib/paypal');

(async () => {
  const plan = await paypal.createBillingPlan({
    productId: 'PROD-7JD70974AU3483829',
    name: 'Tattoo Art Customs - Founding Tattoo Shop',
    description: 'Founding rate: $83.28 first year, then $103.98/year.',
    trialCents: config.pricing.foundingShop.priceCents,
    regularCents: config.pricing.plans.shop.priceCents,
  });
  console.log('PLAN_CREATED=' + plan.id);
  console.log('Set PAYPAL_PLAN_FOUNDING_SHOP=' + plan.id + ' in the Render environment.');
})().catch((e) => { console.error('PLAN_CREATE_FAILED: ' + e.message); process.exit(1); });
