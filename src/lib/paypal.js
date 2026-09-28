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
  const res = await fetch(`${config.paypalBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal token request failed: ${res.status}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

async function api(path, method = 'GET', body = null) {
  const token = await getAccessToken();
  const res = await fetch(`${config.paypalBaseUrl()}${path}`, {
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
  assertConfigured();
  return api(`/v2/checkout/orders/${paypalOrderId}/capture`, 'POST', {});
}

// --- Subscriptions (memberships) ---
async function createSubscription({ planKey, returnUrl, cancelUrl }) {
  assertConfigured();
  assertPlansConfigured();
  const planId = config.paypal.planIds[planKey];
  if (!planId) throw new PayPalNotConfigured(`no plan ID for "${planKey}"`);
  return api('/v1/billing/subscriptions', 'POST', {
    plan_id: planId,
    application_context: {
      return_url: returnUrl, cancel_url: cancelUrl,
      brand_name: 'Tattoo Art Customs',
    },
  });
}

async function getSubscription(paypalSubscriptionId) {
  assertConfigured();
  return api(`/v1/billing/subscriptions/${paypalSubscriptionId}`);
}

async function cancelSubscription(paypalSubscriptionId, reason = 'Canceled by member') {
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

module.exports = {
  PayPalNotConfigured,
  assertConfigured,
  createCheckoutOrder,
  captureCheckoutOrder,
  createSubscription,
  getSubscription,
  cancelSubscription,
  verifyWebhookSignature,
  createPayoutBatch,
};
