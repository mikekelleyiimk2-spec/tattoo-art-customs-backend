// OneMind sign-in — the one account (migration 110, contract:
// RENAME NOTE (Oct 28 2026): the platform brand is now Chorvix (owner strike, coined-word clearance round). Internal working names — files, routes (/onemind, /api/onemind), ids (onemind_id), env (ONEMIND_STANDALONE) — keep the onemind names by standing law; only people-facing copy carries Chorvix.
// docs/onemind-signin-contract.md). Owner law restated 2026-10-26:
// logging into anything we own IS the OneMind login. This backend
// is OneMind (the hub where the plugs run together); the OneMind
// app is one window into it, and NO surface depends on the app
// being installed for the tie to attach.
//
//   POST /api/onemind/signin  the door for apps: {email, password,
//                             surface} -> the seat (canonical
//                             identity + this seating's tie + the
//                             recognition summary + api_token for
//                             later seat reads). The surface is
//                             validated against the registry BEFORE
//                             credentials are checked, and a kids'
//                             or unknown surface seats nothing.
//   GET  /api/onemind/seat    x-api-token -> the recognition
//                             payload: first-seated anywhere, every
//                             surface holding a tie, tie count.
//                             This is what a surface renders to
//                             greet a known seat — recognition is
//                             the default, introduction is the
//                             failure mode.
//   POST /api/onemind/tie     x-api-token + {surface} -> record a
//                             seating for an already-signed-in
//                             session (app relaunch, token held).
//   GET  /api/onemind/ties    Muse service-token only (timing-safe
//                             Bearer MUSE_SERVICE_TOKEN; 404 when
//                             unset, 401 on a bad token): the book
//                             view — aggregate ties per surface, no
//                             per-person data. Read-only.
//
// The web doors (/login, /signup, /api/bootstrap, /api/link-account)
// resolve to the same account record and seat the 'website' tie —
// there is one account, never a second store.
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const onemind = require('../lib/onemind');
const seatClaims = require('../lib/seatClaims');
const pendingTies = require('../lib/pendingTies');
const surfaces = require('../lib/surfaces');
const { sendMail } = require('../lib/mail');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

function serviceToken() {
  return process.env.MUSE_SERVICE_TOKEN || '';
}

function serviceAuthorized(req) {
  const expected = serviceToken();
  if (!expected) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = Buffer.from(m[1], 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function userFromToken(req) {
  const token = String(req.get('x-api-token') || req.query.api_token || '').slice(0, 128);
  if (!token) return null;
  return db.get('SELECT * FROM users WHERE api_token = ?', [token]);
}

router.post('/onemind/signin', authLimiter, express.json(), async (req, res) => {
  const surfaceId = String((req.body && req.body.surface) || '').slice(0, 64);
  // The surface is judged first: a surface that cannot hold a tie
  // (every kids' surface, anything unregistered) seats nothing and
  // learns nothing about the credentials.
  if (!surfaces.isTieable(surfaceId)) {
    return res.status(400).json({ ok: false, error: 'surface_not_tieable', surface: surfaceId || null });
  }
  const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 160);
  const password = String((req.body && req.body.password) || '').slice(0, 200);
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'email and password required' });
  }
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ ok: false, error: 'invalid credentials' });
  }
  if (!user.api_token) {
    user.api_token = crypto.randomBytes(24).toString('hex');
    await db.update('users', user.id, { api_token: user.api_token });
  }
  const tie = await onemind.recordTie(user.id, surfaceId);
  const seat = await onemind.seatSummary(user);
  return res.json({
    ok: true,
    ...seat,
    api_token: user.api_token,
    seat_surface: surfaceId,
    tie: tie.ok ? tie.tie : null,
  });
});

router.get('/onemind/seat', async (req, res) => {
  const user = await userFromToken(req);
  if (!user) return res.status(401).json({ ok: false, error: 'not linked' });
  const seat = await onemind.seatSummary(user);
  return res.json({ ok: true, ...seat });
});

router.post('/onemind/tie', express.json(), async (req, res) => {
  const user = await userFromToken(req);
  if (!user) return res.status(401).json({ ok: false, error: 'not linked' });
  const surfaceId = String((req.body && req.body.surface) || '').slice(0, 64);
  if (!surfaces.isTieable(surfaceId)) {
    return res.status(400).json({ ok: false, error: 'surface_not_tieable', surface: surfaceId || null });
  }
  const tie = await onemind.recordTie(user.id, surfaceId);
  if (!tie.ok) return res.status(400).json({ ok: false, error: tie.error });
  const seat = await onemind.seatSummary(user);
  return res.json({ ok: true, tie: tie.tie, ...seat });
});

// --- The device-email link (migration 111) ---
// No sign-in never means no link. A surface with no signed-in user
// offers the device's email (picked by the person — the pick is the
// consent); start records a pending claim and emails ONE verify
// link; the tap is the sitting (see lib/seatClaims.js). The same
// email is sign-in, sign-up, register, and verify in one mechanism.
// The API response NEVER reveals whether the email already holds an
// account, and the verify token travels by email only — the
// response carries just the claim handle for the device to poll.
router.post('/onemind/link/start', authLimiter, express.json(), async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 160);
  const surfaceId = String((req.body && req.body.surface) || '').slice(0, 64);
  const claim = await seatClaims.startClaim(email, surfaceId);
  if (!claim.ok) {
    return res.status(400).json({ ok: false, error: claim.error });
  }
  const link = `${config.baseUrl}/api/onemind/link/verify?token=${claim.token}`;
  // Best effort like the password-reset door: the claim is already
  // recorded; a mail failure must not leak or 500 the start.
  try {
    await sendMail({
      to: claim.email,
      subject: 'Your Chorvix sign-in link',
      text: [
        'Tap this link to finish — it signs you in, or creates your Chorvix account if you\u2019re new.',
        'One account works on everything Useful Appz makes, and this tap seats you at the table.',
        '',
        link,
        '',
        'The link works once and expires in 1 hour. If you didn\u2019t ask for it, ignore this email.',
      ].join('\n'),
    });
  } catch (e) { console.error('onemind link email failed:', e.message); }
  return res.json({
    ok: true, claim_id: claim.claim_id,
    claim_secret: claim.claim_secret, expires_at: claim.expires_at,
  });
});

router.get('/onemind/link/verify', async (req, res) => {
  const result = await seatClaims.verifyClaim(String(req.query.token || ''));
  if (!result.ok) {
    if (req.query.format === 'json') {
      return res.status(400).json({ ok: false, error: result.error });
    }
    return res.status(400).render('error', {
      title: 'That link couldn\u2019t seat you',
      message: 'The link is invalid, expired, or already used. Open the app or site again and ask for a fresh one — it only takes a tap.',
    });
  }
  if (req.query.format === 'json') {
    return res.json({
      ok: true, created_account: result.created_account,
      linked_orders: result.linked_orders || 0,
      ...result.seat, api_token: result.user.api_token,
    });
  }
  return res.render('onemind/verified', {
    title: 'You\u2019re seated — Chorvix',
    seat: result.seat, createdAccount: result.created_account,
  });
});

router.post('/onemind/link/status', express.json(), async (req, res) => {
  const result = await seatClaims.claimStatus(
    (req.body && req.body.claim_id) || '', (req.body && req.body.claim_secret) || '');
  if (!result.ok) return res.status(401).json({ ok: false, error: result.error });
  return res.json(result);
});

router.get('/onemind/ties', async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!serviceAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const book = await onemind.tieBook();
  return res.json({ ok: true, ...book });
});

// --- Pending ties: the sideload guest bridge (migration 113) ---
// Guest paid-app purchases record pending ties while the app is
// sideload-only (contract §10). The go-live trigger is a service
// call, not a build: POST /onemind/pending-ties/fire {app_key}
// flips the app live and fires one bridge claim per waiting buyer;
// from then on that app's guest buys claim on buy, like designs.
// GET returns the aggregate book (counts + live flags, no emails).
router.get('/onemind/pending-ties', async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!serviceAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const book = await pendingTies.pendingTieBook();
  return res.json({ ok: true, ...book });
});

router.post('/onemind/pending-ties/fire', express.json(), async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!serviceAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const appKey = String((req.body && req.body.app_key) || '').trim().slice(0, 128);
  if (!appKey) return res.status(400).json({ ok: false, error: 'app_key required' });
  const result = await pendingTies.firePendingTies(appKey);
  return res.json({ ok: true, ...result });
});

module.exports = router;
