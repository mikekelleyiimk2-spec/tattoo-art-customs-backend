// Seat claims — the device-email link (migration 111, owner
// correction 2026-10-26). No sign-in never means no link: the email
// on the device is the thread.
//
// Flow: a surface with no signed-in user offers the device's email
// (the person picks it — the pick is the consent; an app must never
// harvest an address silently). startClaim records a PENDING claim
// (one per email per surface; starting a new one expires the old)
// and the route emails ONE verify link. The tap IS the sitting:
// verifyClaim activates the seat —
//   - an existing account under that email is signed in
//     passwordlessly (everything it already holds is already keyed
//     to it; nothing moves, nothing is re-registered);
//   - a new email REGISTERS a real account (mailbox proven, so
//     email_verified is set; its password is an unguessable random
//     hash until the person sets one through the forgot-password
//     door — the email link remains their passwordless way in);
// and writes the tie for the claim's surface. claim_source stays on
// the claim row ('device-email') so the book records honestly how
// the seat was claimed. Links are single-use and expire in 1 hour.
// Only hashes of the token and the claim secret are ever stored.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const surfaces = require('./surfaces');
const onemind = require('./onemind');
const { ensureReferralCode } = require('./referrals');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINK_TTL_MS = 60 * 60 * 1000; // 1 hour, same as password resets

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function secretMatches(raw, storedHash) {
  const a = Buffer.from(hashToken(raw), 'utf8');
  const b = Buffer.from(String(storedHash || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Creates the pending claim. Returns the raw token + claim secret
// ONCE, for the caller (the route emails the token; the initiating
// device keeps the secret to poll claimStatus). Never reveals
// whether the email already holds an account.
async function startClaim(emailRaw, surfaceId) {
  if (!surfaces.isTieable(surfaceId)) {
    return { ok: false, error: 'surface_not_tieable', surface: surfaceId || null };
  }
  const email = String(emailRaw || '').trim().toLowerCase().slice(0, 160);
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' };
  const now = db.now();
  // One pending claim per email per surface: the new claim retires
  // every older pending one for the same pair.
  const stale = await db.all(
    "SELECT id FROM seat_claims WHERE email = ? AND surface = ? AND status = 'pending'",
    [email, surfaceId]);
  for (const row of stale) {
    await db.update('seat_claims', row.id, { status: 'expired' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const claimSecret = crypto.randomBytes(16).toString('hex');
  const id = await db.insert('seat_claims', {
    email, surface: surfaceId,
    token_hash: hashToken(token),
    claim_secret_hash: hashToken(claimSecret),
    status: 'pending', claim_source: 'device-email',
    user_id: null, created_at: now, expires_at: now + LINK_TTL_MS, verified_at: null,
  });
  return {
    ok: true, claim_id: id, claim_secret: claimSecret,
    expires_at: now + LINK_TTL_MS, token, email, surface: surfaceId,
  };
}

// The tap. Activates the seat and writes the tie. Single-use.
async function verifyClaim(rawToken) {
  const claim = await db.get('SELECT * FROM seat_claims WHERE token_hash = ?', [hashToken(rawToken)]);
  if (!claim) return { ok: false, error: 'invalid_link' };
  if (claim.status === 'verified') return { ok: false, error: 'link_already_used' };
  const now = db.now();
  if (claim.status !== 'pending' || Number(claim.expires_at) <= now) {
    if (claim.status === 'pending') {
      await db.update('seat_claims', claim.id, { status: 'expired' });
    }
    return { ok: false, error: 'link_expired' };
  }
  let user = await db.get('SELECT * FROM users WHERE email = ?', [claim.email]);
  let createdAccount = false;
  if (!user) {
    const unusablePassword = crypto.randomBytes(32).toString('hex');
    const hash = await bcrypt.hash(unusablePassword, 12);
    const prefix = claim.email.split('@')[0].replace(/[^\w .-]/g, '').trim().slice(0, 60);
    const id = await db.insert('users', {
      email: claim.email, password_hash: hash, role: 'customer',
      display_name: prefix || 'Member', created_at: now, email_verified: 1,
    });
    try { await ensureReferralCode(id); } catch (e) { console.error('referral code on link-register failed:', e.message); }
    user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    createdAccount = true;
  } else if (!user.email_verified) {
    // The mailbox just proved itself — that is email verification.
    await db.update('users', user.id, { email_verified: 1 });
    user.email_verified = 1;
  }
  if (!user.api_token) {
    user.api_token = crypto.randomBytes(24).toString('hex');
    await db.update('users', user.id, { api_token: user.api_token });
  }
  await onemind.ensureOneMindId(user);
  const tie = await onemind.recordTie(user.id, claim.surface);
  if (!tie.ok) return { ok: false, error: tie.error };
  await db.update('seat_claims', claim.id, {
    status: 'verified', verified_at: now, user_id: user.id,
  });
  const seat = await onemind.seatSummary(user);
  return { ok: true, user, created_account: createdAccount, seat, tie: tie.tie };
}

// The initiating device polls this with the claim secret it was
// handed at start. The secret never leaves the device; the email
// token never leaves the mailbox. Together they hand the seat to
// the device that asked and the person who proved the mailbox.
async function claimStatus(claimId, claimSecret) {
  const claim = await db.get('SELECT * FROM seat_claims WHERE id = ?', [String(claimId || '')]);
  if (!claim || !secretMatches(claimSecret, claim.claim_secret_hash)) {
    return { ok: false, error: 'unknown_claim' };
  }
  if (claim.status === 'verified') {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [claim.user_id]);
    if (!user) return { ok: false, error: 'unknown_claim' };
    const seat = await onemind.seatSummary(user);
    return { ok: true, status: 'verified', ...seat, api_token: user.api_token };
  }
  if (claim.status === 'pending' && Number(claim.expires_at) <= db.now()) {
    await db.update('seat_claims', claim.id, { status: 'expired' });
    return { ok: true, status: 'expired' };
  }
  return { ok: true, status: claim.status === 'pending' ? 'pending' : 'expired' };
}

module.exports = { startClaim, verifyClaim, claimStatus, hashToken, LINK_TTL_MS };
