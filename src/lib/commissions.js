// Commission engine. Owner rules:
//
// - Registered third-party artist's work: 60% original designer,
//   10% site, 20% referring tattoo shop. These sum to 90%; the remaining
//   10% is kept by the site (recorded as a separate site_kept entry) —
//   the stated splits are never altered to absorb it.
// - Owner's art or art from unregistered artists: 80% site, 20% referring
//   tattoo shop.
// - Referring shops are paid ONLY on verified sales (admin verifies).
// - Founding program (first 50 artists / first 100 shops, 6 months):
//   founding artists earn 70% instead of 60% (the owner's 10% split becomes
//   0% — the owner funds the boost); founding shops earn 25% instead of
//   20% on referred sales (the extra 5pts come from the owner's share).
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
const config = require('../config');
const founding = require('./founding');

// Site owner lookup (for payable-balance redirects).
async function ownerUserId() {
  if (!config.adminEmail) return null;
  const u = await db.get('SELECT id FROM users WHERE email = ?', [config.adminEmail.toLowerCase()]);
  return u ? u.id : null;
}

// --- TIER 2 — commission suspension ---
// Trigger: 6+ missed deadlines (day-7 order terminations) in the trailing 60
// days. Effect for 30 days: the designer earns 0% commission on NEW sales
// (custom + premade); their forfeited share is redirected to the site owner's
// payable balance. Listings stay up, the account stays fully active, and the
// subscription is NEVER touched. Lifts automatically after 30 days; on lift,
// re-check: if still 6+ misses in the trailing 60 days, a new 30-day
// suspension begins. Tracked in users.commission_suspended_until.
const TIER2_WINDOW_MS = 60 * 86400000;
const TIER2_MISSES = 6;
const TIER2_DURATION_MS = 30 * 86400000;

// Miss timestamps (desc) for a designer inside a trailing window, ignoring
// anything at/before an admin forgiveness.
async function missTimes(designerId, now, windowMs) {
  const u = await db.get('SELECT COALESCE(sla_forgiven_at, 0) AS f FROM users WHERE id = ?', [designerId]);
  const forgivenAt = u ? u.f : 0;
  const rows = await db.all(
    `SELECT deadline_missed_at AS t FROM orders
     WHERE requested_artist_id = ? AND deadline_missed = 1
       AND deadline_missed_at >= ? AND deadline_missed_at > ?
     ORDER BY deadline_missed_at DESC`,
    [designerId, now - windowMs, forgivenAt]);
  return rows.map((r) => r.t).filter((t) => t);
}

async function commissionSuspendedUntil(userId, now = Date.now()) {
  const u = await db.get('SELECT commission_suspended_until AS u FROM users WHERE id = ?', [userId]);
  const until = u ? u.u : null;
  return until && until > now ? until : null;
}

async function commissionSuspended(userId, now = Date.now()) {
  return (await commissionSuspendedUntil(userId, now)) !== null;
}

// Trigger new suspensions and renew expired ones whose misses persist.
// Called by the SLA enforcer after applying penalties.
async function refreshCommissionSuspensions({ now = Date.now() } = {}) {
  const changed = [];
  const artists = await db.all(
    `SELECT id, commission_suspended_until FROM users WHERE role = 'design_artist'`);
  for (const a of artists) {
    const active = a.commission_suspended_until && a.commission_suspended_until > now;
    if (active) continue; // lifts automatically; renewal checked once expired
    const times = await missTimes(a.id, now, TIER2_WINDOW_MS);
    if (times.length >= TIER2_MISSES) {
      const until = now + TIER2_DURATION_MS;
      await db.update('users', a.id, { commission_suspended_until: until });
      changed.push({ designer_id: a.id, until, misses: times.length });
    }
  }
  return changed;
}

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
  const design = order.design_id ? await db.get('SELECT artist_id, color_source FROM designs WHERE id = ?', [order.design_id]) : null;
  const artistId = design && design.artist_id ? design.artist_id : null;
  const shopId = order.referred_shop_id || null;
  // Founding-program boosts (first 50 artists / first 100 shops, 6 months):
  // - founding artist: 70% instead of 60%; the owner's 10% split becomes 0%
  //   (the owner funds the boost).
  // - founding shop: 25% referral share instead of 20%; the extra 5pts come
  //   out of the owner's 10% split (or the residual when that split is 0).
  const foundingBoost = artistId ? await founding.foundingArtistActive(artistId, t) : false;
  const shopBoost = shopId ? await founding.foundingShopActive(shopId, t) : false;
  // Colorization fee: when the designer did not provide the color version
  // (linework-only upload, with or without a site-created color), their
  // rate drops 5 points and the website keeps those 5 points as a
  // colorization fee (recorded distinctly so the owner can see it).
  const noDesignerColor = !!design && (design.color_source === 'site' || design.color_source === 'none');
  const designerRate = (noDesignerColor ? 0.55 : 0.60) + (foundingBoost ? 0.10 : 0);
  const colorFeeRate = noDesignerColor ? 0.05 : 0;

  if (artistId) {
    // Third-party artist work: exactly 60% designer / 10% site / 20% shop.
    // The stated splits sum to 90%; the leftover 10% is kept by the site
    // as an explicit residual entry (never folded into another split).
    const designerAmt = Math.round(order.amount_paid_cents * designerRate);
    let siteAmt = Math.round(order.amount_paid_cents * (foundingBoost ? 0 : 0.10));
    const feeAmt = Math.round(order.amount_paid_cents * colorFeeRate);
    const shopBase = Math.round(order.amount_paid_cents * (shopBoost ? 0.25 : 0.20));
    if (shopBoost && siteAmt > 0) {
      // The founding shop's extra 5pts come from the owner's share.
      siteAmt = Math.max(0, siteAmt - Math.round(order.amount_paid_cents * 0.05));
    }
    const residual = order.amount_paid_cents - designerAmt - siteAmt - feeAmt - shopBase;
    const designerEligible = await recipientEligible(artistId, 'design_artist');
    const suspended = await commissionSuspended(artistId, t);
    if (suspended) {
      // TIER 2: designer's 60% is redirected to the site owner's payable
      // balance (it funds buyer apology credits). Shop 20% and site 10%
      // are unchanged; the designer's listings stay up.
      const ownerId = await ownerUserId();
      entries.push({
        order_id: order.id, recipient_type: 'artist', recipient_id: artistId,
        amount_cents: 0, status: 'site_kept', created_at: t,
      });
      entries.push({
        order_id: order.id, recipient_type: 'site', recipient_id: ownerId,
        amount_cents: designerAmt, status: ownerId ? 'payable' : 'site_kept', created_at: t,
      });
    } else {
      entries.push({
        order_id: order.id, recipient_type: 'artist', recipient_id: artistId,
        amount_cents: designerAmt, status: designerEligible ? 'payable' : 'site_kept', created_at: t,
      });
    }
    entries.push({
      order_id: order.id, recipient_type: 'site', recipient_id: null,
      amount_cents: siteAmt, status: 'site_kept', commission_type: 'split', created_at: t,
    });
    if (feeAmt > 0) {
      // The website's colorization fee — kept distinctly visible in the ledger.
      entries.push({
        order_id: order.id, recipient_type: 'site', recipient_id: null,
        amount_cents: feeAmt, status: 'site_kept', commission_type: 'colorization_fee', created_at: t,
      });
    }
    entries.push({
      order_id: order.id, recipient_type: 'site', recipient_id: null,
      amount_cents: residual, status: 'site_kept', commission_type: 'split', created_at: t,
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
    // Owner / unregistered art: 80 site / 20 referring shop. A founding
    // shop's boost takes its extra 5pts from the owner's share (75/25).
    const shopAmt = Math.round(order.amount_paid_cents * (shopBoost ? 0.25 : 0.20));
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

// Record the designer's 60% commission for a custom order routed to an artist.
// Custom orders have no design_id, so recordSaleCommissions() books them as
// owner art (80% site / 20% shop). When an artist takes the job, carve their
// 60% out of the site's share. Idempotent: returns the existing row's amount
// if a designer commission was already recorded for this order+artist.
async function recordCustomDesignerCommission(order, artistId) {
  if (!order || !artistId) return 0;
  const existing = await db.get(
    `SELECT * FROM commission_ledger WHERE order_id = ? AND recipient_type = 'artist' AND recipient_id = ?`,
    [order.id, artistId]);
  if (existing) return existing.amount_cents;
  // TIER 2: while commission-suspended the designer earns 0% on new sales —
  // the site keeps its full share (the designer's forfeited share stays with
  // the owner). Record an explicit 0¢ row for transparency.
  if (await commissionSuspended(artistId, db.now())) {
    await db.insert('commission_ledger', {
      order_id: order.id, recipient_type: 'artist', recipient_id: artistId,
      amount_cents: 0, status: 'site_kept', created_at: db.now(),
    });
    return 0;
  }
  // Founding artists earn 70% on customs for 6 months (the boost is carved
  // out of the site's share like the standard 60%).
  const rate = await founding.foundingArtistActive(artistId, db.now()) ? 0.70 : 0.60;
  const designerAmt = Math.round((order.amount_paid_cents || 0) * rate);
  if (designerAmt <= 0) return 0;
  // Take it out of the site's share (the largest site_kept 'site' row).
  const siteRow = await db.get(
    `SELECT * FROM commission_ledger WHERE order_id = ? AND recipient_type = 'site'
     AND recipient_id IS NULL AND status = 'site_kept' ORDER BY amount_cents DESC LIMIT 1`,
    [order.id]);
  if (siteRow) {
    await db.update('commission_ledger', siteRow.id, {
      amount_cents: Math.max(0, siteRow.amount_cents - designerAmt),
    });
  }
  const eligible = await recipientEligible(artistId, 'design_artist');
  await db.insert('commission_ledger', {
    order_id: order.id, recipient_type: 'artist', recipient_id: artistId,
    amount_cents: designerAmt, status: eligible ? 'payable' : 'site_kept',
    created_at: db.now(),
  });
  return designerAmt;
}

module.exports = {
  recipientEligible, recordSaleCommissions, verifyOrderCommissions, payableBalance,
  recordCustomDesignerCommission, ownerUserId,
  TIER2_WINDOW_MS, TIER2_MISSES, TIER2_DURATION_MS,
  missTimes, commissionSuspended, commissionSuspendedUntil, refreshCommissionSuspensions,
};
