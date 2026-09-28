// Server-side Google Play purchase verification via the Play Developer API.
// Requires GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (the service-account key JSON,
// created in Google Cloud + granted access in the Play Console) and
// PLAY_PACKAGE_NAME (defaults to com.tattooartcustoms.app).
// When not configured, verifyPurchase() returns { verified: false,
// reason: 'not_configured' } and callers keep the purchase as pending.
const config = require('../config');

const PACKAGE_NAME = process.env.PLAY_PACKAGE_NAME || 'com.tattooartcustoms.app';

let authClient = null;
function serviceAccountConfigured() {
  return !!(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || '').trim();
}

async function getPublisher() {
  if (!serviceAccountConfigured()) return null;
  if (!authClient) {
    const { google } = require('googleapis');
    const key = JSON.parse(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    authClient = google.androidpublisher({ version: 'v3', auth });
  }
  return authClient;
}

// type: 'subs' | 'inapp'. Returns { verified, orderId, purchaseTime, expiryTime, reason }.
async function verifyPurchase({ productId, purchaseToken, type }) {
  const publisher = await getPublisher();
  if (!publisher) return { verified: false, reason: 'not_configured' };
  try {
    if (type === 'subs') {
      const r = await publisher.purchases.subscriptions.get({
        packageName: PACKAGE_NAME, subscriptionId: productId, token: purchaseToken,
      });
      const d = r.data || {};
      const state = d.paymentState; // 1 = payment received
      const ok = d.acknowledgementState === 1 || state === 1;
      return {
        verified: !!ok,
        orderId: d.orderId || '',
        purchaseTime: d.startTimeMillis ? parseInt(d.startTimeMillis, 10) : null,
        expiryTime: d.expiryTimeMillis ? parseInt(d.expiryTimeMillis, 10) : null,
        reason: ok ? '' : 'subscription not active',
      };
    }
    const r = await publisher.purchases.products.get({
      packageName: PACKAGE_NAME, productId, token: purchaseToken,
    });
    const d = r.data || {};
    const ok = d.purchaseState === 0; // 0 = purchased
    return {
      verified: !!ok,
      orderId: d.orderId || '',
      purchaseTime: d.purchaseTimeMillis ? parseInt(d.purchaseTimeMillis, 10) : null,
      expiryTime: null,
      reason: ok ? '' : 'product not purchased',
    };
  } catch (e) {
    return { verified: false, reason: e.message };
  }
}

// Play product ID -> website plan slug (memberships only).
// Payout-method setup and verification stays website-only (owner rule
// 2026-09-28); plans themselves may be bought via Google Play.
const MEMBERSHIP_PLAN_BY_PRODUCT = {
  tac_membership_customer: 'customer',
  tac_membership_artist: 'design_artist',
  tac_membership_shop: 'tattoo_shop',
};

module.exports = { verifyPurchase, serviceAccountConfigured, MEMBERSHIP_PLAN_BY_PRODUCT, PACKAGE_NAME };
