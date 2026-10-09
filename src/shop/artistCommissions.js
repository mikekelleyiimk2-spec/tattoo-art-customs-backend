// Artist commission tracker (shop toolset, 2026-10-09).
//
// INTERNAL shop bookkeeping only: the shop owner defines their artists
// (name + the % of each booking the artist keeps) and logs earnings per
// booking. The split is computed once at log time (artist_share = round of
// total at the artist's rate, shop_share = the remainder) so later rate
// changes never rewrite history.
//
// This is deliberately SEPARATE from the marketplace commission engine in
// src/lib/commissions.js — do not mix them.
const db = require('../db');

// Load one artist, scoped to the shop. Throws when it is not theirs.
async function getArtist(shopUserId, artistId) {
  const artist = await db.get(
    'SELECT * FROM shop_artists WHERE id = ? AND shop_user_id = ?',
    [String(artistId), String(shopUserId)]);
  if (!artist) throw new Error('Artist not found.');
  return artist;
}

async function createArtist({ shopUserId, name, commissionRatePct = 60 }) {
  const nm = String(name || '').trim().slice(0, 120);
  if (!nm) throw new Error('Artist name is required.');
  const rate = Math.max(0, Math.min(100, parseInt(commissionRatePct, 10) || 0));
  return db.insert('shop_artists', {
    shop_user_id: String(shopUserId), name: nm,
    commission_rate_pct: rate, active: 1,
  });
}

async function getArtists(shopUserId, { includeInactive = false } = {}) {
  return db.all(
    `SELECT * FROM shop_artists WHERE shop_user_id = ?
     ${includeInactive ? '' : 'AND active = 1 '}
     ORDER BY name ASC`,
    [String(shopUserId)]);
}

async function updateArtist({ shopUserId, artistId, name, commissionRatePct }) {
  const artist = await getArtist(shopUserId, artistId);
  const patch = {};
  if (name !== undefined) {
    const nm = String(name).trim().slice(0, 120);
    if (!nm) throw new Error('Artist name is required.');
    patch.name = nm;
  }
  if (commissionRatePct !== undefined && commissionRatePct !== '') {
    patch.commission_rate_pct = Math.max(0, Math.min(100, parseInt(commissionRatePct, 10) || 0));
  }
  if (Object.keys(patch).length) await db.update('shop_artists', artist.id, patch);
  return db.get('SELECT * FROM shop_artists WHERE id = ?', [artist.id]);
}

async function deactivateArtist({ shopUserId, artistId }) {
  const artist = await getArtist(shopUserId, artistId);
  await db.update('shop_artists', artist.id, { active: 0 });
  return true;
}

async function reactivateArtist({ shopUserId, artistId }) {
  const artist = await getArtist(shopUserId, artistId);
  await db.update('shop_artists', artist.id, { active: 1 });
  return true;
}

// Log one earning: split computed from the artist's CURRENT rate, then
// frozen on the row. Returns the new earning row id.
async function logEarning(shopUserId, artistId, amountCents, bookingId = null, note = null) {
  const artist = await getArtist(shopUserId, artistId);
  const total = Math.round(Number(amountCents));
  if (!Number.isFinite(total) || total <= 0) throw new Error('Amount must be a positive number of cents.');
  const artistShare = Math.round((total * artist.commission_rate_pct) / 100);
  const shopShare = total - artistShare;
  return db.insert('shop_artist_earnings', {
    shop_user_id: String(shopUserId),
    artist_id: artist.id,
    booking_id: bookingId ? String(bookingId) : null,
    amount_cents: total,
    artist_share_cents: artistShare,
    shop_share_cents: shopShare,
    note: String(note || '').trim().slice(0, 500) || null,
    earned_at: Date.now(),
  });
}

async function getEarnings(shopUserId, fromTs = null, toTs = null, artistId = null) {
  const where = ['e.shop_user_id = ?'];
  const params = [String(shopUserId)];
  if (fromTs != null) { where.push('e.earned_at >= ?'); params.push(Number(fromTs)); }
  if (toTs != null) { where.push('e.earned_at < ?'); params.push(Number(toTs)); }
  if (artistId) { where.push('e.artist_id = ?'); params.push(String(artistId)); }
  return db.all(
    `SELECT e.*, a.name AS artist_name FROM shop_artist_earnings e
     JOIN shop_artists a ON a.id = e.artist_id
     WHERE ${where.join(' AND ')}
     ORDER BY e.earned_at DESC`,
    params);
}

// Per-artist totals for a period, plus shop-wide totals. Computed in JS to
// stay dialect-neutral (one SQL dialect for both pg and sqlite).
async function getArtistTotals(shopUserId, fromTs = null, toTs = null) {
  const earnings = await getEarnings(shopUserId, fromTs, toTs);
  const byArtist = new Map();
  const totals = { amount_cents: 0, artist_share_cents: 0, shop_share_cents: 0, entries: 0 };
  for (const e of earnings) {
    if (!byArtist.has(e.artist_id)) {
      byArtist.set(e.artist_id, {
        artist_id: e.artist_id, artist_name: e.artist_name,
        amount_cents: 0, artist_share_cents: 0, shop_share_cents: 0, entries: 0,
      });
    }
    const t = byArtist.get(e.artist_id);
    t.amount_cents += e.amount_cents;
    t.artist_share_cents += e.artist_share_cents;
    t.shop_share_cents += e.shop_share_cents;
    t.entries += 1;
    totals.amount_cents += e.amount_cents;
    totals.artist_share_cents += e.artist_share_cents;
    totals.shop_share_cents += e.shop_share_cents;
    totals.entries += 1;
  }
  const artists = [...byArtist.values()].sort((a, b) => b.amount_cents - a.amount_cents);
  return { artists, totals };
}

module.exports = {
  getArtist, createArtist, getArtists, updateArtist,
  deactivateArtist, reactivateArtist,
  logEarning, getEarnings, getArtistTotals,
};
