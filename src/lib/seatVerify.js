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

// ---- the audit read ---------------------------------------------------------
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
  };
}

module.exports = {
  SESSION_TTL_MS, REFRESH_TTL_MS,
  hashToken, rootFlagOf, logEvent,
  userFromApiToken, verifySessionToken, resolveSeatProof,
  openSession, refreshSession, revokeSession,
  entitlementsFor, checkClaims, bindCodeRedemption,
  watchSummary,
};
