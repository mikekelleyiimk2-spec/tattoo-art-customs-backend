// Direct-sold ad space: slot definitions, pricing, and queries.
// AdSense (ADSENSE_PUBLISHER_ID) remains as the remnant fallback when no
// direct ad is booked for a slot — see views/partials/ad-slot.ejs.
const db = require('../db');

// Rates are per 30 days. Change here; the /advertise page reads from this.
const SLOTS = {
  leaderboard: {
    name: 'Leaderboard — every page',
    description: 'Banner below the site header, shown on every page.',
    specs: 'Responsive banner (up to 970×90). JPG/PNG, under 500 KB.',
    price_cents: 15000,
  },
  gallery_inline: {
    name: 'Gallery spotlight',
    description: 'Large banner above the design grid on the gallery page — the highest-traffic page.',
    specs: 'Responsive banner (up to 970×250). JPG/PNG, under 500 KB.',
    price_cents: 10000,
  },
  design_page: {
    name: 'Design page banner',
    description: 'Banner under every design detail page, next to the buy button.',
    specs: 'Responsive banner (up to 728×90). JPG/PNG, under 500 KB.',
    price_cents: 7500,
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

module.exports = { SLOTS, slotIds, getActiveAds, recordImpressions, recordClick, validLinkUrl };
