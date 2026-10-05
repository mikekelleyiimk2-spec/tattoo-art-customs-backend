// PayPal REST API client (Checkout + Subscriptions).
// All calls are config-gated: if the owner has not pasted credentials yet,
// functions throw a clear PayPalNotConfigured error instead of failing
// cryptically. See SETUP.md for exactly what to paste and where.
const config = require('../config');

class PayPalNotConfigured extends Error {
  constructor(what) {
    super(`PayPal is not configured yet (${what}). See SETUP.md — paste PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.`);
    this.name = 'PayPalNotConfigured';
  }
}

function assertConfigured() {
  if (!config.paypalConfigured()) throw new PayPalNotConfigured('missing client ID/secret');
}

// Test-only stub state (see createSubscription). Subscription IDs ending in
// '-ACTIVE' read back as ACTIVE so tests can drive both branches of /approve
// through the real HTTP routes without cross-process patching.
let testStubSeq = 0;

function assertPlansConfigured() {
  if (!config.paypalPlansConfigured()) {
    throw new PayPalNotConfigured('missing subscription plan IDs — create the 3 plans in the PayPal dashboard and set PAYPAL_PLAN_CUSTOMER/_ARTIST/_SHOP');
  }
}

let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  assertConfigured();
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
  const creds = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const res = await fetchWithTimeout(`${config.paypalBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal token request failed: ${res.status}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

// fetch with a hard timeout: a hung PayPal must never hang a request
// forever (stalled checkouts during an outage invite double-clicks and
// retries, which cause duplicate charges and duplicate rows downstream).
const PAYPAL_TIMEOUT_MS = 25000;
async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PAYPAL_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`PayPal request timed out after ${PAYPAL_TIMEOUT_MS / 1000}s: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Idempotent-capture support. PayPal rejects a second capture of the same
// order ("ORDER_ALREADY_CAPTURED"). That error means the money ALREADY moved:
// a crash between a successful capture and our local bookkeeping must be
// recovered, never re-charged or lost.
function isAlreadyCapturedError(e) {
  return /already.?captured/i.test(String((e && e.message) || ''));
}

async function api(path, method = 'GET', body = null) {
  const token = await getAccessToken();
  const res = await fetchWithTimeout(`${config.paypalBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.details?.map((d) => d.description).join('; ') || data.message || res.status;
    throw new Error(`PayPal API ${method} ${path} failed: ${detail}`);
  }
  return data;
}

// --- Checkout (one-time payments: premade designs, custom deposits) ---
async function createCheckoutOrder({ amountCents, description, returnUrl, cancelUrl }) {
  assertConfigured();
  return api('/v2/checkout/orders', 'POST', {
    intent: 'CAPTURE',
    purchase_units: [{
      description: description.slice(0, 120),
      amount: { currency_code: 'USD', value: (amountCents / 100).toFixed(2) },
    }],
    application_context: { return_url: returnUrl, cancel_url: cancelUrl },
  });
}

async function captureCheckoutOrder(paypalOrderId) {
  // Test-only stub (TAC_TEST_PAYPAL_STUB=1, never active in production):
  // the automated suite runs the server in a separate process, so it cannot
  // monkey-patch this module. Returns a canned COMPLETED capture so the
  // booking capture routes can be exercised over HTTP without network access.
  // (createCheckoutOrder keeps its real behavior — the orders buy flow
  // depends on it throwing when PayPal is unconfigured.)
  if (process.env.TAC_TEST_PAYPAL_STUB === '1') {
    testStubSeq += 1;
    const capId = `C-STUB-${testStubSeq}`;
    return {
      id: paypalOrderId, status: 'COMPLETED',
      purchase_units: [{ payments: { captures: [{ id: capId, status: 'COMPLETED', amount: { currency_code: 'USD', value: '0.00' } }] } }],
    };
  }
  assertConfigured();
  return api(`/v2/checkout/orders/${paypalOrderId}/capture`, 'POST', {});
}

// Read a checkout order (status + captures). Used to recover the capture id
// after an ORDER_ALREADY_CAPTURED error: the money moved on a previous
// attempt that crashed before we recorded it.
async function getCheckoutOrder(paypalOrderId) {
  assertConfigured();
  return api(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, 'GET');
}

// Refund a captured checkout payment (partial or full). Used by booking
// cancellations inside the free-cancel window: the shop's `base` is refunded,
// the 5% platform fee is never refunded.
async function refundCheckoutCapture(paypalCaptureId, amountCents) {
  if (process.env.TAC_TEST_PAYPAL_STUB === '1') {
    testStubSeq += 1;
    return { id: `R-STUB-${testStubSeq}`, status: 'COMPLETED' };
  }
  assertConfigured();
  const body = Number.isInteger(amountCents) && amountCents > 0
    ? { amount: { currency_code: 'USD', value: (amountCents / 100).toFixed(2) } }
    : {};
  return api(`/v2/payments/captures/${paypalCaptureId}/refund`, 'POST', body);
}

// --- Subscriptions (memberships) ---
// billingCycles: optional PayPal billing_cycles override for the first
// subscription (e.g. a $1 trial month or a founding-shop first year at
// $79.99). Use the builders below so the shapes stay valid.
async function createSubscription({ planKey, returnUrl, cancelUrl, billingCycles = null }) {
  // Test-only stub (never active in production): the automated suite runs the
  // server in a separate process, so it cannot monkey-patch this module.
  // Set TAC_TEST_PAYPAL_STUB=1 in the test runner env to get canned answers.
  if (process.env.TAC_TEST_PAYPAL_STUB === '1') {
    testStubSeq += 1;
    return { id: `I-STUB-${testStubSeq}`, links: [{ rel: 'approve', href: 'https://paypal.test/approve/stub' }] };
  }
  assertConfigured();
  assertPlansConfigured();
  const planId = config.paypal.planIds[planKey];
  if (!planId) throw new PayPalNotConfigured(`no plan ID for "${planKey}"`);
  const body = {
    plan_id: planId,
    application_context: {
      return_url: returnUrl, cancel_url: cancelUrl,
      brand_name: 'Tattoo Art Customs',
    },
  };
  if (billingCycles) body.plan = { billing_cycles: billingCycles };
  return api('/v1/billing/subscriptions', 'POST', body);
}

function fixedPrice(cents) {
  return { currency_code: 'USD', value: (cents / 100).toFixed(2) };
}

// $1 first month (trial), then the regular monthly price forever.
function firstMonthTrialCycles(regularCents) {
  return [
    {
      sequence: 1, tenure_type: 'TRIAL', total_cycles: 1,
      frequency: { interval_unit: 'MONTH', interval_count: 1 },
      pricing_scheme: { fixed_price: fixedPrice(config.pricing.firstMonth.priceCents) },
    },
    {
      sequence: 2, tenure_type: 'REGULAR', total_cycles: 0,
      frequency: { interval_unit: 'MONTH', interval_count: 1 },
      pricing_scheme: { fixed_price: fixedPrice(regularCents) },
    },
  ];
}

// Founding tattoo shop: $83.28 for the first year, then $103.98/year after.
// The discounted first year MUST be tenure_type TRIAL: PayPal rejects an
// override whose sequence doesn't map onto the plan's own cycles, and the
// shop plan defines a single REGULAR yearly cycle. A TRIAL cycle prepended
// at sequence 1 (the same shape as the $1.53 first-month trial, which PayPal
// accepts) is the supported way to discount the first period.
function foundingShopCycles() {
  return [
    {
      sequence: 1, tenure_type: 'TRIAL', total_cycles: 1,
      frequency: { interval_unit: 'YEAR', interval_count: 1 },
      pricing_scheme: { fixed_price: fixedPrice(config.pricing.foundingShop.priceCents) },
    },
    {
      sequence: 2, tenure_type: 'REGULAR', total_cycles: 0,
      frequency: { interval_unit: 'YEAR', interval_count: 1 },
      pricing_scheme: { fixed_price: fixedPrice(config.pricing.plans.shop.priceCents) },
    },
  ];
}

// Pure payload builder for the founding-shop billing plan (exported for tests).
function foundingShopPlanPayload({ productId, name, description, trialCents, regularCents, intervalUnit = 'YEAR', intervalCount = 1 }) {
  const price = (cents) => ({ currency_code: 'USD', value: (cents / 100).toFixed(2) });
  return {
    product_id: productId,
    name: String(name).slice(0, 127),
    description: String(description).slice(0, 127),
    status: 'ACTIVE',
    billing_cycles: [
      {
        frequency: { interval_unit: intervalUnit, interval_count: intervalCount },
        tenure_type: 'TRIAL', sequence: 1, total_cycles: 1,
        pricing_scheme: { fixed_price: price(trialCents) },
      },
      {
        frequency: { interval_unit: intervalUnit, interval_count: intervalCount },
        tenure_type: 'REGULAR', sequence: 2, total_cycles: 0,
        pricing_scheme: { fixed_price: price(regularCents) },
      },
    ],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
  };
}

// Create a billing plan with a trial first period (used once, from the
// shell, for the founding-shop plan — PayPal rejects a 1-year TRIAL cycle
// when overridden at subscription creation, so the discount lives in the
// plan itself, which is the PayPal-native way to do trial pricing).
// Pure payload builder for the Pro-perk 6-month customer plan (exported
// for tests + scripts/create-6month-plan.js). A single REGULAR cycle at
// $26.37 every 6 months (MONTH x 6) — PayPal natively supports multi-month
// interval counts, so no trial-cycle hack is needed. Auto-renews forever;
// the "first month free" framing is marketing for the price ($25 base vs
// $30), not a billing-cycle discount.
function sixMonthPlanPayload({ productId, name, description, regularCents }) {
  const price = (cents) => ({ currency_code: 'USD', value: (cents / 100).toFixed(2) });
  return {
    product_id: productId,
    name: String(name).slice(0, 127),
    description: String(description).slice(0, 127),
    status: 'ACTIVE',
    billing_cycles: [
      {
        frequency: { interval_unit: 'MONTH', interval_count: 6 },
        tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
        pricing_scheme: { fixed_price: price(regularCents) },
      },
    ],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
  };
}

// Create the 6-month billing plan in PayPal (run once from the shell via
// scripts/create-6month-plan.js). Unlike the founding-shop plan, no trial
// cycle is needed — the discount is baked into the $26.37/6mo price itself.
async function createSixMonthBillingPlan(args) {
  assertConfigured();
  return api('/v1/billing/plans', 'POST', sixMonthPlanPayload(args));
}

async function createBillingPlan(args) {
  assertConfigured();
  return api('/v1/billing/plans', 'POST', foundingShopPlanPayload(args));
}

async function suspendSubscription(paypalSubscriptionId, reason = 'Referral reward: free month') {
  assertConfigured();
  return api(`/v1/billing/subscriptions/${paypalSubscriptionId}/suspend`, 'POST', { reason });
}

async function activateSubscription(paypalSubscriptionId, reason = 'Referral free month ended') {
  assertConfigured();
  return api(`/v1/billing/subscriptions/${paypalSubscriptionId}/activate`, 'POST', { reason });
}

async function getSubscription(paypalSubscriptionId) {
  if (process.env.TAC_TEST_PAYPAL_STUB === '1') {
    const active = String(paypalSubscriptionId || '').endsWith('-ACTIVE');
    return {
      id: paypalSubscriptionId,
      status: active ? 'ACTIVE' : 'APPROVAL_PENDING',
      links: [{ rel: 'approve', href: 'https://paypal.test/approve/stub' }],
    };
  }
  assertConfigured();
  return api(`/v1/billing/subscriptions/${paypalSubscriptionId}`);
}

async function cancelSubscription(paypalSubscriptionId, reason = 'Canceled by member') {
  if (process.env.TAC_TEST_PAYPAL_STUB === '1') return { ok: true };
  assertConfigured();
  return api(`/v1/billing/subscriptions/${paypalSubscriptionId}/cancel`, 'POST', { reason });
}

// Verify a webhook signature using PayPal's verify endpoint.
async function verifyWebhookSignature({ transmissionId, timestamp, webhookId, eventBody, certUrl, authAlgo, transmissionSig }) {
  assertConfigured();
  const data = await api('/v1/notifications/verify-webhook-signature', 'POST', {
    transmission_id: transmissionId,
    transmission_time: timestamp,
    cert_url: certUrl,
    auth_algo: authAlgo,
    transmission_sig: transmissionSig,
    webhook_id: webhookId,
    webhook_event: eventBody,
  });
  return data.verification_status === 'SUCCESS';
}

// --- Payouts (weekly automated commission payouts) ---
// Sends a batch of PayPal payouts (one item per recipient). Requires the
// Payouts feature enabled on the PayPal business account — PayPal approves
// this separately; without it the API returns an error and callers keep
// the ledger rows as payable for manual processing.
async function createPayoutBatch({ items, note }) {
  assertConfigured();
  if (!items.length) throw new Error('No payout items.');
  const batchId = `tac-weekly-${Date.now()}`;
  return api('/v1/payments/payouts', 'POST', {
    sender_batch_header: {
      sender_batch_id: batchId,
      email_subject: 'Your Tattoo Art Customs payout is on its way',
      email_message: note || 'Commission payout from Tattoo Art Customs. Thank you!',
    },
    items: items.map((it, i) => ({
      recipient_type: 'EMAIL',
      amount: { value: (it.amountCents / 100).toFixed(2), currency: 'USD' },
      receiver: it.recipientEmail,
      note: it.note || 'Tattoo Art Customs commission payout',
      sender_item_id: `${batchId}-item-${i}`,
    })),
  });
}

// Sum COMPLETED captures across all purchase units, in cents. A capture
// response can legally contain several units / partial captures; only the
// first capture was being read, which understated multi-capture payments.
function capturedCents(capture) {
  let total = 0;
  for (const pu of (capture && capture.purchase_units) || []) {
    for (const c of ((pu.payments && pu.payments.captures) || [])) {
      if (c.status === 'COMPLETED') {
        total += Math.round(parseFloat((c.amount && c.amount.value) || '0') * 100);
      }
    }
  }
  return total;
}

// Throw unless the captured amount EXACTLY equals what was due. Never mark
// an order paid on a short (or over) capture — a mismatch means the money
// that moved is not the money we charged for, so the order stays unpaid and
// the discrepancy gets logged instead of silently booked.
// The automated-test stub (TAC_TEST_PAYPAL_STUB=1, never active in
// production) reports 0.00 captures; there the check is skipped and the
// expected amount is returned so the buy flows stay exercisable.
function assertCaptureAmount(capture, expectedCents) {
  if (process.env.TAC_TEST_PAYPAL_STUB === '1') return expectedCents;
  const paid = capturedCents(capture);
  if (paid !== expectedCents) {
    const money = (c) => `$${(c / 100).toFixed(2)}`;
    throw new Error(
      `Captured ${money(paid)} did not match the ${money(expectedCents)} due — ` +
      'order left unpaid for manual review.');
  }
  return paid;
}

module.exports = {
  PayPalNotConfigured,
  assertConfigured,
  createCheckoutOrder,
  captureCheckoutOrder,
  capturedCents,
  assertCaptureAmount,
  getCheckoutOrder,
  isAlreadyCapturedError,
  refundCheckoutCapture,
  createSubscription,
  createBillingPlan,
  createSixMonthBillingPlan,
  foundingShopPlanPayload,
  sixMonthPlanPayload,
  firstMonthTrialCycles,
  foundingShopCycles,
  getSubscription,
  cancelSubscription,
  suspendSubscription,
  activateSubscription,
  verifyWebhookSignature,
  createPayoutBatch,
};
