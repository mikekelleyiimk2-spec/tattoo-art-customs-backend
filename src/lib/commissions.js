// Commission engine. Owner rules:
//
// - Registered third-party artist's work: 60% original designer,
//   10% site, 20% referring tattoo shop. These sum to 90%; the remaining
//   10% is kept by the site (recorded as a separate site_kept entry) —
//   the stated splits are never altered to absorb it.
// - Owner's art or art from unregistered artists: 80% site, 20% referring
//   tattoo shop.
// - Referring shops are paid ONLY on verified sales (admin verifies).
// - Artists/shops are paid ONLY if registered + actively subscribed +
//   payout method (PayPal email) configured; otherwise the site keeps all.
// - Commission splits are shown in artist/shop dashboards ONLY —
//   never to customers.
//
// Splits are recorded in commission_ledger with status:
//   pending  — sale not yet verified by admin (shop share)
//   payable  — verified and recipient eligible
//   site_kept — recipient ineligible (or the site's own share); site keeps it
//   paid     — included in a completed payout run
const db = require('../db');

// Is this user currently eligible to RECEIVE payouts?
async function recipientEligible(userId, role) {
  if (!userId) return false;
  const user = await db.get('SELECT id, role FROM users WHERE id = ?', [userId]);
  if (!user) return false;
  const planSlug = role === 'design_artist' ? 'design_artist' : 'tattoo_shop';
  const sub = await db.get(
    `SELECT s.id FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = ? AND p.slug = ? AND s.status = 'active'`, [userId, planSlug]);
  if (!sub) return false;
  const profileTable = role === 'design_artist' ? 'artist_profiles' : 'shop_profiles';
  const profile = await db.get(`SELECT payout_paypal_email FROM ${profileTable} WHERE user_id = ?`, [userId]);
  if (profile && profile.payout_paypal_email) return true;
  // Any configured payout destination qualifies (PayPal, bank, Cash App,
  // Venmo, Zelle, Chime, Varo, Wise, other) — not just a PayPal email.
  const dest = await db.get('SELECT id FROM payout_destinations WHERE user_id = ? LIMIT 1', [userId]);
  return !!dest;
}

// Record commission splits for a paid order. Called once per order
// (guarded by checking existing ledger rows).
async function recordSaleCommissions(order) {
  const existing = await db.get('SELECT id FROM commission_ledger WHERE order_id = ?', [order.id]);
  if (existing) return;

  const t = db.now();
  const entries = [];
  const design = order.design_id ? await db.get('SELECT artist_id FROM designs WHERE id = ?', [order.design_id]) : null;
  const artistId = design && design.artist_id ? design.artist_id : null;
  const shopId = order.referred_shop_id || null;

  if (artistId) {
    // Third-party artist work: exactly 60% designer / 10% site / 20% shop.
    // The stated splits sum to 90%; the leftover 10% is kept by the site
    // as an explicit residual entry (never folded into another split).
    const designerAmt = Math.round(order.amount_paid_cents * 0.60);
    const siteAmt = Math.round(order.amount_paid_cents * 0.10);
    const shopBase = Math.round(order.amount_paid_cents * 0.20);
    const residual = order.amount_paid_cents - designerAmt - siteAmt - shopBase;
    const designerEligible = await recipientEligible(artistId, 'design_artist');
    entries.push({
      order_id: order.id, recipient_type: 'artist', recipient_id: artistId,
      amount_cents: designerAmt, status: designerEligible ? 'payable' : 'site_kept', created_at: t,
    });
    entries.push({
      order_id: order.id, recipient_type: 'site', recipient_id: null,
      amount_cents: siteAmt, status: 'site_kept', created_at: t,
    });
    entries.push({
      order_id: order.id, recipient_type: 'site', recipient_id: null,
      amount_cents: residual, status: 'site_kept', created_at: t,
    });
    if (shopId) {
      const shopEligible = await recipientEligible(shopId, 'tattoo_shop');
      entries.push({
        order_id: order.id, recipient_type: 'shop', recipient_id: shopId,
        amount_cents: shopBase,
        // Shops earn ONLY on verified sales — admin flips pending -> payable.
        status: shopEligible ? 'pending' : 'site_kept', created_at: t,
      });
    } else {
      entries.push({
        order_id: order.id, recipient_type: 'site', recipient_id: null,
        amount_cents: shopBase, status: 'site_kept', created_at: t,
      });
    }
  } else {
    // Owner / unregistered art: 80 site / 20 referring shop
    const shopAmt = Math.round(order.amount_paid_cents * 0.20);
    const siteAmt = order.amount_paid_cents - shopAmt;
    entries.push({
      order_id: order.id, recipient_type: 'site', recipient_id: null,
      amount_cents: siteAmt, status: 'site_kept', created_at: t,
    });
    if (shopId) {
      const shopEligible = await recipientEligible(shopId, 'tattoo_shop');
      entries.push({
        order_id: order.id, recipient_type: 'shop', recipient_id: shopId,
        amount_cents: shopAmt,
        status: shopEligible ? 'pending' : 'site_kept', created_at: t,
      });
    } else {
      entries.push({
        order_id: order.id, recipient_type: 'site', recipient_id: null,
        amount_cents: shopAmt, status: 'site_kept', created_at: t,
      });
    }
  }

  for (const e of entries) await db.insert('commission_ledger', e);
  return entries;
}

// Admin verifies a referred sale: pending shop shares become payable.
async function verifyOrderCommissions(orderId) {
  const rows = await db.all(
    "SELECT id FROM commission_ledger WHERE order_id = ? AND status = 'pending'", [orderId]);
  for (const r of rows) {
    await db.update('commission_ledger', r.id, { status: 'payable' });
  }
  return rows.length;
}

async function payableBalance(recipientType, recipientId) {
  const row = await db.get(
    `SELECT COALESCE(SUM(amount_cents),0) AS total FROM commission_ledger
     WHERE recipient_type = ? AND recipient_id = ? AND status = 'payable'`,
    [recipientType, recipientId]);
  return row.total;
}

module.exports = { recipientEligible, recordSaleCommissions, verifyOrderCommissions, payableBalance };
