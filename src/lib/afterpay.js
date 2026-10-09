// Afterpay/Clearpay API client (Buy Now Pay Later).
// Requires merchant account at https://www.afterpay.com/
// Credentials: AFTERPAY_MERCHANT_ID, AFTERPAY_SECRET_KEY, AFTERPAY_REGION (us/au/nz/uk)
// Docs: https://developers.afterpay.com/
const config = require('../config');

class AfterpayNotConfigured extends Error {
  constructor(what) {
    super(`Afterpay is not configured yet (${what}). Sign up at afterpay.com and set AFTERPAY_MERCHANT_ID, AFTERPAY_SECRET_KEY.`);
    this.name = 'AfterpayNotConfigured';
  }
}

function assertConfigured() {
  const a = config.afterpay || {};
  if (!a.merchantId || !a.secretKey) throw new AfterpayNotConfigured('missing merchant ID/secret key');
}

function baseUrl() {
  const region = (config.afterpay?.region || 'us').toLowerCase();
  const isSandbox = (process.env.AFTERPAY_MODE || 'live').toLowerCase() !== 'live';
  const hosts = {
    'us': isSandbox ? 'https://api-sandbox.afterpay.com' : 'https://api.afterpay.com',
    'au': isSandbox ? 'https://api-sandbox.afterpay.com' : 'https://api.afterpay.com',
    'nz': isSandbox ? 'https://api-sandbox.afterpay.com' : 'https://api.afterpay.com',
    'uk': isSandbox ? 'https://api-sandbox.clearpay.co.uk' : 'https://api.clearpay.co.uk',
  };
  return (hosts[region] || hosts['us']) + '/v2';
}

async function api(path, method = 'GET', body = null) {
  assertConfigured();
  const creds = Buffer.from(`${config.afterpay.merchantId}:${config.afterpay.secretKey}`).toString('base64');
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
    throw new Error(`Afterpay API ${method} ${path} failed: ${data.message || data.errorCode || res.status}`);
  }
  return data;
}

// Create a checkout — returns { token, redirectUrl }
// Customer is redirected to Afterpay to complete payment
async function createCheckout({ amountCents, currency = 'USD', description, returnUrl, cancelUrl, customerEmail }) {
  const amount = (amountCents / 100).toFixed(2);
  return api('/checkouts', 'POST', {
    amount: { amount, currency },
    consumer: customerEmail ? { email: customerEmail } : undefined,
    merchant: { redirectConfirmUrl: returnUrl, redirectCancelUrl: cancelUrl },
    merchantReference: description.slice(0, 128),
    taxAmount: { amount: '0.00', currency },
    shippingAmount: { amount: '0.00', currency },
  });
}

// Capture payment after customer confirms
// Returns order details including payment state
async function capturePayment(token) {
  return api(`/payments/capture`, 'POST', { token });
}

// Get checkout details
async function getCheckout(token) {
  return api(`/checkouts/${token}`, 'GET');
}

// Refund a payment
async function refund({ orderId, amountCents, currency = 'USD' }) {
  return api(`/payments/${orderId}/refund`, 'POST', {
    amount: { amount: (amountCents / 100).toFixed(2), currency },
  });
}

function isConfigured() {
  const a = config.afterpay || {};
  return !!(a.merchantId && a.secretKey);
}

module.exports = {
  AfterpayNotConfigured,
  isConfigured,
  createCheckout,
  capturePayment,
  getCheckout,
  refund,
};
