// Klarna Payments API client (Buy Now Pay Later).
// Requires merchant account at https://www.klarna.com/us/business/
// Credentials: KLARNA_USERNAME, KLARNA_PASSWORD, KLARNA_REGION (us/eu)
// Docs: https://docs.klarna.com/
const config = require('../config');

class KlarnaNotConfigured extends Error {
  constructor(what) {
    super(`Klarna is not configured yet (${what}). Sign up at klarna.com/us/business/ and set KLARNA_USERNAME, KLARNA_PASSWORD.`);
    this.name = 'KlarnaNotConfigured';
  }
}

function assertConfigured() {
  const k = config.klarna || {};
  if (!k.username || !k.password) throw new KlarnaNotConfigured('missing username/password');
}

function baseUrl() {
  const region = (config.klarna?.region || 'us').toLowerCase();
  // Klarna API endpoints: US playground/prod, EU playground/prod
  const urls = {
    'us': 'https://api.klarna.com',
    'us-test': 'https://api.playground.klarna.com',
    'eu': 'https://api.klarna.com',
    'eu-test': 'https://api.playground.klarna.com',
  };
  const isTest = (process.env.KLARNA_MODE || 'live').toLowerCase() !== 'live';
  return urls[region + (isTest ? '-test' : '')] || urls['us'];
}

async function api(path, method = 'GET', body = null) {
  assertConfigured();
  const creds = Buffer.from(`${config.klarna.username}:${config.klarna.password}`).toString('base64');
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Klarna API ${method} ${path} failed: ${data.error_message || data.message || res.status}`);
  }
  return data;
}

// Create a Klarna session for checkout
// Returns { session_id, client_token }
async function createSession({ amountCents, currency = 'USD', description, orderId }) {
  return api('/payments/v1/sessions', 'POST', {
    intent: 'buy',
    purchase_country: 'US',
    purchase_currency: currency,
    locale: 'en-US',
    order_amount: amountCents,
    order_tax_amount: 0,
    order_lines: [{
      type: 'physical',
      name: description.slice(0, 255),
      quantity: 1,
      unit_price: amountCents,
      tax_rate: 0,
      total_amount: amountCents,
      total_tax_amount: 0,
    }],
    merchant_reference1: orderId || '',
  });
}

// Place order after customer authorization
async function createOrder({ authorizationToken, amountCents, currency = 'USD', description, orderId, customerEmail }) {
  return api(`/payments/v1/authorizations/${authorizationToken}/order`, 'POST', {
    purchase_country: 'US',
    purchase_currency: currency,
    locale: 'en-US',
    order_amount: amountCents,
    order_tax_amount: 0,
    order_lines: [{
      type: 'physical',
      name: description.slice(0, 255),
      quantity: 1,
      unit_price: amountCents,
      tax_rate: 0,
      total_amount: amountCents,
      total_tax_amount: 0,
    }],
    merchant_reference1: orderId || '',
    ...(customerEmail ? { customer: { email: customerEmail } } : {}),
  });
}

function isConfigured() {
  const k = config.klarna || {};
  return !!(k.username && k.password);
}

module.exports = {
  KlarnaNotConfigured,
  isConfigured,
  createSession,
  createOrder,
};
