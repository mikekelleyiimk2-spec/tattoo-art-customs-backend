// Chorvix verification layer (migration 122, owner directive
// 2026-11-01: "Never seen that login build it can keep up and verify
// game data keeps hacks like me from sweeping up my penny's").
// RENAME NOTE (standing law): the people-facing name is Chorvix;
// internal names (routes /api/onemind/*, ids, this file's seat
// vocabulary) keep the house's working names.
//
// What the seat foundation (lib/onemind.js) proves ONCE — who you
// are, at sign-in — this layer proves CONTINUOUSLY, on every
// platform, and extends the proof to what the seat OWNS:
//
//   SESSIONS — a signed-in app exchanges its long-lived seat key
//   (users.api_token, minted by the existing sign-in doors) for a
//   short-lived session token + a rotating refresh token. Any house
//   app on any platform calls POST /api/onemind/verify to answer
//   "is this seat real and current?" Sessions are per-platform rows
//   over ONE seat: phone, TV, iOS and future ports verify against
//   the same user_id / onemind_id. Revocation is a row flip — a
//   dropped plug is caught the moment it is revoked, everywhere.
//
//   ENTITLEMENTS — what a seat owns is computed from SERVER truth
//   only: paid website orders (read live from `orders`), verified
//   Play purchases (play_purchases), and durable bindings in
//   seat_entitlements (written when an unlock code is redeemed
//   WITH a seat proof). A client claim is never an input — claims
//   are CHECKED (POST /api/onemind/entitlements/check) and a claim
//   the server cannot prove is answered entitled:false AND written
//   to the watch. Nobody sweeps this house's pennies: value moves
//   only where a server record says it moved.
//
//   THE WATCH — verify_events is the living record: session opens,
//   verify failures, refresh-token reuse, revocations, claim
//   mismatches, redemption outcomes. Read door: GET
//   /api/onemind/watch (house service token). This is the root
//   checker's doctrine made literal: the system WATCHES and keeps
//   the record; root and modded clients are WELCOME — a client
//   declares its configuration (client_root) and it is recorded,
//   never judged. The boot is for BEHAVIOR — forgery, replay,
//   token reuse — and behavior is what lands in the watch.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const onemind = require('./onemind');
const surfaces = require('./surfaces');
const bf = require('./brambleforce');

const SESSION_TTL_MS = Number(process.env.CHORVIX_SESSION_TTL_MS || 15 * 60 * 1000);
const REFRESH_TTL_MS = Number(process.env.CHORVIX_REFRESH_TTL_MS || 30 * 24 * 3600 * 1000);

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function mintToken(prefix) {
  return prefix + crypto.randomBytes(32).toString('hex');
}

// IPs enter the watch only as a salted hash prefix — enough to tell
// "same network" apart in an audit, never a raw address at rest.
function ipHashOf(req) {
  if (!req) return null;
  const ip = String((req.headers && req.headers['x-forwarded-for']) || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
  if (!ip) return null;
  return crypto.createHash('sha256').update(`${ip}:${config.sessionSecret}`).digest('hex').slice(0, 16);
}

// The declared-configuration record. true/'root'/'rooted' -> 'root';
// false/'not-root'/'clean' -> 'not-root'; anything else 'unknown'.
// RECORDED ONLY — no decision anywhere in this layer reads it.
function rootFlagOf(v) {
  if (v === true || v === 'root' || v === 'rooted') return 'root';
  if (v === false || v === 'not-root' || v === 'clean') return 'not-root';
  return 'unknown';
}

function cleanShort(v, cap) {
  const s = String(v == null ? '' : v).trim().slice(0, cap);
  return s || null;
}

// ---- the watch ---------------------------------------------------------
// Best-effort by design: a failed log write must never break a
// sign-in, a verify, or a redemption. Failures surface on the
// server console, never in a client's response.
async function logEvent({ user = null, userId = null, onemindId = null, surface = null, platform = null, kind, detail = null, req = null }) {
  try {
    await db.insert('verify_events', {
      ts: db.now(),
      user_id: userId || (user && user.id) || null,
      onemind_id: onemindId || (user && user.onemind_id) || null,
      surface: cleanShort(surface, 64),
      platform: cleanShort(platform, 40),
      kind: String(kind).slice(0, 48),
      detail: detail == null ? null : String(detail).slice(0, 300),
      ip_hash: ipHashOf(req),
    });
  } catch (e) {
    console.error('verify watch log failed:', e.message);
  }
}

// ---- seat proof resolution ----------------------------------------------
// The long-lived seat key from the existing sign-in doors.
async function userFromApiToken(token) {
  const t = String(token || '').slice(0, 128);
  if (!t) return null;
  return db.get('SELECT * FROM users WHERE api_token = ?', [t]);
}

async function sessionByToken(token) {
  const t = String(token || '');
  if (!t.startsWith('cxs_')) return null;
  return db.get('SELECT * FROM seat_sessions WHERE token_hash = ?', [hashToken(t)]);
}

async function sessionByRefresh(refreshToken) {
  const t = String(refreshToken || '');
  if (!t.startsWith('cxr_')) return null;
  return db.get('SELECT * FROM seat_sessions WHERE refresh_hash = ?', [hashToken(t)]);
}

function sessionState(row) {
  if (!row) return 'session_unknown';
  if (row.revoked_at) return 'session_revoked';
  if (Number(row.expires_at) <= db.now()) return 'session_expired';
  return 'ok';
}

// Verify a session token. On success the row's last_seen_at moves —
// the record keeps up with the seat, on every platform. Returns
// { ok:true, user, session } | { ok:false, error } where error is
// one of session_unknown | session_revoked | session_expired.
async function verifySessionToken(token, ctx = {}) {
  const row = await sessionByToken(token);
  const state = sessionState(row);
  if (state !== 'ok') {
    await logEvent({
      kind: 'verify_fail', detail: state,
      surface: ctx.surface, platform: ctx.platform, req: ctx.req,
      userId: row ? row.user_id : null,
    });
    return { ok: false, error: state };
  }
  const user = await db.get('SELECT * FROM users WHERE id = ?', [row.user_id]);
  if (!user) {
    await logEvent({ kind: 'verify_fail', detail: 'seat_gone', surface: ctx.surface, platform: ctx.platform, req: ctx.req, userId: row.user_id });
    return { ok: false, error: 'session_unknown' };
  }
  await onemind.ensureOneMindId(user);
  const now = db.now();
  // Keep-up write, throttled to one row write per minute per session
  // (verify can be called on a heartbeat; the record needs the
  // minute, not the millisecond).
  if (now - Number(row.last_seen_at || 0) > 60000) {
    await db.update('seat_sessions', row.id, { last_seen_at: now });
    row.last_seen_at = now;
  }
  await logEvent({
    user, kind: 'verify_ok',
    surface: ctx.surface || row.surface, platform: ctx.platform || row.platform, req: ctx.req,
  });
  return { ok: true, user, session: row };
}

// Resolve any seat proof a caller presents: a session token (the
// current mechanism) or the long-lived api_token (the legacy doors).
// { user, via, session? } on success; { invalid:true, reason } when
// a proof was PRESENTED but does not hold; null when none was.
async function resolveSeatProof({ apiToken = null, sessionToken = null, req = null } = {}) {
  if (sessionToken) {
    const v = await verifySessionToken(sessionToken, { req });
    if (v.ok) return { user: v.user, via: 'session', session: v.session };
    return { invalid: true, reason: v.error };
  }
  if (apiToken) {
    const user = await userFromApiToken(apiToken);
    if (user) {
      await onemind.ensureOneMindId(user);
      return { user, via: 'api_token' };
    }
    // A presented-but-worthless seat key is behavior, and behavior is
    // what the watch records (cadence pass 2026-11-01: every rejected
    // claim at every door lands here, not just session-token doors).
    await logEvent({ kind: 'proof_invalid', detail: 'api_token_unknown', req });
    return { invalid: true, reason: 'api_token_unknown' };
  }
  return null;
}

// ---- sessions -------------------------------------------------------------
async function openSession(user, { surface = null, platform = null, clientRoot = null, clientBuild = null, req = null } = {}) {
  const surfaceId = cleanShort(surface, 64);
  if (surfaceId && !surfaces.isTieable(surfaceId)) {
    await logEvent({ user, kind: 'session_open_rejected', detail: 'surface_not_tieable', surface: surfaceId, platform, req });
    return { ok: false, error: 'surface_not_tieable', surface: surfaceId };
  }
  await onemind.ensureOneMindId(user);
  if (surfaceId) {
    // Opening a session on a surface IS a sitting — the tie is
    // written by the same hand that writes every tie.
    await onemind.seatQuietly(user.id, surfaceId);
  }
  const now = db.now();
  const sessionToken = mintToken('cxs_');
  const refreshToken = mintToken('cxr_');
  const id = await db.insert('seat_sessions', {
    user_id: user.id,
    token_hash: hashToken(sessionToken),
    refresh_hash: hashToken(refreshToken),
    surface: surfaceId,
    platform: cleanShort(platform, 40),
    client_root: rootFlagOf(clientRoot),
    client_build: cleanShort(clientBuild, 64),
    created_at: now,
    expires_at: now + SESSION_TTL_MS,
    refresh_expires_at: now + REFRESH_TTL_MS,
    last_seen_at: now,
    revoked_at: null,
    revoke_reason: null,
  });
  await logEvent({
    user, kind: 'session_open', surface: surfaceId, platform, req,
    detail: `root=${rootFlagOf(clientRoot)}`,
  });
  return {
    ok: true,
    session_id: id,
    session_token: sessionToken,
    refresh_token: refreshToken,
    expires_at: now + SESSION_TTL_MS,
    refresh_expires_at: now + REFRESH_TTL_MS,
  };
}

// Rotate: the presented refresh token dies and a fresh pair is born
// over the same sitting (surface/platform/configuration carried).
// REUSE of an already-rotated refresh token is the behavior the
// watch exists for: every live session of that seat is revoked on
// the spot and the event is recorded — a stolen refresh token can
// sweep nothing.
async function refreshSession(refreshToken, ctx = {}) {
  const row = await sessionByRefresh(refreshToken);
  if (!row) {
    await logEvent({ kind: 'refresh_fail', detail: 'refresh_unknown', req: ctx.req });
    return { ok: false, error: 'refresh_unknown' };
  }
  if (row.revoked_at && row.revoke_reason === 'rotated') {
    await db.query(
      'UPDATE seat_sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
      [db.now(), 'refresh_reuse', row.user_id]
    );
    const user = await db.get('SELECT * FROM users WHERE id = ?', [row.user_id]);
    await logEvent({ user, kind: 'refresh_reuse', detail: 'rotated refresh token presented again; all seat sessions revoked', surface: row.surface, platform: row.platform, req: ctx.req });
    return { ok: false, error: 'refresh_reused' };
  }
  if (row.revoked_at) {
    await logEvent({ kind: 'refresh_fail', detail: 'session_revoked', userId: row.user_id, surface: row.surface, platform: row.platform, req: ctx.req });
    return { ok: false, error: 'session_revoked' };
  }
  if (Number(row.refresh_expires_at) <= db.now()) {
    await logEvent({ kind: 'refresh_fail', detail: 'refresh_expired', userId: row.user_id, surface: row.surface, platform: row.platform, req: ctx.req });
    return { ok: false, error: 'refresh_expired' };
  }
  const user = await db.get('SELECT * FROM users WHERE id = ?', [row.user_id]);
  if (!user) return { ok: false, error: 'refresh_unknown' };
  await db.update('seat_sessions', row.id, { revoked_at: db.now(), revoke_reason: 'rotated' });
  const opened = await openSession(user, {
    surface: row.surface,
    platform: ctx.platform || row.platform,
    clientRoot: row.client_root,
    clientBuild: row.client_build,
    req: ctx.req,
  });
  if (opened.ok) {
    opened.user = user;
    await logEvent({ user, kind: 'session_refresh', surface: row.surface, platform: ctx.platform || row.platform, req: ctx.req });
  }
  return opened;
}

// Revoke by possession of either token (logout, lost device, the
// owner's hand). { ok:true } even when the token was already dead —
// the end state the caller wants is the state that holds.
async function revokeSession({ sessionToken = null, refreshToken = null, req = null, reason = 'revoked' } = {}) {
  const row = (sessionToken && await sessionByToken(sessionToken))
    || (refreshToken && await sessionByRefresh(refreshToken))
    || null;
  if (!row) return { ok: false, error: 'session_unknown' };
  if (!row.revoked_at) {
    await db.update('seat_sessions', row.id, { revoked_at: db.now(), revoke_reason: String(reason).slice(0, 40) });
  }
  const user = await db.get('SELECT * FROM users WHERE id = ?', [row.user_id]);
  await logEvent({ user, kind: 'session_revoke', detail: String(reason).slice(0, 40), surface: row.surface, platform: row.platform, req });
  return { ok: true, revoked: true };
}

// ---- entitlements: server truth only --------------------------------------
// The seat's full ownership set, computed fresh on every call:
//   orders (live) — `brambleforce:<product>` paid orders grant the
//     product; the Everything Bundle expands to its struck grant
//     set (lib/brambleforce BUNDLE_GRANTS — drops are never in it);
//     the game's own orders (`sideload:<package>`, `brambleforce_ios`)
//     grant 'game'.
//   seat_entitlements — durable bindings (redeemed codes, grants).
//   play_purchases — rows Google verified (status 'verified') and
//     the linking flow tied to this account, under their Play
//     product ids.
// Nothing a client says enters this computation.
async function entitlementsFor(user) {
  const byProduct = new Map();
  const add = (product, source, ref, grantedAt) => {
    if (!product) return;
    const prev = byProduct.get(product);
    if (!prev || Number(grantedAt || 0) < Number(prev.granted_at || 0)) {
      byProduct.set(product, {
        product, source, ref: ref || null,
        granted_at: grantedAt == null ? null : Number(grantedAt),
      });
    }
  };
  const orders = await db.all(
    "SELECT id, order_type, paid_at FROM orders WHERE buyer_id = ? AND status = 'paid'", [user.id]);
  for (const o of orders) {
    const t = String(o.order_type || '');
    if (t.startsWith('brambleforce:')) {
      const pid = t.slice('brambleforce:'.length);
      add(pid, 'order', o.id, o.paid_at);
      if (pid === 'everything_bundle') {
        for (const g of bf.BUNDLE_GRANTS) add(g, 'order_bundle', o.id, o.paid_at);
      }
    } else if (t === `sideload:${bf.PACKAGE}` || t === 'brambleforce_ios') {
      add('game', 'order', o.id, o.paid_at);
    }
  }
  const bound = await db.all(
    'SELECT product, source, ref, granted_at FROM seat_entitlements WHERE user_id = ? AND revoked_at IS NULL', [user.id]);
  for (const b of bound) add(b.product, b.source, b.ref, b.granted_at);
  const play = await db.all(
    "SELECT id, product_id, verified_at, created_at FROM play_purchases WHERE user_id = ? AND status = 'verified'", [user.id]);
  for (const p of play) add(p.product_id, 'play', p.id, p.verified_at || p.created_at);
  const entitlements = [...byProduct.values()].sort((a, b) => a.product.localeCompare(b.product));
  return { products: entitlements.map((e) => e.product), entitlements };
}

// Check a client's claims against the truth. Every claim is answered
// individually; the ones the server cannot prove come back
// entitled:false and are written to the watch as claim_mismatch —
// recorded behavior, answered honestly, nobody punished for asking.
async function checkClaims(user, claims, ctx = {}) {
  const list = (Array.isArray(claims) ? claims : [claims])
    .map((c) => cleanShort(c, 64)).filter(Boolean).slice(0, 64);
  const truth = await entitlementsFor(user);
  const held = new Map(truth.entitlements.map((e) => [e.product, e]));
  const results = [];
  const mismatches = [];
  for (const product of list) {
    const e = held.get(product);
    results.push({ product, entitled: !!e, source: e ? e.source : null });
    if (!e) mismatches.push(product);
  }
  for (const product of mismatches) {
    await logEvent({
      user, kind: 'claim_mismatch', detail: product,
      surface: ctx.surface, platform: ctx.platform, req: ctx.req,
    });
  }
  await logEvent({
    user, kind: 'claim_check', detail: `${list.length} claimed, ${mismatches.length} unproven`,
    surface: ctx.surface, platform: ctx.platform, req: ctx.req,
  });
  // Thief-trap bookkeeping (migration 124): an unproven claim is a
  // strike — REPEATED forged claims spring the trap. A fully clean
  // claim check is the seat demonstrating its state matches server
  // truth, which is one of the trap's automatic lift paths.
  if (mismatches.length) {
    await strikeOrTrap(user, 'claim_mismatch', mismatches.join(','), ctx);
  } else if (list.length) {
    await reconcileTrapFor(user, 'clean_claim_check');
  }
  return { results, mismatches };
}

// Bind a redeemed unlock code to the seat that proved itself at
// redemption. The bundle binds its whole grant set, from the
// server's own mapping. Idempotent (unique grant index): a re-bind
// of the same code to the same seat changes nothing.
async function bindCodeRedemption(user, codeRow, product, grants) {
  const now = db.now();
  const products = [product, ...(Array.isArray(grants) ? grants : [])];
  for (const p of products) {
    try {
      await db.insert('seat_entitlements', {
        user_id: user.id, product: p, source: 'code',
        ref: codeRow ? codeRow.id : null, granted_at: now, revoked_at: null,
      });
    } catch (e) {
      if (!/unique|duplicate/i.test(String(e && e.message))) throw e;
    }
  }
}

// ---- the thief trap (migration 124, owner design 2026-11-01 20:40) --------
// No bans. A seat caught at THEFT behavior — a replayed unlock, a
// run of forged claims, an entitlement with no living source — gets
// flagged server-side, and the game clients that already talk to
// this layer read the flag on session open / verify / redeem and
// turn the game on the thief themselves (rubber bullets at 0.1
// strength, enemies in constant frenzy: impossible to BEAT, not
// impossible to play). The trap LIFTS automatically the moment the
// seat's state reconciles clean against server truth — clean claim
// check, or a reconciliation sweep that finds every entitlement
// backed. Nothing here is permanent, and NOTHING here reads client
// configuration: a root declaration never springs this trap; only
// theft behavior does.
const TRAP_STRIKE_LIMIT = 3;
const TRAP_STRIKE_WINDOW_MS = 24 * 3600 * 1000;

async function trapRowFor(userId) {
  return db.get('SELECT * FROM seat_traps WHERE user_id = ?', [userId]);
}

// The client-facing shape: { active, reason, set_at } — reason is a
// CLASS ('replayed_unlock' | 'repeated_forged_claims' |
// 'unbacked_entitlement'), never the raw evidence.
async function trapStateFor(userId) {
  const row = await trapRowFor(userId);
  if (!row || row.lifted_at) return { active: false, reason: null, set_at: null };
  return { active: true, reason: row.reason, set_at: Number(row.set_at) };
}

async function setTrap(user, reason, triggerKind, detail, ctx = {}) {
  const existing = await trapRowFor(user.id);
  const now = db.now();
  if (existing) {
    await db.update('seat_traps', existing.id, {
      reason, trigger_kind: triggerKind, detail: detail ? String(detail).slice(0, 300) : null,
      set_at: now, lifted_at: null,
    });
  } else {
    await db.insert('seat_traps', {
      user_id: user.id, reason, trigger_kind: triggerKind,
      detail: detail ? String(detail).slice(0, 300) : null,
      set_at: now, lifted_at: null,
    });
  }
  // Log the transition (and a reason change), not every re-affirm —
  // the watch shows when the trap SPRANG, not a heartbeat of it.
  if (!existing || existing.lifted_at || existing.reason !== reason) {
    await logEvent({
      user, kind: 'trap_set', detail: `${reason} via ${triggerKind}`,
      surface: ctx.surface, platform: ctx.platform, req: ctx.req,
    });
  }
  return trapStateFor(user.id);
}

async function liftTrap(user, via, ctx = {}) {
  const existing = await trapRowFor(user.id);
  if (!existing || existing.lifted_at) return { active: false, reason: null, set_at: null };
  await db.update('seat_traps', existing.id, { lifted_at: db.now() });
  await logEvent({
    user, kind: 'trap_lifted', detail: `${existing.reason} lifted via ${via}`,
    surface: ctx.surface, platform: ctx.platform, req: ctx.req,
  });
  return { active: false, reason: null, set_at: null };
}

// Theft strikes in the rolling window: unproven entitlement claims
// + forged (unknown) unlock codes presented by the seat. A replayed
// code ('spent') is NOT a strike — it springs the trap outright at
// the redeem door.
async function strikeCountFor(userId) {
  const since = db.now() - TRAP_STRIKE_WINDOW_MS;
  const claims = await db.get(
    "SELECT COUNT(*) AS n FROM verify_events WHERE user_id = ? AND ts >= ? AND kind = 'claim_mismatch'",
    [userId, since]);
  const codes = await db.get(
    "SELECT COUNT(*) AS n FROM verify_events WHERE user_id = ? AND ts >= ? AND kind = 'redeem_rejected' AND detail = 'unknown'",
    [userId, since]);
  return Number((claims && claims.n) || 0) + Number((codes && codes.n) || 0);
}

async function strikeOrTrap(user, triggerKind, detail, ctx = {}) {
  const strikes = await strikeCountFor(user.id);
  if (strikes >= TRAP_STRIKE_LIMIT) {
    return setTrap(user, 'repeated_forged_claims', triggerKind, `${strikes} strikes in 24h: ${detail || ''}`, ctx);
  }
  return trapStateFor(user.id);
}

// The reconciliation audit behind every lift: does everything this
// seat currently HOLDS trace to a living source? Bindings must
// reach a code whose order is still 'paid'; order and Play truth is
// read live by entitlementsFor, so a stored binding is the only
// place an unbacked holding can persist.
async function seatBackingClean(userId) {
  const bindings = await db.all(
    'SELECT * FROM seat_entitlements WHERE user_id = ? AND revoked_at IS NULL', [userId]);
  for (const b of bindings) {
    if (b.source !== 'code') continue;
    const codeRow = b.ref
      ? await db.get('SELECT * FROM brambleforce_codes WHERE id = ?', [b.ref])
      : null;
    if (!codeRow) return false;
    const order = codeRow.order_id
      ? await db.get('SELECT status FROM orders WHERE id = ?', [codeRow.order_id])
      : null;
    if (!order || order.status !== 'paid') return false;
  }
  return true;
}

// Lift the trap if — and only if — the seat's state reconciles
// clean right now. Called on a clean claim check and by the
// reconciliation sweep's lift pass.
async function reconcileTrapFor(user, via, ctx = {}) {
  const state = await trapStateFor(user.id);
  if (!state.active) return state;
  if (!(await seatBackingClean(user.id))) return state;
  return liftTrap(user, via, ctx);
}

// ---- the audit read ---------------------------------------------------------
// Rejection-class kinds: attempts the server refused. A seat stacking
// these up is the anomaly the owner wants SEEN, not buried in the
// event stream — watchSummary promotes them into `flagged_seats`.
const REJECTION_KINDS = [
  'verify_fail', 'claim_mismatch', 'redeem_rejected', 'refresh_fail',
  'refresh_reuse', 'proof_invalid', 'seat_check_fail',
  'download_gate_rejected', 'fulfillment_mismatch',
  'play_claim_unverified', 'session_open_rejected',
];
const FLAG_THRESHOLD = 5;

async function watchSummary(limit = 100) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const events = await db.all('SELECT * FROM verify_events ORDER BY ts DESC LIMIT ?', [lim]);
  const since = db.now() - 24 * 3600 * 1000;
  const kinds = await db.all(
    'SELECT kind, COUNT(*) AS n FROM verify_events WHERE ts >= ? GROUP BY kind ORDER BY n DESC', [since]);
  const active = await db.get(
    'SELECT COUNT(*) AS n FROM seat_sessions WHERE revoked_at IS NULL AND expires_at > ?', [db.now()]);
  const platforms = await db.all(
    'SELECT platform, COUNT(*) AS n FROM seat_sessions WHERE revoked_at IS NULL AND expires_at > ? GROUP BY platform ORDER BY n DESC', [db.now()]);
  const rooted = await db.get(
    "SELECT COUNT(*) AS n FROM seat_sessions WHERE revoked_at IS NULL AND expires_at > ? AND client_root = 'root'", [db.now()]);
  // Anomalies, surfaced — never buried (cadence pass, owner directive
  // 2026-11-01 20:34): what the reconciliation sweep pulled in the
  // last 24h, and which seats keep getting refused at the doors.
  const placeholders = REJECTION_KINDS.map(() => '?').join(',');
  const flagged = await db.all(
    `SELECT user_id, onemind_id, COUNT(*) AS n FROM verify_events
     WHERE ts >= ? AND user_id IS NOT NULL AND kind IN (${placeholders})
     GROUP BY user_id, onemind_id HAVING COUNT(*) >= ? ORDER BY n DESC LIMIT 20`,
    [since, ...REJECTION_KINDS, FLAG_THRESHOLD]);
  const pulled = await db.get(
    "SELECT COUNT(*) AS n FROM verify_events WHERE ts >= ? AND kind = 'entitlement_pulled'", [since]);
  const playRevoked = await db.get(
    "SELECT COUNT(*) AS n FROM verify_events WHERE ts >= ? AND kind = 'play_purchase_revoked'", [since]);
  let sweep = null;
  try {
    const row = await db.get('SELECT val FROM site_kv WHERE name = ?', ['chorvix_sweep_last']);
    if (row) sweep = JSON.parse(row.val);
  } catch (e) { /* the kv read is best-effort; absence reads as never-run */ }
  // Active thief traps, named — the consequence layer is part of
  // the record, on the surface of the watch, never buried.
  const trapRows = await db.all(
    'SELECT t.user_id, t.reason, t.trigger_kind, t.set_at, u.onemind_id FROM seat_traps t LEFT JOIN users u ON u.id = t.user_id WHERE t.lifted_at IS NULL ORDER BY t.set_at DESC LIMIT 50');
  const trappedSeats = trapRows.map((t) => ({
    user_id: t.user_id, onemind_id: t.onemind_id || null,
    reason: t.reason, trigger: t.trigger_kind, set_at: Number(t.set_at),
  }));
  return {
    events: events.map((e) => ({
      ts: Number(e.ts), kind: e.kind, user_id: e.user_id, onemind_id: e.onemind_id,
      surface: e.surface, platform: e.platform, detail: e.detail, ip_hash: e.ip_hash,
    })),
    kinds_24h: kinds.map((k) => ({ kind: k.kind, count: Number(k.n || 0) })),
    active_sessions: Number((active && active.n) || 0),
    active_by_platform: platforms.map((p) => ({ platform: p.platform || 'unknown', count: Number(p.n || 0) })),
    // The root checker's living record, reported as what it is —
    // a count of honest declarations, not a threat list.
    active_declared_root: Number((rooted && rooted.n) || 0),
    anomalies: {
      entitlements_pulled_24h: Number((pulled && pulled.n) || 0),
      play_purchases_revoked_24h: Number((playRevoked && playRevoked.n) || 0),
      flagged_seats: flagged.map((f) => ({
        user_id: f.user_id, onemind_id: f.onemind_id, rejections_24h: Number(f.n || 0),
      })),
      trapped_seats: trappedSeats,
    },
    // The reconciliation sweep's last run (lib/entitlementSweep.js
    // writes it); null until the first run lands.
    sweep,
  };
}

module.exports = {
  SESSION_TTL_MS, REFRESH_TTL_MS, REJECTION_KINDS, FLAG_THRESHOLD,
  TRAP_STRIKE_LIMIT, TRAP_STRIKE_WINDOW_MS,
  hashToken, rootFlagOf, logEvent,
  userFromApiToken, verifySessionToken, resolveSeatProof,
  openSession, refreshSession, revokeSession,
  entitlementsFor, checkClaims, bindCodeRedemption,
  trapStateFor, setTrap, liftTrap, strikeCountFor, strikeOrTrap,
  seatBackingClean, reconcileTrapFor,
  watchSummary,
};
