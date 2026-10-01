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
        // Google auto-refunds purchases left unacknowledged after ~3 days.
        // needsAcknowledge drives the acknowledge call in the purchase route.
        needsAcknowledge: d.acknowledgementState === 0,
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
      needsAcknowledge: d.acknowledgmentState === 0,
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

// Acknowledge a verified purchase with Google. Unacknowledged purchases are
// auto-refunded by Google after ~3 days WHILE the membership stays active —
// this call is what keeps the revenue. Idempotent: acknowledging twice is a
// no-op on Google's side (returns success). Must only be called AFTER the
// membership/access has actually been granted.
async function acknowledgePurchase({ productId, purchaseToken, type }) {
  const publisher = await getPublisher();
  if (!publisher) return { ok: false, reason: 'not_configured' };
  try {
    if (type === 'subs') {
      await publisher.purchases.subscriptions.acknowledge({
        packageName: PACKAGE_NAME,
        subscriptionId: productId,
        token: purchaseToken,
        requestBody: {},
      });
    } else {
      await publisher.purchases.products.acknowledge({
        packageName: PACKAGE_NAME,
        productId,
        token: purchaseToken,
        requestBody: {},
      });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Retry sweep for purchases that were verified and granted but whose
// acknowledge call failed (network blip, deploy mid-request, ...). Runs
// hourly from the scheduler. Without this, a single failed acknowledge =
// Google refunds in 3 days and we never notice.
async function retryUnacknowledgedPurchases() {
  const db = require('../db');
  const rows = await db.all(
    `SELECT * FROM play_purchases
     WHERE status = 'verified' AND acknowledged_at IS NULL
       AND linked_membership_id IS NOT NULL
     ORDER BY verified_at ASC LIMIT 25`);
  let acked = 0;
  for (const row of rows) {
    const r = await acknowledgePurchase({
      productId: row.product_id, purchaseToken: row.purchase_token,
      type: row.purchase_type === 'inapp' ? 'inapp' : 'subs',
    });
    if (r.ok) {
      await db.update('play_purchases', row.id, { acknowledged_at: db.now() });
      acked++;
    } else {
      console.error(`play acknowledge retry failed for ${row.id}: ${r.reason}`);
    }
  }
  if (acked) console.log(`play acknowledge sweep: acknowledged ${acked} purchase(s)`);
  return acked;
}

module.exports = {
  verifyPurchase, acknowledgePurchase, retryUnacknowledgedPurchases,
  serviceAccountConfigured, MEMBERSHIP_PLAN_BY_PRODUCT, PACKAGE_NAME,
};
