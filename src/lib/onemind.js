// OneMind identity — the foundation (migration 110, owner law
// restated 2026-10-26). This backend IS OneMind: the hub where all
// the plugs run together. The OneMind app is one window into it.
// Every row in `users` is a OneMind account; `users.onemind_id` is
// the canonical seat id for that account across every surface.
//
// - ensureOneMindId: mint-once per account (existing accounts are
//   migrated by backfillOneMindIds at boot and lazily at sign-in —
//   no password changes, no lockouts, nothing user-visible breaks).
// - recordTie: the tie registry made literal — the moment an
//   account signs in on a tieable surface (src/lib/surfaces.js),
//   one row per account x surface records first_seated_at (written
//   once, never moves) and last_seen_at / signin_count (move on
//   every seating). Surfaces outside the registry — every kids'
//   surface included — are refused here, by construction.
// - seatSummary: the recognition payload. "If you've ever had
//   anything we make and later decide to get OneMind, it already
//   recognizes you" (owner, 2026-10-26): first-seated, surfaces,
//   tie count — what any surface (OneMind's first open included)
//   renders to greet a known seat instead of a sign-up wall.
//   Recognition is the default; introduction is the failure mode.
const crypto = require('crypto');
const db = require('../db');
const surfaces = require('./surfaces');

function mintOneMindId() {
  return 'om_' + crypto.randomBytes(12).toString('hex');
}

async function ensureOneMindId(userOrId) {
  const user = (userOrId && typeof userOrId === 'object')
    ? userOrId
    : await db.get('SELECT * FROM users WHERE id = ?', [userOrId]);
  if (!user) return null;
  if (user.onemind_id) return user.onemind_id;
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = mintOneMindId();
    try {
      await db.update('users', user.id, { onemind_id: id });
      return id;
    } catch (e) {
      if (!/unique|duplicate/i.test(String(e && e.message))) throw e;
    }
  }
  const fresh = await db.get('SELECT onemind_id FROM users WHERE id = ?', [user.id]);
  return (fresh && fresh.onemind_id) || null;
}

// Mint ids for every account that predates the foundation. Returns
// how many were minted; idempotent (a second pass mints none).
async function backfillOneMindIds() {
  const rows = await db.all("SELECT id FROM users WHERE onemind_id IS NULL OR onemind_id = ''");
  let minted = 0;
  for (const r of rows) {
    if (await ensureOneMindId(r.id)) minted++;
  }
  return minted;
}

// Seat every existing account on the website surface at its TRUE
// first-seated date. The migration population is the existing
// Tattoo Art Customs website accounts (owner directive 2026-10-26):
// their logins and passwords carry over as-is — this writes only a
// tie row, never touches a credential. An existing account's first
// sitting on the website WAS joining the website, so first_seated_at
// is the account's own created_at, not the migration moment.
// signin_count starts at 0: it counts foundation-era seatings, and
// the first real sign-in after migration bumps it to 1 through
// recordTie (first-seated never moves). Idempotent; reversible-safe
// (deleting the written rows undoes it; nothing else is mutated).
async function seatMigratedAccounts() {
  const rows = await db.all('SELECT id, created_at, role FROM users');
  let seated = 0;
  for (const u of rows) {
    const existing = await db.get(
      'SELECT id FROM account_ties WHERE user_id = ? AND surface = ?', [u.id, 'website']);
    if (existing) continue;
    const ts = Number(u.created_at) || db.now();
    try {
      await db.insert('account_ties', {
        user_id: u.id, surface: 'website', role: u.role || null,
        first_seated_at: ts, last_seen_at: ts, signin_count: 0,
      });
      seated++;
    } catch (e) {
      // Lost an insert race (concurrent boot/process) — the tie
      // exists, which is all this pass promises.
    }
  }
  return seated;
}

async function recordTie(userId, surfaceId) {
  if (!surfaces.isTieable(surfaceId)) {
    return { ok: false, error: 'surface_not_tieable', surface: surfaceId || null };
  }
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return { ok: false, error: 'unknown_account' };
  await ensureOneMindId(user);
  const now = db.now();
  // The role at THIS sitting (migration 112): roles stack on the
  // one seat, and the book records as-what alongside where.
  const role = user.role || null;
  const existing = await db.get(
    'SELECT * FROM account_ties WHERE user_id = ? AND surface = ?', [userId, surfaceId]);
  if (existing) {
    const count = Number(existing.signin_count || 0) + 1;
    await db.update('account_ties', existing.id, { last_seen_at: now, signin_count: count, role });
    return {
      ok: true,
      tie: {
        surface: surfaceId, role,
        first_seated_at: Number(existing.first_seated_at),
        last_seen_at: now,
        signin_count: count,
      },
    };
  }
  try {
    await db.insert('account_ties', {
      user_id: userId, surface: surfaceId, role,
      first_seated_at: now, last_seen_at: now, signin_count: 1,
    });
    return {
      ok: true,
      tie: { surface: surfaceId, role, first_seated_at: now, last_seen_at: now, signin_count: 1 },
    };
  } catch (e) {
    // A concurrent seating won the insert race; the row exists now.
    const row = await db.get(
      'SELECT * FROM account_ties WHERE user_id = ? AND surface = ?', [userId, surfaceId]);
    if (!row) throw e;
    const count = Number(row.signin_count || 0) + 1;
    await db.update('account_ties', row.id, { last_seen_at: now, signin_count: count, role });
    return {
      ok: true,
      tie: {
        surface: surfaceId, role,
        first_seated_at: Number(row.first_seated_at),
        last_seen_at: now,
        signin_count: count,
      },
    };
  }
}

// Best-effort seating for auth flows: a tie write must NEVER break a
// sign-in. Failures are logged, never thrown into the login path.
async function seatQuietly(userId, surfaceId) {
  try {
    return await recordTie(userId, surfaceId);
  } catch (e) {
    console.error('onemind tie write failed:', e.message);
    return { ok: false, error: 'tie_write_failed' };
  }
}

async function tiesFor(userId) {
  const rows = await db.all(
    'SELECT surface, role, first_seated_at, last_seen_at, signin_count FROM account_ties WHERE user_id = ? ORDER BY first_seated_at ASC',
    [userId]);
  return rows.map((t) => ({
    surface: t.surface,
    surface_name: (surfaces.surface(t.surface) || {}).name || t.surface,
    role: t.role || null,
    first_seated_at: Number(t.first_seated_at),
    last_seen_at: Number(t.last_seen_at),
    signin_count: Number(t.signin_count),
  }));
}

// The recognition payload for one account: who the seat is, when
// they first sat down ANYWHERE, and every surface holding their tie.
async function seatSummary(user) {
  const onemindId = await ensureOneMindId(user);
  const ties = await tiesFor(user.id);
  return {
    user_id: user.id,
    onemind_id: onemindId,
    email: user.email,
    display_name: user.display_name || '',
    role: user.role,
    recognized: ties.length > 0,
    first_seated_at: ties.length ? Math.min(...ties.map((t) => t.first_seated_at)) : null,
    tie_count: ties.length,
    surfaces: ties.map((t) => t.surface),
    ties,
  };
}

// The book view: aggregate ties per surface (no per-person data —
// emails and ids never leave through here). Read-only.
async function tieBook() {
  const rows = await db.all(
    `SELECT surface, COUNT(*) AS accounts, MIN(first_seated_at) AS first_seated_at,
            MAX(last_seen_at) AS last_seen_at, SUM(signin_count) AS signins
     FROM account_ties GROUP BY surface ORDER BY surface`);
  const totals = await db.get(
    'SELECT COUNT(*) AS ties, COUNT(DISTINCT user_id) AS accounts FROM account_ties');
  return {
    surfaces: rows.map((r) => ({
      surface: r.surface,
      surface_name: (surfaces.surface(r.surface) || {}).name || r.surface,
      accounts: Number(r.accounts || 0),
      signins: Number(r.signins || 0),
      first_seated_at: r.first_seated_at == null ? null : Number(r.first_seated_at),
      last_seen_at: r.last_seen_at == null ? null : Number(r.last_seen_at),
    })),
    total_ties: Number((totals && totals.ties) || 0),
    total_accounts: Number((totals && totals.accounts) || 0),
    tieable_surfaces: surfaces.list().map((s) => s.id),
  };
}

module.exports = {
  mintOneMindId, ensureOneMindId, backfillOneMindIds, seatMigratedAccounts,
  recordTie, seatQuietly, tiesFor, seatSummary, tieBook,
};
