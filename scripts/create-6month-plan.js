// One-time setup: create the Pro-perk 6-month customer billing plan in PayPal.
//
// The 6-month plan ($26.37 every 6 months, MONTH x 6 — 6 months for the price
// of 5, first month free with a Pro app purchase) is a dedicated PayPal plan,
// the same pattern as the founding-shop plan. PayPal natively supports
// multi-month interval counts, so no trial-cycle override is needed.
//
// Run in the Render shell (PayPal API credentials must be in env):
//   node scripts/create-6month-plan.js
// Then set the printed plan ID as PAYPAL_PLAN_CUSTOMER_6MONTH in the Render
// environment and redeploy. Safe to re-run (creates a new plan each time;
// use the latest printed ID).
const config = require('../src/config');
const paypal = require('../src/lib/paypal');

(async () => {
  const plan = await paypal.createSixMonthBillingPlan({
    productId: 'PROD-7JD70974AU3483829',
    name: 'Tattoo Art Customs - Customer (6-Month, Pro Perk)',
    description: 'Customer membership, $26.37 every 6 months. Pro-app owners only.',
    regularCents: config.pricing.plans.customer_6month.priceCents,
  });
  console.log('PLAN_CREATED=' + plan.id);
  console.log('Set PAYPAL_PLAN_CUSTOMER_6MONTH=' + plan.id + ' in the Render environment.');
})().catch((e) => { console.error('PLAN_CREATE_FAILED: ' + e.message); process.exit(1); });
