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
const config = require('../config');
const surfaces = require('./surfaces');
const onemind = require('./onemind');
const { ensureReferralCode } = require('./referrals');
const { sendMail } = require('./mail');

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
// whether the email already holds an account. claimSource records
// honestly how the claim came to be ('device-email' for the §7
// link; 'guest-purchase' for the guest bridge, §10).
async function startClaim(emailRaw, surfaceId, claimSource = 'device-email') {
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
    status: 'pending', claim_source: claimSource,
    user_id: null, created_at: now, expires_at: now + LINK_TTL_MS, verified_at: null,
  });
  return {
    ok: true, claim_id: id, claim_secret: claimSecret,
    expires_at: now + LINK_TTL_MS, token, email, surface: surfaceId,
  };
}

// Attach a seated buyer's guest purchases to their seat (the guest
// bridge, owner ruling 2026-10-26): every PAID order still carrying
// the guest sentinel (buyer_id '') under this delivery email gains
// the account reference. guest_email stays on the row — it is the
// honest record of how the order began. Returns how many attached.
async function linkGuestOrders(userId, email) {
  const rows = await db.all(
    "SELECT id FROM orders WHERE guest_email = ? AND buyer_id = '' AND status = 'paid'",
    [String(email || '').trim().toLowerCase()]);
  for (const r of rows) {
    await db.update('orders', r.id, { buyer_id: userId });
  }
  return rows.length;
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
  // A purchase claim's tap does double duty (owner ruling
  // 2026-10-26): it signs the buyer in AND attaches their guest
  // purchases to the seat, so the seat summary recognizes what
  // they already hold.
  let linkedOrders = 0;
  if (claim.claim_source === 'guest-purchase') {
    linkedOrders = await linkGuestOrders(user.id, claim.email);
  }
  const seat = await onemind.seatSummary(user);
  return {
    ok: true, user, created_account: createdAccount, seat, tie: tie.tie,
    linked_orders: linkedOrders,
  };
}

// The guest bridge's claim (owner ruling 2026-10-26 19:21, contract
// §10): a completed guest purchase fires ONE claim for the buyer's
// delivery email on the website surface, framed as what it is —
// "your purchase is tied to your seat; one tap finishes it." The
// tap signs the buyer in (or creates the account) and attaches the
// order (see verifyClaim). Dedupe is part of the ruling: one claim
// per purchase event, and never a re-mail on repeat buys inside a
// short window — if a claim for this email on the website is
// already pending, or one was started within the link TTL, this is
// a no-op. Never throws into the checkout path: payment is already
// captured when this runs, so failures are logged, not surfaced.
async function startPurchaseClaim(emailRaw) {
  const email = String(emailRaw || '').trim().toLowerCase().slice(0, 160);
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email', mailed: false };
  try {
    const pending = await db.get(
      "SELECT id FROM seat_claims WHERE email = ? AND surface = 'website' AND status = 'pending'",
      [email]);
    if (pending) return { ok: true, mailed: false, skipped: 'pending_claim', claim_id: pending.id };
    const recent = await db.get(
      "SELECT id FROM seat_claims WHERE email = ? AND surface = 'website' AND created_at > ? ORDER BY created_at DESC",
      [email, db.now() - LINK_TTL_MS]);
    if (recent) return { ok: true, mailed: false, skipped: 'recent_claim', claim_id: recent.id };
    const claim = await startClaim(email, 'website', 'guest-purchase');
    if (!claim.ok) return { ok: false, error: claim.error, mailed: false };
    const link = `${config.baseUrl}/api/onemind/link/verify?token=${claim.token}`;
    try {
      await sendMail({
        to: email,
        subject: 'Your purchase is tied to your Chorvix seat — one tap finishes it',
        text: [
          'Thanks for your purchase.',
          '',
          'Your purchase is tied to your Chorvix seat — one tap finishes it:',
          'the tap signs you in (or creates your account if you\u2019re new) and',
          'attaches your purchase to your seat, so it\u2019s there whenever you',
          'open anything Useful Appz makes.',
          '',
          link,
          '',
          'The link works once and expires in 1 hour. If you didn\u2019t buy',
          'anything from Tattoo Art Customs, ignore this email.',
        ].join('\n'),
      });
      return { ok: true, mailed: true, claim_id: claim.claim_id };
    } catch (e) {
      console.error('guest bridge claim email failed:', e.message);
      return { ok: true, mailed: false, skipped: 'mail_failed', claim_id: claim.claim_id };
    }
  } catch (e) {
    console.error('guest bridge claim failed:', e.message);
    return { ok: false, error: 'bridge_failed', mailed: false };
  }
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

module.exports = {
  startClaim, verifyClaim, claimStatus, hashToken, LINK_TTL_MS,
  startPurchaseClaim, linkGuestOrders,
};
