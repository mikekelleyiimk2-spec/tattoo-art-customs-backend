// Holiday Doodle Raffle (Dec 2026) — entry ledger, drawing, prize codes.
//
// Separate from the opening raffle in lib/founding.js (different tables,
// different rules). Entries are earned three ways:
//   - 20 entries per customer-plan membership payment ('customer',
//     'customer_annual'), hooked in recordSubscriptionRevenue()
//   - 5 entries per paid order (any order_type except 'raffle_entries'),
//     hooked wherever orders reach 'paid'
//   - direct entry-pack purchase: 1/$1, 10/$5, 25/$10 via /holiday-raffle/enter
// Prize: 1 winner per 100 total entries. Each winner gets a RAFFLE-XXXXXX
// code redeemable for one free doodle-to-merchandise item (tee or print).
const db = require('../db');

const ENTRIES_PER_MEMBERSHIP = 20;
const ENTRIES_PER_PURCHASE = 5;
const ENTRIES_PER_WINNER = 100;

// Entry packs: fee-inclusive totals are exactly $1 / $5 / $10.
const ENTRY_PACKS = [
  { id: 'pack1', entries: 1, baseCents: 49, label: '1 entry' },
  { id: 'pack10', entries: 10, baseCents: 436, label: '10 entries' },
  { id: 'pack25', entries: 25, baseCents: 919, label: '25 entries' },
];

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeRaffleCode() {
  let s = '';
  for (let i = 0; i < 6; i += 1) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `RAFFLE-${s}`;
}

async function getOpenRaffle(now) {
  const t = now == null ? db.now() : now;
  return db.get(
    `SELECT * FROM holiday_raffles WHERE status = 'open' AND ends_at > ? ORDER BY ends_at ASC LIMIT 1`,
    [t]
  );
}

async function getRaffleById(id) {
  return db.get('SELECT * FROM holiday_raffles WHERE id = ?', [id]);
}

// Idempotent entry award: one row per (raffle, source, source_ref).
async function awardEntries({ raffleId, userId, entries, source, sourceRef }) {
  if (!raffleId || !userId || !entries || entries <= 0) return { awarded: false, reason: 'invalid' };
  try {
    await db.insert('holiday_raffle_entries', {
      id: db.newId(),
      raffle_id: raffleId,
      user_id: userId,
      entries: Math.round(entries),
      source: String(source).slice(0, 32),
      source_ref: String(sourceRef).slice(0, 200),
      created_at: db.now(),
    });
    return { awarded: true, entries: Math.round(entries) };
  } catch (e) {
    if (/unique/i.test(e.message || '')) return { awarded: false, reason: 'duplicate' };
    throw e;
  }
}

async function awardMembershipEntries({ userId, planSlug, providerRef }) {
  if (!['customer', 'customer_annual'].includes(String(planSlug))) return { awarded: false, reason: 'not_customer_plan' };
  const raffle = await getOpenRaffle();
  if (!raffle) return { awarded: false, reason: 'no_open_raffle' };
  return awardEntries({
    raffleId: raffle.id, userId, entries: ENTRIES_PER_MEMBERSHIP,
    source: 'membership', sourceRef: `membership:${providerRef}`,
  });
}

// 5 entries per paid order. Entry-pack orders credit their bundle instead
// (never the 5 purchase entries — avoids double counting).
async function awardPurchaseEntries(order) {
  if (!order || order.status !== 'paid' || !order.buyer_id) return { awarded: false, reason: 'not_paid' };
  const raffle = await getOpenRaffle();
  if (!raffle) return { awarded: false, reason: 'no_open_raffle' };
  if (order.order_type === 'raffle_entries') {
    const bought = Number(order.raffle_entries_bought || 0);
    if (bought <= 0) return { awarded: false, reason: 'no_bundle' };
    return awardEntries({
      raffleId: raffle.id, userId: order.buyer_id, entries: bought,
      source: 'direct', sourceRef: `order:${order.id}`,
    });
  }
  return awardEntries({
    raffleId: raffle.id, userId: order.buyer_id, entries: ENTRIES_PER_PURCHASE,
    source: 'purchase', sourceRef: `order:${order.id}`,
  });
}

async function totalEntries(raffleId) {
  const r = await db.get(
    'SELECT COALESCE(SUM(entries),0) AS t FROM holiday_raffle_entries WHERE raffle_id = ?', [raffleId]);
  return Number(r.t || 0);
}

async function userEntries(raffleId, userId) {
  const r = await db.get(
    'SELECT COALESCE(SUM(entries),0) AS t FROM holiday_raffle_entries WHERE raffle_id = ? AND user_id = ?',
    [raffleId, userId]);
  return Number(r.t || 0);
}

// Weighted random draw: winners = floor(total / 100). Each winner gets a
// unique RAFFLE-XXXXXX prize code. Marks the raffle 'drawn'.
async function drawWinners(raffleId) {
  const raffle = await getRaffleById(raffleId);
  if (!raffle) throw new Error('Raffle not found.');
  if (raffle.status === 'drawn') throw new Error('Raffle already drawn.');
  const total = await totalEntries(raffleId);
  const winnerCount = Math.floor(total / ENTRIES_PER_WINNER);
  if (winnerCount <= 0) throw new Error(`Not enough entries for a prize (need ${ENTRIES_PER_WINNER}, have ${total}).`);
  // Build a weighted ticket pool: one ticket per entry.
  const rows = await db.all(
    `SELECT user_id, SUM(entries) AS entries FROM holiday_raffle_entries
     WHERE raffle_id = ? GROUP BY user_id HAVING SUM(entries) > 0`, [raffleId]);
  const pool = [];
  for (const r of rows) {
    for (let i = 0; i < Number(r.entries); i += 1) pool.push(r.user_id);
  }
  // Fisher-Yates shuffle, then take distinct winners in order.
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const winners = [];
  const seen = new Set();
  for (const userId of pool) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    winners.push(userId);
    if (winners.length >= winnerCount) break;
  }
  const drawnAt = db.now();
  const results = [];
  for (const userId of winners) {
    let code = makeRaffleCode();
    // Guarantee uniqueness against a (very unlikely) collision.
    while (await db.get('SELECT id FROM holiday_raffle_codes WHERE code = ?', [code])) {
      code = makeRaffleCode();
    }
    const winnerId = db.newId();
    const snapshot = await userEntries(raffleId, userId);
    await db.insert('holiday_raffle_winners', {
      id: winnerId, raffle_id: raffleId, user_id: userId,
      entries_snapshot: snapshot, code, drawn_at: drawnAt,
    });
    await db.insert('holiday_raffle_codes', {
      id: db.newId(), code, raffle_id: raffleId, winner_id: winnerId,
      consumed: 0, consumed_at: null, created_at: drawnAt,
    });
    results.push({ userId, code, entries: snapshot });
  }
  await db.update('holiday_raffles', raffleId, { status: 'drawn' });
  return { winners: results, totalEntries: total };
}

// Prize-code validation for the /doodle-to-tattoo redemption field.
async function validatePrizeCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return { ok: false, reason: 'empty' };
  const row = await db.get('SELECT * FROM holiday_raffle_codes WHERE code = ?', [c]);
  if (!row) return { ok: false, reason: 'unknown' };
  if (Number(row.consumed)) return { ok: false, reason: 'consumed' };
  return { ok: true, code: row.code, row };
}

async function consumePrizeCode(code, orderId) {
  const v = await validatePrizeCode(code);
  if (!v.ok) return v;
  await db.update('holiday_raffle_codes', v.row.id, { consumed: 1, consumed_at: db.now() });
  return { ok: true, code: v.code, orderId };
}

module.exports = {
  ENTRIES_PER_MEMBERSHIP,
  ENTRIES_PER_PURCHASE,
  ENTRIES_PER_WINNER,
  ENTRY_PACKS,
  makeRaffleCode,
  getOpenRaffle,
  getRaffleById,
  awardEntries,
  awardMembershipEntries,
  awardPurchaseEntries,
  totalEntries,
  userEntries,
  drawWinners,
  validatePrizeCode,
  consumePrizeCode,
};
