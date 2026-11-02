// Chorvix verification doors (migration 122, lib/seatVerify.js).
// RENAME NOTE (standing law): people-facing name is Chorvix; the
// route paths keep the house's internal /api/onemind names like
// every other door in this family.
//
// The contract any house app/game on any platform codes against:
//
//   GET  /api/onemind/verify/health
//     -> 200 { ok:true, service:'chorvix-verify', db:true, time }
//     The verify layer's own liveness door (the house standard: a
//     dead verify endpoint is damage, so it carries its own check).
//
//   POST /api/onemind/session
//     Auth: x-api-token (the seat key from any existing sign-in
//     door) or the website session. Body:
//       { surface?, platform?, client?: { root?, build? } }
//     -> 200 { ok:true, session_token, refresh_token, expires_at,
//              refresh_expires_at, seat:{ onemind_id, user_id,
//              email, display_name } }
//     -> 401 not linked | 400 surface_not_tieable
//     client.root is the root checker's declaration: recorded on
//     the sitting, never judged — root is welcome (owner law).
//
//   POST /api/onemind/verify
//     Token: Authorization: Bearer <session_token>, or the
//     x-session-token header, or body { session_token }.
//     Optional body { surface, platform } for the watch record.
//     -> 200 { ok:true, seat:{...}, session:{ id, surface,
//              platform, client_root, expires_at } }
//     -> 401 { ok:false, error: session_unknown | session_revoked |
//              session_expired }
//
//   POST /api/onemind/session/refresh   { refresh_token }
//     -> 200 a fresh pair (same shape as /session). The old pair is
//     dead the moment this answers; presenting a rotated refresh
//     token again revokes EVERY session of the seat (refresh_reused).
//
//   POST /api/onemind/session/revoke    { session_token | refresh_token }
//     -> 200 { ok:true, revoked:true }
//
//   GET  /api/onemind/entitlements
//     Auth: a session token OR x-api-token (legacy doors).
//     -> 200 { ok:true, seat:{...}, products:[ids],
//              entitlements:[{ product, source, ref, granted_at }] }
//     Computed from server truth on every call — see lib.
//
//   POST /api/onemind/entitlements/check
//     Auth as above. Body { claims:[productId...] } (or { product }).
//     -> 200 { ok:true, results:[{ product, entitled, source }] }
//     Unproven claims are recorded in the watch (claim_mismatch).
//
//   GET  /api/onemind/watch?limit=
//     House service token only (MUSE_SERVICE_TOKEN; 404 when
//     unset, 401 on a bad token — the house convention): the
//     integrity watch — recent events, 24h counts by kind, active
//     sessions by platform, declared-root count.
//
// Game/app clients call cross-origin (the game page runs on a
// file:///android_asset origin), so — exactly like the redeem door —
// these paths carry their own scoped CORS and nothing else does.
const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const db = require('../db');
const onemind = require('../lib/onemind');
const seatVerify = require('../lib/seatVerify');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

function verifyCors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-token, x-session-token');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
}
router.use('/onemind/verify', verifyCors);
router.use('/onemind/session', verifyCors);
router.use('/onemind/entitlements', verifyCors);

const relaxed = process.env.NODE_ENV === 'test' ? 100000 : null;
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: relaxed || 900,
  standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ ok: false, error: 'rate_limited' }),
});
const checkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: relaxed || 300,
  standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ ok: false, error: 'rate_limited' }),
});

function sessionTokenOf(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (m) return m[1].trim();
  if (req.get('x-session-token')) return String(req.get('x-session-token')).trim();
  if (req.body && typeof req.body.session_token === 'string') return req.body.session_token.trim();
  return '';
}

function apiTokenOf(req) {
  return String(req.get('x-api-token') || req.query.api_token || '').slice(0, 128);
}

async function seatOf(user) {
  const onemindId = await onemind.ensureOneMindId(user);
  return {
    onemind_id: onemindId,
    user_id: user.id,
    email: user.email,
    display_name: user.display_name || '',
  };
}

// Resolve the caller from any accepted proof. Returns the user, or
// null after responding 401.
async function requireSeat(req, res) {
  const proof = await seatVerify.resolveSeatProof({
    apiToken: apiTokenOf(req) || null,
    sessionToken: sessionTokenOf(req) || null,
    req,
  });
  if (proof && proof.user) return proof.user;
  if (req.user && req.user.id) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (user) return user;
  }
  return res.status(401).json({ ok: false, error: 'not linked' }) && null;
}

router.get('/onemind/verify/health', async (req, res) => {
  try {
    await db.get('SELECT 1 AS one');
    return res.json({
      ok: true, service: 'chorvix-verify', db: true,
      time: Date.now(), session_ttl_ms: seatVerify.SESSION_TTL_MS,
    });
  } catch (e) {
    return res.status(503).json({ ok: false, service: 'chorvix-verify', db: false, error: 'db_unreachable' });
  }
});

router.post('/onemind/session', authLimiter, express.json(), async (req, res) => {
  const body = req.body || {};
  let user = null;
  const apiToken = apiTokenOf(req);
  if (apiToken) user = await seatVerify.userFromApiToken(apiToken);
  if (!user && req.user && req.user.id) {
    user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  }
  if (!user) return res.status(401).json({ ok: false, error: 'not linked' });
  const client = (body.client && typeof body.client === 'object') ? body.client : {};
  const opened = await seatVerify.openSession(user, {
    surface: body.surface || null,
    platform: body.platform || null,
    clientRoot: client.root !== undefined ? client.root : body.root,
    clientBuild: client.build || body.build || null,
    req,
  });
  if (!opened.ok) return res.status(400).json({ ok: false, error: opened.error, surface: opened.surface || null });
  return res.json({
    ok: true,
    session_token: opened.session_token,
    refresh_token: opened.refresh_token,
    expires_at: opened.expires_at,
    refresh_expires_at: opened.refresh_expires_at,
    seat: await seatOf(user),
  });
});

router.post('/onemind/verify', verifyLimiter, express.json(), async (req, res) => {
  const token = sessionTokenOf(req);
  if (!token) return res.status(401).json({ ok: false, error: 'session_unknown' });
  const body = req.body || {};
  const v = await seatVerify.verifySessionToken(token, {
    surface: body.surface || null, platform: body.platform || null, req,
  });
  if (!v.ok) return res.status(401).json({ ok: false, error: v.error });
  return res.json({
    ok: true,
    seat: await seatOf(v.user),
    session: {
      id: v.session.id,
      surface: v.session.surface,
      platform: v.session.platform,
      client_root: v.session.client_root,
      expires_at: Number(v.session.expires_at),
      last_seen_at: Number(v.session.last_seen_at),
    },
  });
});

router.post('/onemind/session/refresh', authLimiter, express.json(), async (req, res) => {
  const body = req.body || {};
  const refreshToken = String(body.refresh_token || req.get('x-refresh-token') || '').trim();
  if (!refreshToken) return res.status(400).json({ ok: false, error: 'refresh_token required' });
  const out = await seatVerify.refreshSession(refreshToken, {
    platform: body.platform || null, req,
  });
  if (!out.ok) return res.status(401).json({ ok: false, error: out.error });
  return res.json({
    ok: true,
    session_token: out.session_token,
    refresh_token: out.refresh_token,
    expires_at: out.expires_at,
    refresh_expires_at: out.refresh_expires_at,
    seat: out.user ? await seatOf(out.user) : null,
  });
});

router.post('/onemind/session/revoke', express.json(), async (req, res) => {
  const body = req.body || {};
  const out = await seatVerify.revokeSession({
    sessionToken: sessionTokenOf(req) || null,
    refreshToken: String(body.refresh_token || '').trim() || null,
    req,
  });
  if (!out.ok) return res.status(401).json({ ok: false, error: out.error });
  return res.json({ ok: true, revoked: true });
});

router.get('/onemind/entitlements', verifyLimiter, async (req, res) => {
  const user = await requireSeat(req, res);
  if (!user) return;
  const truth = await seatVerify.entitlementsFor(user);
  return res.json({ ok: true, seat: await seatOf(user), ...truth });
});

router.post('/onemind/entitlements/check', checkLimiter, express.json(), async (req, res) => {
  const user = await requireSeat(req, res);
  if (!user) return;
  const body = req.body || {};
  const claims = body.claims !== undefined ? body.claims : body.product;
  if (claims === undefined) return res.status(400).json({ ok: false, error: 'claims required' });
  const { results } = await seatVerify.checkClaims(user, claims, {
    surface: body.surface || null, platform: body.platform || null, req,
  });
  return res.json({ ok: true, seat: await seatOf(user), results });
});

// ---- the audit door -------------------------------------------------------
function serviceAuthorized(req) {
  const expected = process.env.MUSE_SERVICE_TOKEN || '';
  if (!expected) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = Buffer.from(m[1], 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.get('/onemind/watch', async (req, res) => {
  if (!process.env.MUSE_SERVICE_TOKEN) return res.status(404).json({ ok: false });
  if (!serviceAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const summary = await seatVerify.watchSummary(req.query.limit);
  return res.json({ ok: true, ...summary });
});

module.exports = router;
