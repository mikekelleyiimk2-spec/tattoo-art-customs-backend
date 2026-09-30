// Founding Members launch program.
//
// - Founding design artists (first 50 to activate a paid artist
//   subscription): 70% commission instead of 60% for 6 months. The owner
//   funds the boost — the +10pts come from the owner share first, then
//   the site share (both become 0% on those sales).
// - Founding tattoo shops (first 100): $79.99 first year instead of $99.99,
//   plus 25% referral commission instead of 20% for 6 months (the extra
//   5pts come from the owner's share).
// - Opening Raffle: anyone who creates a free account while entries are
//   open gets exactly one entry. Entries run at least through November 29,
//   2026; after that the raffle closes when it hits 1,000,000 entries or
//   $2,700 in owner subscription profits. Drawing within 7 days of close,
//   announced publicly. Draw: 1 grand prize (winner's choice of any
//   premade design + 1 free month of site membership), 2 runners-up (one
//   free premade design of their choice each).
//
// Caps are enforced inside a real transaction with row locks
// (db.transaction: SELECT ... FOR UPDATE on Postgres, BEGIN IMMEDIATE on
// SQLite), so concurrent claims can neither oversell the cap nor
// double-count the same user. Rolls back on error.
const crypto = require('crypto');
const db = require('../db');

const FOUNDING_ARTIST_CAP = 50;
const FOUNDING_SHOP_CAP = 100;
const FOUNDING_BOOST_MS = 6 * 30 * 86400000; // ~6 months
// --- Opening Raffle (free entry, long campaign) ---
// Entries are open from launch and run at least through November 29, 2026
// (November is CST = UTC-6, so the minimum close is Nov 30 05:59:59 UTC).
// After that date the raffle closes when ANY of the close conditions hits:
// 1,000,000 entries, or $2,700 in owner subscription profits. The drawing
// happens within 7 days of close; winners are announced publicly.
const RAFFLE_ENTRY_MIN_CLOSE_AT = Date.UTC(2026, 10, 30, 5, 59, 59);
const RAFFLE_ENTRY_TARGET = 1000000;
const RAFFLE_OWNER_PROFIT_TARGET_CENTS = 270000; // $2,700
const RAFFLE_FREE_MONTH_MS = 30 * 86400000; // grand prize: 1 free month

// Owner's subscription-profit meter for the raffle close condition.
// Reads the subscription_revenue ledger (migration 042): every recorded
// subscription payment contributes its owner share. Returns 0 (not null)
// once the ledger exists — the profit condition is live.
async function raffleOwnerSubscriptionProfits() {
  try {
    return await require('./subscriptionRevenue').ownerSubscriptionProfitsCents();
  } catch (e) {
    // Ledger table missing (very old DB before migrations ran) — treat the
    // condition as unknown rather than closed.
    return null;
  }
}

// Are raffle entries currently open? Closed once drawn. Otherwise open at
// least until the minimum close date; after that, closed when any close
// condition (1M entries or $2,700 owner subscription profits) is met.
async function raffleEntriesOpen(now = Date.now()) {
  const drawn = await db.get(`SELECT id FROM raffle_entries WHERE drawn_at IS NOT NULL LIMIT 1`);
  if (drawn) return { open: false, reason: 'already drawn' };
  const { n } = await db.get(`SELECT COUNT(*) AS n FROM raffle_entries`);
  const info = { entries: n, minClosesAt: RAFFLE_ENTRY_MIN_CLOSE_AT,
    entryTarget: RAFFLE_ENTRY_TARGET, profitTargetCents: RAFFLE_OWNER_PROFIT_TARGET_CENTS };
  if (now < RAFFLE_ENTRY_MIN_CLOSE_AT) return { open: true, ...info };
  if (n >= RAFFLE_ENTRY_TARGET) return { open: false, reason: 'entry target reached', ...info };
  const profits = await raffleOwnerSubscriptionProfits();
  if (profits != null && profits >= RAFFLE_OWNER_PROFIT_TARGET_CENTS) {
    return { open: false, reason: 'profit target reached', ...info, ownerSubProfits: profits };
  }
  return { open: true, reason: 'extended — close conditions not yet met', ...info, ownerSubProfits: profits };
}

// --- Counters / status ---
async function getFoundingStatus(now = Date.now()) {
  const c = await db.get(`SELECT artists_claimed, shops_claimed FROM founding_counters WHERE id = 'global'`);
  const entries = await db.get(`SELECT COUNT(*) AS n FROM raffle_entries`);
  const drawn = await db.get(`SELECT COUNT(*) AS n FROM raffle_entries WHERE drawn_at IS NOT NULL`);
  const open = (await raffleEntriesOpen(now)).open;
  return {
    artistsClaimed: c ? c.artists_claimed : 0,
    shopsClaimed: c ? c.shops_claimed : 0,
    artistsLeft: Math.max(0, FOUNDING_ARTIST_CAP - (c ? c.artists_claimed : 0)),
    shopsLeft: Math.max(0, FOUNDING_SHOP_CAP - (c ? c.shops_claimed : 0)),
    raffleEntries: entries.n,
    raffleDrawn: drawn.n > 0,
    raffleOpen: open,
    raffleMinClosesAt: RAFFLE_ENTRY_MIN_CLOSE_AT,
    raffleEntryTarget: RAFFLE_ENTRY_TARGET,
    raffleProfitTargetCents: RAFFLE_OWNER_PROFIT_TARGET_CENTS,
  };
}

async function foundingArtistsAvailable() {
  const c = await db.get(`SELECT artists_claimed FROM founding_counters WHERE id = 'global'`);
  return (c ? c.artists_claimed : 0) < FOUNDING_ARTIST_CAP;
}

async function foundingShopsAvailable() {
  const c = await db.get(`SELECT shops_claimed FROM founding_counters WHERE id = 'global'`);
  return (c ? c.shops_claimed : 0) < FOUNDING_SHOP_CAP;
}

// Is this user's founding-artist boost currently active?
async function foundingArtistActive(userId, now = Date.now()) {
  const u = await db.get('SELECT is_founding_artist, founding_artist_ends_at FROM users WHERE id = ?', [userId]);
  return !!(u && u.is_founding_artist && u.founding_artist_ends_at && u.founding_artist_ends_at > now);
}

// Is this shop's founding boost currently active?
async function foundingShopActive(userId, now = Date.now()) {
  const u = await db.get('SELECT is_founding_shop, founding_shop_ends_at FROM users WHERE id = ?', [userId]);
  return !!(u && u.is_founding_shop && u.founding_shop_ends_at && u.founding_shop_ends_at > now);
}

// --- Claims (cap-enforced, idempotent per user) ---
// The whole check-and-claim runs inside a real transaction with row locks
// (SELECT ... FOR UPDATE on Postgres, BEGIN IMMEDIATE on SQLite), so
// concurrent claims can neither oversell the cap nor double-count the
// same user. Idempotent: re-claiming returns { claimed: true, already: true }.
async function claimFoundingArtist(userId, now = Date.now()) {
  return db.transaction(async (tx) => {
    const lock = db.getMode() === 'pg' ? ' FOR UPDATE' : '';
    const u = await tx.get(`SELECT is_founding_artist FROM users WHERE id = ?${lock}`, [userId]);
    if (!u) return { claimed: false, reason: 'no user' };
    if (u.is_founding_artist) return { claimed: true, already: true };
    const c = await tx.get(`SELECT artists_claimed FROM founding_counters WHERE id = 'global'${lock}`);
    if (!c || c.artists_claimed >= FOUNDING_ARTIST_CAP) return { claimed: false, reason: 'cap filled' };
    await tx.query(`UPDATE founding_counters SET artists_claimed = artists_claimed + 1 WHERE id = 'global'`);
    await tx.query(`UPDATE users SET is_founding_artist = 1, founding_artist_ends_at = ? WHERE id = ?`,
      [now + FOUNDING_BOOST_MS, userId]);
    return { claimed: true };
  });
}

async function claimFoundingShop(userId, now = Date.now()) {
  return db.transaction(async (tx) => {
    const lock = db.getMode() === 'pg' ? ' FOR UPDATE' : '';
    const u = await tx.get(`SELECT is_founding_shop FROM users WHERE id = ?${lock}`, [userId]);
    if (!u) return { claimed: false, reason: 'no user' };
    if (u.is_founding_shop) return { claimed: true, already: true };
    const c = await tx.get(`SELECT shops_claimed FROM founding_counters WHERE id = 'global'${lock}`);
    if (!c || c.shops_claimed >= FOUNDING_SHOP_CAP) return { claimed: false, reason: 'cap filled' };
    await tx.query(`UPDATE founding_counters SET shops_claimed = shops_claimed + 1 WHERE id = 'global'`);
    await tx.query(`UPDATE users SET is_founding_shop = 1, founding_shop_ends_at = ? WHERE id = ?`,
      [now + FOUNDING_BOOST_MS, userId]);
    return { claimed: true };
  });
}

// --- Raffle ---
// One entry per user, ever (UNIQUE on user_id), granted automatically when
// a free account is created while entries are open. Safe to call twice —
// the second call is a no-op.
async function enterRaffleOnSignup(userId, now = Date.now()) {
  const open = await raffleEntriesOpen(now);
  if (!open.open) return { entered: false, reason: open.reason };
  try {
    await db.insert('raffle_entries', { user_id: userId, entered_at: now });
    return { entered: true };
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return { entered: false, reason: 'already entered' };
    throw e;
  }
}

// Draw the raffle: grand prize first, then 2 runners-up.
// One prize per user. Throws if the raffle was already drawn.
async function drawRaffle({ now = Date.now() } = {}) {
  const already = await db.get(`SELECT id FROM raffle_entries WHERE drawn_at IS NOT NULL LIMIT 1`);
  if (already) throw new Error('The raffle has already been drawn.');
  const entries = await db.all(
    `SELECT * FROM raffle_entries WHERE prize_won IS NULL ORDER BY entered_at ASC`);
  if (!entries.length) throw new Error('There are no raffle entries to draw.');

  // Fisher-Yates shuffle with cryptographic randomness.
  const pool = entries.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const winners = [];
  const award = async (entry, prize, fulfill) => {
    await fulfill(entry);
    await db.update('raffle_entries', entry.id, { prize_won: prize, drawn_at: now });
    winners.push({ user_id: entry.user_id, prize });
  };

  // Lazily required to avoid load-time cycles (colorization used by
  // referrals, etc.).
  const { sendConversation } = require('./colorization');
  const { sendMail } = require('./mail');
  const { ownerUserId } = require('./commissions');

  const notify = async (entry, subject, body) => {
    const user = await db.get('SELECT id, email, display_name FROM users WHERE id = ?', [entry.user_id]);
    if (!user) return;
    try {
      const ownerId = await ownerUserId();
      await sendConversation({ userIds: [user.id], subject, body, senderId: ownerId || user.id });
    } catch (e) { console.error('raffle on-site notice failed:', e.message); }
    if (user.email) {
      try { await sendMail({ to: user.email, subject, text: body }); }
      catch (e) { console.error('raffle email failed:', e.message); }
    }
  };

  // Grand prize: winner's choice of ANY premade design (full color +
  // clean linework, delivered by the owner) plus one free month of site
  // membership. The premade is fulfilled manually by the owner once the
  // winner names their design; the free month uses the same
  // membership_extended_until machinery as referral free months.
  if (pool.length >= 1) {
    await award(pool[0], 'grand', async (entry) => {
      const u = await db.get('SELECT membership_extended_until FROM users WHERE id = ?', [entry.user_id]);
      const base = Math.max(now, (u && u.membership_extended_until) || 0);
      const until = base + RAFFLE_FREE_MONTH_MS;
      await db.update('users', entry.user_id, { membership_extended_until: until });
      await notify(entry, 'You won the Tattoo Art Customs Opening Raffle grand prize!',
        'Congratulations! You won the GRAND PRIZE in the Tattoo Art Customs Opening Raffle:\n\n' +
        '- Any premade design of your choice (full color + clean linework, delivered to you)\n' +
        '- One free month of site membership (active through ' + new Date(until).toLocaleDateString() + ')\n\n' +
        'Reply to this message with the premade design you want and we will deliver your files.\n\n' +
        'Warmly,\nTattoo Art Customs');
    });
  }
  // Runners-up (2): one free premade design of their choice each.
  for (const entry of pool.slice(1, 3)) {
    await award(entry, 'runnerup', async (e2) => {
      await notify(e2, 'You won a premade design in the Tattoo Art Customs Opening Raffle!',
        'Congratulations! You are a RUNNER-UP in the Tattoo Art Customs Opening Raffle.\n\n' +
        'You won a free premade design of your choice (full color + clean linework, delivered to you).\n\n' +
        'Reply to this message with the design you want and we will deliver your files.\n\n' +
        'Warmly,\nTattoo Art Customs');
    });
  }
  return { winners };
}

module.exports = {
  FOUNDING_ARTIST_CAP, FOUNDING_SHOP_CAP, FOUNDING_BOOST_MS,
  RAFFLE_ENTRY_MIN_CLOSE_AT, RAFFLE_ENTRY_TARGET, RAFFLE_OWNER_PROFIT_TARGET_CENTS,
  RAFFLE_FREE_MONTH_MS,
  raffleEntriesOpen, getFoundingStatus,
  foundingArtistsAvailable, foundingShopsAvailable,
  foundingArtistActive, foundingShopActive,
  claimFoundingArtist, claimFoundingShop,
  enterRaffleOnSignup, drawRaffle,
  raffleOwnerSubscriptionProfits,
};
