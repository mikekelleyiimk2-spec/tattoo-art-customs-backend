// Brambleforce online features (migration 126; owner order
// 2026-11-03 — all four completeness features into 2.0.1): campaign
// progress roaming + the online arena leaderboard, both hanging off
// the seat the Chorvix doors already resolve (lib/seatVerify).
//
// PROGRESS ROAMING. One row per seat in bf_progress holding a
// whitelisted blob assembled by the game client from its local save
// (the shape is specced from the shipped game's save code — see
// docs/brambleforce-online-contract.md). The server sanitizes every
// write, merges it against the stored blob, and stores the MERGE —
// the merge is the conflict rule and it is monotonic:
//
//   FURTHEST-PROGRESS-WINS, NEVER A DOWNGRADE.
//   - campaign beaten flags: OR (beaten anywhere is beaten)
//   - sets (heroes that cleared, weapons used, echoes heard,
//     achievements unlocked, wardrobe owned, dauntless heroes,
//     season medals): union
//   - counters (kills, clears, matches, wins): max
//   - arena points within one season: max; across seasons the
//     LATER season's block is the base (a rollover's designed
//     point reset can never be resurrected by a stale device)
//   - time-attack bests: per-mission min (a faster time is
//     further progress)
//   - equip choices are PREFERENCES, not progress: they follow the
//     blob with the later client_updated_at
//
// Because the merge is monotonic, a PUT with a stale base_rev still
// lands safely — rev versions the writes for audit/echo, it is
// never a lock that can lose a player's progress. Signed-out play
// never reaches here at all (the client keeps its local save and
// simply doesn't call), and nothing in this module can throw a
// player's local state away.
//
// LEADERBOARD. Append-only match facts in bf_arena_results; the
// board is SUM(points_delta) per seat per season, computed from
// accepted facts — never from a client-sent total or name. The
// display name is read from the seat at read time
// (lib/onemind seatDisplayName, the rotation included).
const db = require('../db');
const onemind = require('./onemind');

const PROGRESS_V = 1;
const MAX_BLOB_BYTES = 65536;

// ---- small coercion helpers --------------------------------------
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function num(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt === undefined ? lo : dflt;
  return Math.min(hi, Math.max(lo, n));
}
function int(v, lo, hi, dflt) { return Math.floor(num(v, lo, hi, dflt)); }
function str(v, cap) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > cap) return null;
  return s;
}
// A {key: 1} flag set, whitelisted by shape only (the ids are the
// game's own vocabularies — fighters, weapons, items, prizes).
function flagSet(v, maxEntries = 256) {
  const out = {};
  if (!isObj(v)) return out;
  let n = 0;
  for (const k of Object.keys(v)) {
    if (n >= maxEntries) break;
    const key = str(k, 64);
    if (key && v[k]) { out[key] = 1; n++; }
  }
  return out;
}
function idList(v, maxEntries = 256) {
  const out = [];
  if (!Array.isArray(v)) return out;
  const seen = new Set();
  for (const item of v) {
    if (out.length >= maxEntries) break;
    const s = str(item, 64);
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}
function intList(v, maxEntries = 64) {
  const out = [];
  if (!Array.isArray(v)) return out;
  const seen = new Set();
  for (const item of v) {
    if (out.length >= maxEntries) break;
    const n = int(item, 0, 100000, -1);
    if (n >= 0 && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out.sort((a, b) => a - b);
}
// {charId: prizeId} equip maps — values are id strings or null.
function equipMap(v, maxEntries = 64) {
  const out = {};
  if (!isObj(v)) return out;
  let n = 0;
  for (const k of Object.keys(v)) {
    if (n >= maxEntries) break;
    const key = str(k, 64);
    if (!key) continue;
    const val = v[k] === null ? null : str(v[k], 64);
    if (v[k] === null || val) { out[key] = val; n++; }
  }
  return out;
}

// ---- the progress blob --------------------------------------------
// The whitelist IS the contract: fields not listed here are dropped
// on every write, so a blob can never smuggle server-foreign state
// (entitlements in particular — bf_ent_v1 is purchase state and
// already server truth in seat_entitlements; it is refused a ride).
function sanitizeProgress(input, nowMs) {
  const src = isObj(input) ? input : {};
  const achv = isObj(src.achv) ? src.achv : {};
  const prog = isObj(achv.prog) ? achv.prog : {};
  const royal = isObj(src.royal) ? src.royal : {};
  const ward = isObj(src.wardrobe) ? src.wardrobe : {};
  const beat = isObj(src.campaign_beat) ? src.campaign_beat : {};
  const ta = isObj(src.ta_best) ? src.ta_best : {};
  const taBest = {};
  for (const k of Object.keys(ta)) {
    const m = int(k, 1, 999, -1);
    const secs = num(ta[k], 0, 86400, 0);
    if (m > 0 && secs > 0) taBest[String(m)] = Math.round(secs * 10) / 10;
  }
  const medal = {};
  if (isObj(royal.medal)) {
    for (const k of Object.keys(royal.medal)) {
      const key = str(k, 64);
      if (key) medal[key] = intList(royal.medal[k]);
    }
  }
  let clientUpdatedAt = int(src.client_updated_at, 0, Number.MAX_SAFE_INTEGER, 0);
  if (clientUpdatedAt > nowMs + 300000) clientUpdatedAt = nowMs; // clock-skew clamp
  return {
    v: PROGRESS_V,
    client_updated_at: clientUpdatedAt,
    campaign_beat: { std: !!beat.std, hard: !!beat.hard },
    achv: {
      prog: {
        maul_elites: int(prog.maul_elites, 0, 10000000),
        stitch_kills: int(prog.stitch_kills, 0, 10000000),
        spore_kills: int(prog.spore_kills, 0, 10000000),
        coop_clears: int(prog.coop_clears, 0, 1000000),
        gag_clears: int(prog.gag_clears, 0, 1000000),
        fighters: flagSet(prog.fighters),
        campaigners: flagSet(prog.campaigners),
        swpn: flagSet(prog.swpn),
        echoes: flagSet(prog.echoes),
      },
      unlocked: idList(achv.unlocked),
      equip: {
        tracer: achv.equip && typeof achv.equip === 'object' ? (str(achv.equip.tracer, 64) || null) : null,
        pal: achv.equip && typeof achv.equip === 'object' ? equipMap(achv.equip.pal) : {},
      },
    },
    royal: {
      series: int(royal.series, 0, 99),
      season: int(royal.season, 1, 999, 1),
      seasonStart: int(royal.seasonStart, 0, Number.MAX_SAFE_INTEGER, 0),
      hp: int(royal.hp, 0, 1000000),
      vp: int(royal.vp, 0, 1000000),
      peakH: int(royal.peakH, 0, 99),
      peakV: int(royal.peakV, 0, 99),
      finishH: int(royal.finishH, -1, 99, -1),
      finishV: int(royal.finishV, -1, 99, -1),
      prestigeH: int(royal.prestigeH, 0, 1000000),
      prestigeV: int(royal.prestigeV, 0, 1000000),
      matches: int(royal.matches, 0, 1000000),
      heroWins: int(royal.heroWins, 0, 1000000),
      villainWins: int(royal.villainWins, 0, 1000000),
      deserts: int(royal.deserts, 0, 1000000),
      dauntless: flagSet(royal.dauntless),
      orchidNext: int(royal.orchidNext, 0, 1000),
      orchidBadges: int(royal.orchidBadges, 0, 1000000),
      medal,
    },
    wardrobe: {
      owned: flagSet(ward.owned, 512),
      equip: equipMap(ward.equip, 128),
      twice: flagSet(ward.twice, 512),
    },
    ta_best: taBest,
  };
}

function emptyProgress() { return sanitizeProgress({}, 0); }

function unionSet(a, b) { return { ...(a || {}), ...(b || {}) }; }
function unionList(a, b) {
  const out = [...(a || [])];
  const seen = new Set(out);
  for (const x of b || []) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}
function unionMedal(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    out[k] = [...new Set([...((a || {})[k] || []), ...((b || {})[k] || [])])].sort((x, y) => x - y);
  }
  return out;
}

// The merge. Both sides are sanitized blobs (or null). Monotonic in
// every progress field — see the header for the per-class rules.
function mergeProgress(stored, incoming) {
  const a = stored || emptyProgress();
  const b = incoming || emptyProgress();
  // Equip (a preference) follows the fresher client stamp.
  const fresh = b.client_updated_at >= a.client_updated_at ? b : a;
  // Royal: the later season's block is the base.
  const aKey = a.royal.series * 10000 + a.royal.season;
  const bKey = b.royal.series * 10000 + b.royal.season;
  const base = bKey >= aKey ? b : a;
  const other = base === b ? a : b;
  const sameSeason = aKey === bKey;
  const royal = { ...base.royal };
  royal.dauntless = unionSet(a.royal.dauntless, b.royal.dauntless);
  royal.medal = unionMedal(a.royal.medal, b.royal.medal);
  for (const k of ['matches', 'heroWins', 'villainWins', 'deserts', 'orchidBadges']) {
    royal[k] = Math.max(a.royal[k], b.royal[k]);
  }
  if (sameSeason) {
    for (const k of ['hp', 'vp', 'peakH', 'peakV', 'prestigeH', 'prestigeV']) {
      royal[k] = Math.max(a.royal[k], b.royal[k]);
    }
    // A recorded finish beats an unrecorded one; the active
    // season's start is the earlier of the two claims.
    if (royal.finishH < 0) royal.finishH = other.royal.finishH;
    if (royal.finishV < 0) royal.finishV = other.royal.finishV;
    royal.seasonStart = Math.min(a.royal.seasonStart || b.royal.seasonStart, b.royal.seasonStart || a.royal.seasonStart);
    royal.orchidNext = base.royal.orchidNext;
  }
  const taBest = {};
  for (const k of new Set([...Object.keys(a.ta_best), ...Object.keys(b.ta_best)])) {
    const av = a.ta_best[k], bv = b.ta_best[k];
    taBest[k] = av && bv ? Math.min(av, bv) : (av || bv);
  }
  return {
    v: PROGRESS_V,
    client_updated_at: Math.max(a.client_updated_at, b.client_updated_at),
    campaign_beat: {
      std: !!(a.campaign_beat.std || b.campaign_beat.std),
      hard: !!(a.campaign_beat.hard || b.campaign_beat.hard),
    },
    achv: {
      prog: {
        maul_elites: Math.max(a.achv.prog.maul_elites, b.achv.prog.maul_elites),
        stitch_kills: Math.max(a.achv.prog.stitch_kills, b.achv.prog.stitch_kills),
        spore_kills: Math.max(a.achv.prog.spore_kills, b.achv.prog.spore_kills),
        coop_clears: Math.max(a.achv.prog.coop_clears, b.achv.prog.coop_clears),
        gag_clears: Math.max(a.achv.prog.gag_clears, b.achv.prog.gag_clears),
        fighters: unionSet(a.achv.prog.fighters, b.achv.prog.fighters),
        campaigners: unionSet(a.achv.prog.campaigners, b.achv.prog.campaigners),
        swpn: unionSet(a.achv.prog.swpn, b.achv.prog.swpn),
        echoes: unionSet(a.achv.prog.echoes, b.achv.prog.echoes),
      },
      unlocked: unionList(a.achv.unlocked, b.achv.unlocked),
      equip: fresh.achv.equip,
    },
    royal,
    wardrobe: {
      owned: unionSet(a.wardrobe.owned, b.wardrobe.owned),
      equip: fresh.wardrobe.equip,
      twice: unionSet(a.wardrobe.twice, b.wardrobe.twice),
    },
    ta_best: taBest,
  };
}

async function getProgressRow(userId) {
  return db.get('SELECT * FROM bf_progress WHERE user_id = ?', [userId]);
}

async function getProgress(userId) {
  const row = await getProgressRow(userId);
  if (!row) return null;
  let blob = null;
  try { blob = JSON.parse(row.blob); } catch (e) { blob = null; }
  return { rev: Number(row.rev), updated_at: Number(row.updated_at), progress: blob };
}

// Save = sanitize the incoming blob, merge against the stored one,
// store the merge, rev + 1. Returns the merged truth the client
// should adopt locally.
async function putProgress(userId, rawBlob, baseRev) {
  const now = db.now();
  const incoming = sanitizeProgress(rawBlob, now);
  if (JSON.stringify(incoming).length > MAX_BLOB_BYTES) {
    return { ok: false, error: 'progress_too_large' };
  }
  const row = await getProgressRow(userId);
  let stored = null;
  if (row) { try { stored = JSON.parse(row.blob); } catch (e) { stored = null; } }
  const merged = mergeProgress(stored ? sanitizeProgress(stored, now) : null, incoming);
  const conflict = !!(row && baseRev !== null && baseRev !== undefined && Number(baseRev) !== Number(row.rev));
  const rev = row ? Number(row.rev) + 1 : 1;
  const blobJson = JSON.stringify(merged);
  if (row) {
    await db.query('UPDATE bf_progress SET v = ?, rev = ?, blob = ?, updated_at = ? WHERE user_id = ?',
      [PROGRESS_V, rev, blobJson, now, userId]);
  } else {
    await db.query('INSERT INTO bf_progress (user_id, v, rev, blob, updated_at) VALUES (?, ?, ?, ?, ?)',
      [userId, PROGRESS_V, rev, blobJson, now]);
  }
  return { ok: true, rev, updated_at: now, progress: merged, merged_from_conflict: conflict };
}

// ---- arena results + leaderboard -----------------------------------
// Sanity bounds are derived from the game's own scoring tables
// (arena.js: HERO_PLACE_PTS max 30, VILLAIN_PLACE_PTS max 30,
// WIN_BONUS 8, reclaim x1.5 on gains -> 57, plus re-cross stop
// bonuses; worst honest loss is the second desert -40, softened
// upward by floors). [-60, +100] accepts every honest receipt the
// shipped scoring can produce and refuses scripted nonsense.
const DELTA_MIN = -60;
const DELTA_MAX = 100;
const SUBMIT_MIN_GAP_MS = 2000;

function seasonKeyOf(series, season) { return `${series}_${season}`; }

function sanitizeResult(body) {
  const src = isObj(body) ? body : {};
  const matchId = str(src.match_id, 64);
  if (!matchId || !/^[A-Za-z0-9_-]+$/.test(matchId) || matchId.length < 8) {
    return { ok: false, error: 'bad_match_id' };
  }
  const ladder = src.ladder;
  if (ladder !== 'hero' && ladder !== 'villain') return { ok: false, error: 'bad_ladder' };
  const sideSize = int(src.side_size, 0, 1000000, -1);
  if (sideSize < 2 || sideSize > 15) return { ok: false, error: 'bad_side_size' };
  const place = int(src.place, 0, 1000000, -1);
  if (place < 1 || place > sideSize) return { ok: false, error: 'bad_place' };
  const desert = src.desert === true || src.desert === 1 || src.desert === '1';
  // The game's own rule (applyRankedResult): a deserter is scored
  // as last place on their side. A desert claim at any other place
  // is not a receipt the game can produce.
  if (desert && place !== sideSize) return { ok: false, error: 'bad_desert_place' };
  const won = src.won === true || src.won === 1 || src.won === '1';
  const delta = int(src.points_delta, DELTA_MIN - 1, DELTA_MAX + 1, DELTA_MIN - 1);
  if (delta < DELTA_MIN || delta > DELTA_MAX) return { ok: false, error: 'bad_points_delta' };
  const season = isObj(src.season) ? src.season : {};
  const series = int(season.series, 0, 99, -1);
  const seasonNo = int(season.season, 1, 999, -1);
  if (series < 0 || seasonNo < 1) return { ok: false, error: 'bad_season' };
  const claimedAfter = src.claimed_after === undefined || src.claimed_after === null
    ? null : int(src.claimed_after, 0, 1000000, -1);
  if (claimedAfter !== null && claimedAfter < 0) return { ok: false, error: 'bad_claimed_after' };
  return {
    ok: true,
    value: {
      match_id: matchId, ladder, place, side_size: sideSize,
      won: won ? 1 : 0, desert: desert ? 1 : 0, points_delta: delta,
      claimed_after: claimedAfter, season_key: seasonKeyOf(series, seasonNo),
    },
  };
}

async function totalsFor(userId, seasonKey, ladder) {
  const rows = ladder
    ? await db.all('SELECT points_delta, won FROM bf_arena_results WHERE user_id = ? AND season_key = ? AND ladder = ?',
      [userId, seasonKey, ladder])
    : await db.all('SELECT points_delta, won FROM bf_arena_results WHERE user_id = ? AND season_key = ?',
      [userId, seasonKey]);
  let points = 0, wins = 0;
  for (const r of rows) { points += Number(r.points_delta); wins += Number(r.won); }
  return { points, wins, matches: rows.length };
}

function rankSort(a, b) {
  if (b.points !== a.points) return b.points - a.points;
  if (b.wins !== a.wins) return b.wins - a.wins;
  if (a.matches !== b.matches) return a.matches - b.matches;
  return a.user_id < b.user_id ? -1 : 1;
}

// Full ordered standings for one season (+ladder), with each row's
// seat display name resolved at read time.
async function standings(seasonKey, ladder) {
  const rows = ladder
    ? await db.all('SELECT user_id, points_delta, won FROM bf_arena_results WHERE season_key = ? AND ladder = ?',
      [seasonKey, ladder])
    : await db.all('SELECT user_id, points_delta, won FROM bf_arena_results WHERE season_key = ?',
      [seasonKey]);
  const byUser = new Map();
  for (const r of rows) {
    let t = byUser.get(r.user_id);
    if (!t) { t = { user_id: r.user_id, points: 0, wins: 0, matches: 0 }; byUser.set(r.user_id, t); }
    t.points += Number(r.points_delta);
    t.wins += Number(r.won);
    t.matches += 1;
  }
  const list = [...byUser.values()].sort(rankSort);
  if (!list.length) return list;
  const ids = list.map((t) => t.user_id);
  const users = await db.all(
    `SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
  const byId = new Map(users.map((u) => [u.id, u]));
  list.forEach((t, i) => {
    t.rank = i + 1;
    const u = byId.get(t.user_id);
    t.display_name = u ? onemind.seatDisplayName(u) : '';
  });
  return list;
}

// opts.now injects the clock (tests prove the flood floor with it);
// an injected clock always enforces the floor. Without one, the
// floor relaxes under NODE_ENV=test exactly like the house rate
// limiters do — production always enforces.
async function submitResult(user, rawBody, opts = {}) {
  const check = sanitizeResult(rawBody);
  if (!check.ok) return check;
  const v = check.value;
  // Idempotency: a retried submission answers with the original
  // acceptance and changes nothing.
  const dupe = await db.get('SELECT * FROM bf_arena_results WHERE user_id = ? AND match_id = ?',
    [user.id, v.match_id]);
  if (dupe) {
    const totals = await totalsFor(user.id, dupe.season_key, null);
    const board = await standings(dupe.season_key, null);
    const mine = board.find((t) => t.user_id === user.id);
    return {
      ok: true, accepted: true, duplicate: true,
      season: dupe.season_key, totals, rank: mine ? mine.rank : null,
    };
  }
  // Per-seat flood floor: real matches take minutes; two accepted
  // results from one seat inside the gap is a script, not a game.
  const last = await db.get(
    'SELECT created_at FROM bf_arena_results WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [user.id]);
  const now = opts.now !== undefined ? Number(opts.now) : db.now();
  const enforceGap = opts.now !== undefined || process.env.NODE_ENV !== 'test';
  if (enforceGap && last && now - Number(last.created_at) < SUBMIT_MIN_GAP_MS) {
    return { ok: false, error: 'too_fast', status: 429 };
  }
  await db.insert('bf_arena_results', {
    user_id: user.id, match_id: v.match_id, ladder: v.ladder,
    place: v.place, side_size: v.side_size, won: v.won, desert: v.desert,
    points_delta: v.points_delta, claimed_after: v.claimed_after,
    season_key: v.season_key,
  });
  const totals = await totalsFor(user.id, v.season_key, null);
  const board = await standings(v.season_key, null);
  const mine = board.find((t) => t.user_id === user.id);
  return {
    ok: true, accepted: true, duplicate: false,
    season: v.season_key, totals, rank: mine ? mine.rank : null,
  };
}

async function latestSeasonKey(userId) {
  if (userId) {
    const mine = await db.get(
      'SELECT season_key FROM bf_arena_results WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]);
    if (mine) return mine.season_key;
  }
  const any = await db.get('SELECT season_key FROM bf_arena_results ORDER BY created_at DESC LIMIT 1');
  return any ? any.season_key : null;
}

async function leaderboard({ seasonKey, ladder, limit, forUser }) {
  const season = seasonKey || (await latestSeasonKey(forUser ? forUser.id : null));
  if (!season) {
    return { season: null, ladder: ladder || 'combined', entries: [], you: null };
  }
  const board = await standings(season, ladder || null);
  const lim = int(limit, 1, 100, 25);
  const entries = board.slice(0, lim).map((t) => ({
    rank: t.rank, display_name: t.display_name, points: t.points,
    wins: t.wins, matches: t.matches, you: !!(forUser && t.user_id === forUser.id),
  }));
  let you = null;
  if (forUser) {
    const mine = board.find((t) => t.user_id === forUser.id);
    if (mine) {
      you = { rank: mine.rank, points: mine.points, wins: mine.wins, matches: mine.matches };
    }
  }
  return { season, ladder: ladder || 'combined', entries, you };
}

module.exports = {
  PROGRESS_V, MAX_BLOB_BYTES,
  sanitizeProgress, mergeProgress, emptyProgress,
  getProgress, putProgress,
  sanitizeResult, submitResult, leaderboard, totalsFor, seasonKeyOf,
  DELTA_MIN, DELTA_MAX,
};
