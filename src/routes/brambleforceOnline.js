// Brambleforce online doors (migration 126, lib/brambleforceOnline):
// campaign progress roaming + the online arena leaderboard.
// RENAME NOTE (standing law): people-facing name is Chorvix; route
// paths keep the house's internal names like every other door.
//
// The contract the game client codes against (full spec:
// docs/brambleforce-online-contract.md):
//
//   GET  /api/brambleforce/progress
//     Auth: Authorization: Bearer <session_token>, or the
//     x-session-token header, or x-api-token (the seat key) — the
//     same proofs as /api/onemind/verify.
//     -> 200 { ok:true, seat:{...}, rev, updated_at,
//              progress: <blob|null> }
//     -> 401 { ok:false, error:'not linked' }
//
//   PUT  /api/brambleforce/progress
//     Auth as above. Body { base_rev?, progress:<blob> }.
//     The server sanitizes, merges against the stored blob
//     (furthest-progress-wins, never a downgrade) and answers with
//     the merged truth — the client adopts it locally.
//     -> 200 { ok:true, seat, rev, updated_at, progress,
//              merged_from_conflict }
//     -> 400 { ok:false, error:'progress_too_large' | 'bad_progress' }
//
//   POST /api/brambleforce/leaderboard/results
//     Auth as above. Body { match_id, ladder:'hero'|'villain',
//     place, side_size, won, desert, points_delta, claimed_after?,
//     season:{ series, season } }. There is NO display_name field:
//     the board reads the seat's name from the seat, never from the
//     client. A retried match_id answers with the original
//     acceptance (duplicate:true) and counts nothing twice.
//     -> 200 { ok:true, accepted:true, duplicate, season,
//              totals:{ points, wins, matches }, rank }
//     -> 400 { ok:false, error:'bad_match_id' | 'bad_ladder' |
//              'bad_side_size' | 'bad_place' | 'bad_desert_place' |
//              'bad_points_delta' | 'bad_season' | 'bad_claimed_after' }
//     -> 429 { ok:false, error:'too_fast' }
//
//   GET  /api/brambleforce/leaderboard?ladder=hero|villain|combined
//       &season=<series>_<season>&limit=1..100
//     Auth as above (the answer carries the caller's own rank).
//     -> 200 { ok:true, seat, season, ladder,
//              entries:[{ rank, display_name, points, wins,
//                         matches, you }],
//              you:{ rank, points, wins, matches } | null }
//
// Game clients call cross-origin (file:///android_asset origin), so
// — exactly like the verify doors — these paths carry their own
// scoped CORS and nothing else does.
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const onemind = require('../lib/onemind');
const seatVerify = require('../lib/seatVerify');
const bfOnline = require('../lib/brambleforceOnline');

const router = express.Router();

function onlineCors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-token, x-session-token');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
}
router.use('/brambleforce/progress', onlineCors);
router.use('/brambleforce/leaderboard', onlineCors);

const relaxed = process.env.NODE_ENV === 'test' ? 100000 : null;
const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: relaxed || 900,
  standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ ok: false, error: 'rate_limited' }),
});
const writeLimiter = rateLimit({
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
    display_name: onemind.seatDisplayName(user),
  };
}

// Same resolution as the verify doors: any proven seat, else a 401
// 'not linked' (presented-but-invalid proofs are recorded by
// lib/seatVerify in the watch, as at every door).
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
  res.status(401).json({ ok: false, error: 'not linked' });
  return null;
}

router.get('/brambleforce/progress', readLimiter, async (req, res) => {
  const user = await requireSeat(req, res);
  if (!user) return;
  const got = await bfOnline.getProgress(user.id);
  return res.json({
    ok: true,
    seat: await seatOf(user),
    rev: got ? got.rev : 0,
    updated_at: got ? got.updated_at : null,
    progress: got ? got.progress : null,
  });
});

router.put('/brambleforce/progress', writeLimiter, async (req, res) => {
  const user = await requireSeat(req, res);
  if (!user) return;
  const body = req.body || {};
  if (!body.progress || typeof body.progress !== 'object' || Array.isArray(body.progress)) {
    return res.status(400).json({ ok: false, error: 'bad_progress' });
  }
  const put = await bfOnline.putProgress(user.id, body.progress, body.base_rev);
  if (!put.ok) return res.status(400).json({ ok: false, error: put.error });
  await seatVerify.logEvent({
    user, kind: 'bf_progress_put',
    detail: put.merged_from_conflict ? 'merged_from_conflict' : `rev_${put.rev}`,
    surface: 'brambleforce-game', req,
  });
  return res.json({
    ok: true,
    seat: await seatOf(user),
    rev: put.rev,
    updated_at: put.updated_at,
    progress: put.progress,
    merged_from_conflict: put.merged_from_conflict,
  });
});

router.post('/brambleforce/leaderboard/results', writeLimiter, async (req, res) => {
  const user = await requireSeat(req, res);
  if (!user) return;
  const out = await bfOnline.submitResult(user, req.body || {});
  if (!out.ok) {
    await seatVerify.logEvent({
      user, kind: 'bf_result_rejected', detail: out.error,
      surface: 'brambleforce-game', req,
    });
    return res.status(out.status || 400).json({ ok: false, error: out.error });
  }
  await seatVerify.logEvent({
    user, kind: 'bf_result_submit',
    detail: out.duplicate ? 'duplicate' : out.season,
    surface: 'brambleforce-game', req,
  });
  return res.json({
    ok: true,
    seat: await seatOf(user),
    accepted: true,
    duplicate: out.duplicate,
    season: out.season,
    totals: out.totals,
    rank: out.rank,
  });
});

router.get('/brambleforce/leaderboard', readLimiter, async (req, res) => {
  const user = await requireSeat(req, res);
  if (!user) return;
  const ladderParam = String(req.query.ladder || 'combined');
  const ladder = ladderParam === 'hero' || ladderParam === 'villain' ? ladderParam : null;
  const seasonParam = typeof req.query.season === 'string' && /^\d{1,3}_\d{1,4}$/.test(req.query.season)
    ? req.query.season : null;
  const board = await bfOnline.leaderboard({
    seasonKey: seasonParam,
    ladder,
    limit: req.query.limit,
    forUser: user,
  });
  return res.json({
    ok: true,
    seat: await seatOf(user),
    season: board.season,
    ladder: board.ladder,
    entries: board.entries,
    you: board.you,
  });
});

module.exports = router;
