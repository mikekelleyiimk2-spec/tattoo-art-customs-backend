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
const { verifyPurchase, MEMBERSHIP_PLAN_BY_PRODUCT } = require('../lib/playverify');
const { grantPlanRole } = require('../lib/planRoles');
const { maybeEnterRaffle } = require('../lib/founding');

const router = express.Router();

// Known Play product IDs (must match the SKUs created in the Play Console).
// Commission-earning plans (artist, shop) are website-only by owner rule
// (2026-09-28): signup for receiving commissions happens on the website,
// never via a Play purchase — so those SKUs are rejected here.
const KNOWN_PRODUCTS = new Set([
  'tac_membership_customer',
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
        // Same post-activation steps as the website checkout: grant the
        // plan role (+ founding-program claim) and enter the raffle.
        // Both are idempotent.
        try { await grantPlanRole(user.id, planSlug); }
        catch (e) { console.error('play role grant failed:', e.message); }
        try { await maybeEnterRaffle(user.id, subId); }
        catch (e) { console.error('play raffle entry failed:', e.message); }
      } else if (verification.expiryTime && purchaseId) {
        await db.update('subscriptions', existing.id, { current_period_end: verification.expiryTime });
        await db.update('play_purchases', purchaseId, { linked_membership_id: existing.id });
        membershipActivated = true;
      }
    }
  }

  return res.json({ ok: true, linked: !!user, verified, membershipActivated });
});

module.exports = router;
