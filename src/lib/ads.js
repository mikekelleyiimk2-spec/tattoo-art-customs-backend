// Direct-sold ad space: slot definitions, pricing, and queries.
// AdSense (ADSENSE_PUBLISHER_ID) remains as the remnant fallback when no
// direct ad is booked for a slot — see views/partials/ad-slot.ejs.
const db = require('../db');

// Rates are per 30 days and INCLUDE the 3.5% + $0.49 processing fee
// (standing rule: fees are passed through into prices, never absorbed).
// Change here; the /advertise page reads from this.
const SLOTS = {
  leaderboard: {
    name: 'Leaderboard — every page',
    description: 'Banner below the site header, shown on every page.',
    specs: 'Responsive banner (up to 970×90). JPG/PNG, under 500 KB.',
    price_cents: 15574, // $150 + $5.74 fee
  },
  gallery_inline: {
    name: 'Gallery spotlight',
    description: 'Large banner above the design grid on the gallery page — the highest-traffic page.',
    specs: 'Responsive banner (up to 970×250). JPG/PNG, under 500 KB.',
    price_cents: 10399, // $100 + $3.99 fee
  },
  design_page: {
    name: 'Design page banner',
    description: 'Banner under every design detail page, next to the buy button.',
    specs: 'Responsive banner (up to 728×90). JPG/PNG, under 500 KB.',
    price_cents: 7812, // $75 + $3.12 fee
  },
};

function slotIds() {
  return Object.keys(SLOTS);
}

async function getActiveAds() {
  const now = db.now();
  const rows = await db.all(
    `SELECT * FROM ads WHERE active = 1 AND starts_at <= ? AND ends_at >= ? ORDER BY created_at DESC`,
    [now, now]
  );
  const bySlot = {};
  for (const r of rows) {
    if (!bySlot[r.slot]) bySlot[r.slot] = r;
  }
  return bySlot;
}

async function recordImpressions(ids) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  await db.query(`UPDATE ads SET impressions = impressions + 1 WHERE id IN (${placeholders})`, ids);
}

async function recordClick(id) {
  await db.query('UPDATE ads SET clicks = clicks + 1 WHERE id = ?', [id]);
}

function validLinkUrl(url) {
  return typeof url === 'string' && /^(https?:\/\/)/i.test(url.trim());
}

// ---------------------------------------------------------------------------
// TIER 3 — ad-revenue funding for the site overhead pool (owner rule 2026-09-29).
// ---------------------------------------------------------------------------
// 50% of every recognized ad-revenue dollar is swept into the site overhead
// pool (commission_ledger recipient_type='site'), cushioning Tier-2 admin
// task pay and storage costs. The other 50% belongs to the owner and needs
// no ledger row — it is simply not booked here.
//
// TODO — ingestion points (no automatic revenue event exists yet):
// - AdSense pays Google -> the owner's bank directly; the site never sees the
//   money. Reconcile manually: a future /admin/ads "record payout" button
//   should call recordAdRevenue({ amountCents, source: 'adsense' }).
// - Direct-sold slots (routes/ads.js) are confirmed by manual email today;
//   call recordAdRevenue({ amountCents, source: 'direct:<slot>' }) wherever
//   that payment gets confirmed (see the TODO in routes/ads.js).
async function recordAdRevenue({ amountCents, source }) {
  const amt = Math.max(0, Math.round(amountCents || 0));
  const siteShare = Math.floor(amt / 2); // owner-favorable rounding on odd cents
  if (siteShare > 0) {
    await db.insert('commission_ledger', {
      // Synthetic order_id: the ledger column is NOT NULL and has no `note`
      // field, so ad revenue uses a namespaced id that can never collide
      // with a real sale's commission rows.
      order_id: `adrev:${source}:${Date.now()}`,
      recipient_type: 'site', recipient_id: null,
      amount_cents: siteShare, status: 'site_kept',
      commission_type: 'ad_revenue',
    });
  }
  return { site_cents: siteShare, owner_cents: amt - siteShare };
}

module.exports = { SLOTS, slotIds, getActiveAds, recordImpressions, recordClick, validLinkUrl, recordAdRevenue };
