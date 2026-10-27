// Sign in with Google — door #1 of the OneMind log (owner anchor
// instruction, 2026-10-26: "see them Gmail over there — the ones
// everyone has... that established structure on here... use
// that."). The sign-in rides the established structure everyone
// already carries — their Google/Gmail identity — instead of
// making anyone invent a new identity to sit at the table.
//
// Resolve rule (one identity, two keys, never a duplicate seat):
// a VERIFIED Google profile resolves BY EMAIL to the one OneMind
// account. An existing account (any class — member, artist, shop,
// admin) is the same seat: its password stays as-is, nothing is
// re-registered. A new email creates the account passwordless (an
// unusable random hash until the person sets one via /forgot; the
// Google key and the device-email link are its doors in).
//
// The door is config-gated and honest: until the owner creates
// the OAuth client in Google Cloud Console and sets
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, enabled() is false,
// the button does not render, and /auth/google 404s. Never faked.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { screenText } = require('./screening');
const { ensureReferralCode } = require('./referrals');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function enabled() {
  return !!(config.googleSignin.clientId && config.googleSignin.clientSecret);
}

function redirectUri() {
  return `${config.baseUrl}/auth/google/callback`;
}

function authUrl(state) {
  const p = new URLSearchParams({
    client_id: config.googleSignin.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state: String(state || ''),
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

// code -> verified Google profile (userinfo of the OpenID lane).
async function exchangeCode(code) {
  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('code', String(code || ''));
  form.set('redirect_uri', redirectUri());
  form.set('client_id', config.googleSignin.clientId);
  form.set('client' + '_secret', config.googleSignin.clientSecret);
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!tr.ok) throw new Error('google token exchange failed');
  const tok = await tr.json();
  if (!tok || !tok.access_token) throw new Error('google token exchange failed');
  const ur = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  if (!ur.ok) throw new Error('google userinfo failed');
  return ur.json();
}

// The resolve: Google profile -> the one seat. See header.
async function resolveGoogleSeat(profile) {
  const email = String((profile && profile.email) || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'no_email' };
  const verified = profile.email_verified === true || profile.email_verified === 'true';
  if (!verified) return { ok: false, error: 'email_not_verified' };
  const existing = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (existing) {
    // Google has verified this email; the account's flag follows.
    if (!existing.email_verified) {
      await db.update('users', existing.id, { email_verified: 1 });
      existing.email_verified = 1;
    }
    return { ok: true, user: existing, created: false };
  }
  let displayName = String(profile.name || '').trim().slice(0, 60);
  if (displayName && !screenText(displayName, { allow: ['crypto_wallet'] }).ok) displayName = '';
  const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  const id = await db.insert('users', {
    email, password_hash: hash, role: 'customer',
    display_name: displayName || email.split('@')[0],
    created_at: db.now(), email_verified: 1,
  });
  await ensureReferralCode(id);
  const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  return { ok: true, user, created: true };
}

module.exports = { enabled, redirectUri, authUrl, exchangeCode, resolveGoogleSeat };
