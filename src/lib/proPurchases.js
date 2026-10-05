// Verified Pro-app purchase registry (owner directive 2026-10-05).
// Buying the Pro app (no ads, ever) unlocks the 6-month customer membership
// perk. This module gates that perk: a user is eligible ONLY if a verified
// purchase row exists in pro_purchases.
//   - Android Pro: Play Billing one-time purchase, verified via
//     src/lib/playverify.js, recorded through POST /play/verify-pro.
//   - iOS sideload Pro ($1.67): recorded by the website at PayPal capture
//     time (src/routes/iosApp.js) — the buyer is already known there.
// Exactly-once: purchase_token has a UNIQUE constraint; recordProPurchase
// treats a duplicate token from the same user as already-recorded
// (idempotent), and rejects a token claimed by a different user.
const db = require('../db');

async function hasVerifiedProPurchase(userId) {
  if (!userId) return false;
  const row = await db.get('SELECT id FROM pro_purchases WHERE user_id = ? LIMIT 1', [userId]);
  return !!row;
}

// Idempotent: a duplicate purchase_token from the SAME user returns the
// existing row's id instead of throwing — replays (retries, double-submits)
// grant nothing new. A token already claimed by a DIFFERENT user is rejected
// loudly: someone else's purchase receipt must never unlock this account.
async function recordProPurchase({ userId, purchaseToken, platform }) {
  const token = String(purchaseToken || '').slice(0, 512);
  if (!userId || !token) throw new Error('userId and purchaseToken required');
  const existing = await db.get('SELECT id, user_id FROM pro_purchases WHERE purchase_token = ?', [token]);
  if (existing) {
    if (existing.user_id !== userId) throw new Error('purchase token already claimed by another account');
    return existing.id;
  }
  return db.insert('pro_purchases', {
    id: db.newId(),
    user_id: userId,
    purchase_token: token,
    platform: String(platform || '').slice(0, 32),
    verified_at: db.now(),
    created_at: db.now(),
  });
}

module.exports = { hasVerifiedProPurchase, recordProPurchase };
