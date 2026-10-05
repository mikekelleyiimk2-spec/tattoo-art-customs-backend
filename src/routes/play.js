// Google Play Billing verification intake for the Android app.
// The app POSTs each completed purchase here (with the apiToken when the
// user linked their website account in the app).
//
// Flow: record the purchase as 'pending', then verify the purchase token
// against Google's servers via the Play Developer API service account
// (GOOGLE_PLAY_SERVICE_ACCOUNT_JSON). Verified membership purchases on a
// linked account automatically activate the matching website membership,
// so app subscribers get website subscriber perks (Design Studio, etc.).
// One-time design purchases are marked verified for the admin to fulfill.
// Without the service account configured, purchases stay 'pending' for
// manual review — never silently trusted.
const express = require('express');
const db = require('../db');
const { userFromToken } = require('./api');
const { verifyPurchase, acknowledgePurchase, MEMBERSHIP_PLAN_BY_PRODUCT } = require('../lib/playverify');
const { grantPlanRole } = require('../lib/planRoles');

const router = express.Router();

// Known Play product IDs (must match the SKUs created in the Play Console).
// All plans (including commission-earning artist/shop) may be bought via
// Google Play. Payout-method setup and verification stays website-only
// (owner rule 2026-09-28).
const KNOWN_PRODUCTS = new Set([
  'tac_membership_customer',
  'tac_membership_artist',
  'tac_membership_shop',
  'tac_premade',
  'tac_premade_sale',
  'tac_custom_deposit',
  'tac_custom_deposit_sale',
]);

router.post('/verify', express.json(), async (req, res) => {
  const productId = String(req.body?.productId || '').slice(0, 128);
  const purchaseToken = String(req.body?.purchaseToken || '').slice(0, 512);
  const type = req.body?.type === 'subs' ? 'subs' : 'inapp';
  const email = String(req.body?.email || '').slice(0, 160);
  const apiToken = String(req.body?.apiToken || '').slice(0, 128);

  if (!productId || !KNOWN_PRODUCTS.has(productId) || !purchaseToken) {
    return res.status(400).json({ ok: false, error: 'invalid purchase' });
  }

  // Resolve the linked website account, if the app sent its api token.
  let user = null;
  if (apiToken) {
    user = await db.get('SELECT * FROM users WHERE api_token = ?', [apiToken]);
  }

  let purchaseId = null;
  try {
    purchaseId = await db.insert('play_purchases', {
      id: db.newId(),
      product_id: productId,
      purchase_token: purchaseToken,
      purchase_type: type,
      status: 'pending',
      email,
      user_id: user ? user.id : null,
      created_at: db.now(),
    });
  } catch (err) {
    // Duplicate token (already recorded) is fine — idempotent intake.
    if (!String(err?.message || '').includes('UNIQUE')) throw err;
    const existing = await db.get(
      'SELECT * FROM play_purchases WHERE purchase_token = ?', [purchaseToken]);
    if (existing) {
      if (user && !existing.user_id) {
        await db.update('play_purchases', existing.id, { user_id: user.id });
      }
      return res.json({ ok: true, linked: !!user, verified: existing.status === 'verified' });
    }
  }

  // Verify with Google. Unconfigured or failed -> stays pending for manual review.
  let verified = false;
  let verification = { verified: false, reason: 'not_configured' };
  try {
    verification = await verifyPurchase({ productId, purchaseToken, type });
    verified = verification.verified;
  } catch (e) {
    verification = { verified: false, reason: e.message };
  }
  if (purchaseId) {
    await db.update('play_purchases', purchaseId, {
      status: verified ? 'verified' : 'pending',
      verified_at: verified ? db.now() : null,
    });
  }

  // Verified membership purchase on a linked account -> activate website membership.
  let membershipActivated = false;
  let acknowledged = false;
  // Acknowledge ONLY after the membership is actually granted: the ack tells
  // Google "goods delivered", which stops the 3-day auto-refund. Acking before
  // the grant (or on a failed grant) would trade one revenue leak for a
  // support nightmare. Failures are retried by the hourly scheduler sweep.
  async function acknowledgeNow() {
    if (acknowledged || !verification.needsAcknowledge) return;
    const r = await acknowledgePurchase({ productId, purchaseToken, type });
    if (r.ok) {
      acknowledged = true;
      if (purchaseId) await db.update('play_purchases', purchaseId, { acknowledged_at: db.now() });
    } else {
      console.error(`PLAY ACKNOWLEDGE FAILED for purchase ${purchaseId || purchaseToken.slice(0, 12)}: ${r.reason} — hourly sweep will retry; Google auto-refunds in ~3 days if never acked`);
    }
  }
  const planSlug = MEMBERSHIP_PLAN_BY_PRODUCT[productId];
  if (verified && user && planSlug) {
    const plan = await db.get('SELECT * FROM plans WHERE slug = ? AND active = 1', [planSlug]);
    if (plan) {
      const existing = await db.get(
        `SELECT s.id FROM subscriptions s WHERE s.user_id = ? AND s.plan_id = ?
         AND s.status = 'active' AND (s.current_period_end IS NULL OR s.current_period_end > ?)`,
        [user.id, plan.id, Date.now()]);
      if (!existing) {
        const subId = await db.insert('subscriptions', {
          user_id: user.id, plan_id: plan.id, status: 'active',
          paypal_subscription_id: `play:${purchaseToken.slice(0, 120)}`,
          current_period_end: verification.expiryTime || null,
          created_at: db.now(),
        });
        if (purchaseId) await db.update('play_purchases', purchaseId, { linked_membership_id: subId });
        membershipActivated = true;
        // Ledger the Play purchase (idempotent on purchase token; renewals
        // reusing the token are no-ops). Recorded at gross plan price —
        // Google's store cut is not deducted (see subscriptionRevenue.js).
        try {
          await require('../lib/subscriptionRevenue').recordSubscriptionRevenue({
            userId: user.id, plan: planSlug, amountCents: plan.price_cents,
            provider: 'google_play', providerRef: `play:${purchaseToken.slice(0, 120)}`,
          });
        } catch (e) { console.error('subscription revenue record failed:', e.message); }
        // Same post-activation steps as the website checkout: grant the
        // plan role (+ founding-program claim). Idempotent.
        try { await grantPlanRole(user.id, planSlug); }
        catch (e) { console.error('play role grant failed:', e.message); }
        await acknowledgeNow();
        // Raffle entries come from free account signup only — no membership path.
      } else if (verification.expiryTime && purchaseId) {
        await db.update('subscriptions', existing.id, { current_period_end: verification.expiryTime });
        await db.update('play_purchases', purchaseId, { linked_membership_id: existing.id });
        membershipActivated = true;
        await acknowledgeNow();
      }
    }
  }

  return res.json({ ok: true, linked: !!user, verified, membershipActivated });
});

// Pro-app purchase intake (owner directive 2026-10-05): records a VERIFIED
// Pro purchase so the buyer unlocks the 6-month membership perk. Android Pro
// is a paid download — the Play Billing purchase's product ID is the Pro
// package itself (BillingClient returns the paid app as an inapp purchase
// whose SKU is the package name). Requires a linked website account
// (apiToken): the perk gates a WEBSITE membership, so an unlinked purchase
// cannot be attributed. Verified via the Play Developer API service account;
// unverified or unconfigured purchases are REJECTED (never silently trusted
// like /verify's manual-review pending state — this endpoint grants a perk,
// so fail-closed).
const PRO_PACKAGE = process.env.PLAY_PRO_PACKAGE_NAME || 'com.tattooartcustoms.app.pro';

router.post('/verify-pro', express.json(), async (req, res) => {
  const purchaseToken = String(req.body?.purchaseToken || '').slice(0, 512);
  const apiToken = String(req.body?.apiToken || '').slice(0, 128);
  if (!purchaseToken || !apiToken) {
    return res.status(400).json({ ok: false, error: 'purchaseToken and apiToken required' });
  }
  const user = await db.get('SELECT id FROM users WHERE api_token = ?', [apiToken]);
  if (!user) return res.status(401).json({ ok: false, error: 'not linked' });
  let verification = { verified: false, reason: 'not_configured' };
  try {
    verification = await verifyPurchase({
      productId: PRO_PACKAGE, purchaseToken, type: 'inapp', packageName: PRO_PACKAGE,
    });
  } catch (e) {
    verification = { verified: false, reason: e.message };
  }
  if (!verification.verified) {
    return res.status(402).json({ ok: false, error: 'unverified', reason: verification.reason });
  }
  const { recordProPurchase } = require('../lib/proPurchases');
  try {
    await recordProPurchase({ userId: user.id, purchaseToken, platform: 'android' });
  } catch (e) {
    return res.status(409).json({ ok: false, error: e.message });
  }
  // The perk IS the delivered good: acknowledge so Google does not auto-
  // refund in ~3 days. Ack failure is logged only — the perk row is the
  // source of truth and a retry sweep is not worth a new table for a
  // one-time intake.
  if (verification.needsAcknowledge) {
    const ack = await acknowledgePurchase({
      productId: PRO_PACKAGE, purchaseToken, type: 'inapp', packageName: PRO_PACKAGE,
    });
    if (!ack.ok) console.error(`PRO PURCHASE ACKNOWLEDGE FAILED for ${purchaseToken.slice(0, 12)}: ${ack.reason}`);
  }
  return res.json({ ok: true, eligibleFor6Month: true });
});

module.exports = router;
