// Founding Members launch program.
//
// - Founding design artists (first 50 to activate a paid artist
//   subscription): 70% commission instead of 60% for 6 months. The owner
//   funds the boost — the owner's 10% split becomes 0% on those sales.
// - Founding tattoo shops (first 100): $79.99 first year instead of $99.99,
//   plus 25% referral commission instead of 20% for 6 months (the extra
//   5pts come from the owner's share).
// - Early Subscriber Raffle: anyone whose FIRST subscription activates
//   inside the raffle window gets exactly one entry. Draw: 1 grand prize
//   (free custom design), 3 annual prizes (12-month membership extension),
//   10 credit prizes ($25 site credit).
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
const RAFFLE_WINDOW_MS = 60 * 86400000; // 60 days from launch
const RAFFLE_GRAND_CENTS = 15000; // free custom design ($150 value)
const RAFFLE_CREDIT_CENTS = 2500; // $25 site credit
const ANNUAL_PRIZE_MS = 365 * 86400000; // 12 months

// --- Raffle window ---
// Admin-settable via settings.raffle_ends_at (unix-ms). Default: 60 days
// after the founding-program migration was applied (the launch).
async function getRaffleEndsAt() {
  const row = await db.get(`SELECT value FROM settings WHERE key = 'raffle_ends_at'`);
  if (row && /^\d+$/.test(String(row.value))) return parseInt(row.value, 10);
  const mig = await db.get(`SELECT applied_at FROM migrations WHERE id = '019_founding_program.sql'`);
  const launch = mig && mig.applied_at ? mig.applied_at : Date.now();
  return launch + RAFFLE_WINDOW_MS;
}

async function setRaffleEndsAt(ts) {
  if (!Number.isInteger(ts) || ts <= 0) throw new Error('Invalid raffle end date.');
  // Manual upsert: the settings table's PK is `key` (no `id` column), so
  // db.upsert/db.insert can't be used here (they inject an id).
  const existing = await db.get(`SELECT key FROM settings WHERE key = 'raffle_ends_at'`);
  if (existing) {
    await db.updateWhere('settings', { value: String(ts) }, 'key', 'raffle_ends_at');
  } else {
    await db.query(`INSERT INTO settings (key, value) VALUES ('raffle_ends_at', ?)`, [String(ts)]);
  }
}

// --- Counters / status ---
async function getFoundingStatus() {
  const c = await db.get(`SELECT artists_claimed, shops_claimed FROM founding_counters WHERE id = 'global'`);
  const entries = await db.get(`SELECT COUNT(*) AS n FROM raffle_entries`);
  const drawn = await db.get(`SELECT COUNT(*) AS n FROM raffle_entries WHERE drawn_at IS NOT NULL`);
  return {
    artistsClaimed: c ? c.artists_claimed : 0,
    shopsClaimed: c ? c.shops_claimed : 0,
    artistsLeft: Math.max(0, FOUNDING_ARTIST_CAP - (c ? c.artists_claimed : 0)),
    shopsLeft: Math.max(0, FOUNDING_SHOP_CAP - (c ? c.shops_claimed : 0)),
    raffleEndsAt: await getRaffleEndsAt(),
    raffleEntries: entries.n,
    raffleDrawn: drawn.n > 0,
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
// One entry per user, ever (UNIQUE on user_id), only when their FIRST
// subscription activates inside the raffle window. Safe to call from both
// the approve flow and the PayPal webhook — the second call is a no-op.
async function maybeEnterRaffle(userId, subscriptionId, now = Date.now()) {
  if (now > await getRaffleEndsAt()) return { entered: false, reason: 'window closed' };
  const other = await db.get(
    `SELECT id FROM subscriptions WHERE user_id = ? AND id != ? AND status != 'pending' LIMIT 1`,
    [userId, subscriptionId]);
  if (other) return { entered: false, reason: 'not first subscription' };
  try {
    await db.insert('raffle_entries', { user_id: userId, entered_at: now });
    return { entered: true };
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return { entered: false, reason: 'already entered' };
    throw e;
  }
}

// Draw the raffle: grand prize first, then 3 annual, then 10 credit.
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

  // Lazily required to avoid load-time cycles (credits -> commissions ->
  // founding, colorization used by referrals, etc.).
  const { routeCustomOrder } = require('./customFulfillment');
  const { addCredit } = require('./credits');
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

  // Grand prize: a $0 custom-design order routed into the normal 48-hour
  // fulfillment pipeline (the winner provides their brief via messages).
  if (pool.length >= 1) {
    await award(pool[0], 'grand', async (entry) => {
      const orderId = await db.insert('orders', {
        buyer_id: entry.user_id, order_type: 'custom',
        amount_cents: RAFFLE_GRAND_CENTS, deposit_cents: 0, amount_paid_cents: 0,
        status: 'paid', payment_method: 'raffle_prize',
        custom_brief: 'RAFFLE GRAND PRIZE — free custom tattoo design. Winner: please send your design brief via Messages.',
        delivery_due: now + 48 * 3600000, custom_status: 'new',
      });
      const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
      await routeCustomOrder(order);
      await notify(entry, 'You won the Tattoo Art Customs raffle grand prize!',
        `Congratulations! You won a FREE custom tattoo design (a $150 value) in the early-subscriber raffle.\n\n` +
        `Reply to this message with your design brief and our artists will deliver your custom piece within 48 hours.\n\n` +
        `Warmly,\nTattoo Art Customs`);
    });
  }
  // Annual prizes: 12-month membership extension (uses the same
  // membership_extended_until machinery as referral free months).
  for (const entry of pool.slice(1, 4)) {
    await award(entry, 'annual', async (e2) => {
      const u = await db.get('SELECT membership_extended_until FROM users WHERE id = ?', [e2.user_id]);
      const base = Math.max(now, (u && u.membership_extended_until) || 0);
      const until = base + ANNUAL_PRIZE_MS;
      await db.update('users', e2.user_id, { membership_extended_until: until });
      await notify(e2, 'You won a free year of membership!',
        `Congratulations! You won a FREE YEAR of your Tattoo Art Customs membership in the early-subscriber raffle.\n\n` +
        `Your membership is now active through ${new Date(until).toLocaleDateString()}. ` +
        `If you pay via PayPal you may cancel the recurring billing — your membership stays active through that date.\n\n` +
        `Warmly,\nTattoo Art Customs`);
    });
  }
  // Credit prizes: $25 site credit via the wallet ledger.
  for (const entry of pool.slice(4, 14)) {
    await award(entry, 'credit', async (e3) => {
      await addCredit({
        userId: e3.user_id, amountCents: RAFFLE_CREDIT_CENTS,
        kind: 'raffle_prize', note: 'Early-subscriber raffle — $25 site credit',
      });
      await notify(e3, 'You won $25 in site credit!',
        `Congratulations! You won $25 in Tattoo Art Customs site credit in the early-subscriber raffle.\n\n` +
        `The credit is in your wallet now and works toward any design or custom order.\n\n` +
        `Warmly,\nTattoo Art Customs`);
    });
  }
  return { winners };
}

module.exports = {
  FOUNDING_ARTIST_CAP, FOUNDING_SHOP_CAP, FOUNDING_BOOST_MS, RAFFLE_WINDOW_MS,
  getRaffleEndsAt, setRaffleEndsAt, getFoundingStatus,
  foundingArtistsAvailable, foundingShopsAvailable,
  foundingArtistActive, foundingShopActive,
  claimFoundingArtist, claimFoundingShop,
  maybeEnterRaffle, drawRaffle,
};
