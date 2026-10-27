// Email + password auth, password reset. Roles: customer (default),
// design_artist, tattoo_shop, admin. Upgrading to artist/shop happens
// through an active membership subscription (see routes/memberships.js).
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { sendMail } = require('../lib/mail');
const config = require('../config');
const { authLimiter, checkHoneypot } = require('../middleware/rateLimit');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const { ensureReferralCode, recordSignupReferral } = require('../lib/referrals');
const onemind = require('../lib/onemind');
const googleSeat = require('../lib/googleSeat');
const { screenText } = require('../lib/screening');
const { enforceSessionCap } = require('../lib/sessionLimits');

router.get('/signup', async (req, res) => {
  // Friend referral links look like /signup?ref=TAC-XXXXXX — remember the
  // code in a cookie so the signup POST can credit the referrer.
  const ref = String(req.query.ref || '').slice(0, 16);
  if (ref) res.cookie('ref_code', ref, { maxAge: 30 * 86400000, httpOnly: true, sameSite: 'lax' });
  res.render('auth/signup', {
    title: 'Create account — Tattoo Art Customs', metaDescription: 'Create your Tattoo Art Customs account.',
    referralCode: String(ref || req.cookies?.ref_code || '').slice(0, 16),
    googleSignin: googleSeat.enabled(),
  });
});
router.post('/signup', authLimiter, checkHoneypot, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const displayName = String(req.body.display_name || '').trim().slice(0, 60);
  if (displayName) {
    // Bare "wallet" is not actionable contact info in a name; everything else stays blocked.
    const nameScreen = screenText(displayName, { allow: ['crypto_wallet'] });
    if (!nameScreen.ok) {
      req.session.flash = 'Display name may not contain contact info or off-site links. (' +
        nameScreen.flags.map((f) => f.label).join(', ') + ')';
      return res.redirect('/signup');
    }
  }
  if (!EMAIL_RE.test(email)) { req.session.flash = 'Enter a valid email address.'; return res.redirect('/signup'); }
  if (password.length < 8) { req.session.flash = 'Password must be at least 8 characters.'; return res.redirect('/signup'); }
  if (await db.get('SELECT id FROM users WHERE email = ?', [email])) {
    req.session.flash = 'That email is already registered — try logging in.';
    return res.redirect('/login');
  }
  const hash = await bcrypt.hash(password, 12);
  const id = await db.insert('users', {
    email, password_hash: hash, role: 'customer',
    display_name: displayName || email.split('@')[0],
    created_at: db.now(), email_verified: 0,
  });
  // Every account gets its own referral code; record who referred them.
  await ensureReferralCode(id);
  await recordSignupReferral(id, req.body.referral_code || req.cookies?.ref_code);
  // Opening raffle: a free account created while entries are open gets one
  // entry (idempotent, one entry per person ever).
  try {
    const entry = await require('../lib/founding').enterRaffleOnSignup(id);
    if (entry.entered) {
      req.session.flash = "Welcome to Tattoo Art Customs! You're entered in the Opening Raffle — good luck!";
      // Opening-raffle welcome email (owner-approved copy, 2026-10-09).
      // Fires exactly once: enterRaffleOnSignup reports entered:true only for
      // a genuinely new entry, so existing entrants never get a resend.
      // Best effort — a mail failure must never block signup.
      try {
        await require('../lib/raffleWelcome').sendRaffleWelcomeEmail(email);
      } catch (e) { console.error('raffle welcome email failed:', e.message); }
    }
  } catch (e) { console.error('raffle entry on signup failed:', e.message); }
  req.session.userId = id;
  // OneMind: a new account is a OneMind account, seated at the table
  // the moment it sits down (surface: website). Best-effort — a tie
  // write never breaks a signup.
  await onemind.seatQuietly(id, 'website');
  await enforceSessionCap(req); // new account: no other sessions, a no-op
  if (!req.session.flash) req.session.flash = 'Welcome to Tattoo Art Customs!';
  // Post-auth landing is the person's own account page; an explicit
  // returnTo (deep-link intent) still wins. Nobody is ever funneled
  // to OneMind — it has its own address and is reached only by
  // asking for it (owner ruling 2026-10-27 09:38 CDT). The seat/tie
  // still attaches quietly underneath (seatQuietly above).
  res.redirect(req.session.returnTo || '/account');
});

router.get('/login', (req, res) => res.render('auth/login', {
  title: 'Log in — Tattoo Art Customs', metaDescription: 'Log in to Tattoo Art Customs.',
  googleSignin: googleSeat.enabled(),
}));

// --- Sign in with Google: door #1 of the OneMind log ---
// The established structure everyone already carries (their
// Google/Gmail). A verified Google email resolves BY EMAIL to the
// one seat (lib/googleSeat): an existing account is the same seat
// with its password untouched; a new email is seated in one tap.
// Until the owner's OAuth client exists (config unset), the door
// is closed: no button renders and these routes 404 — never faked.
router.get('/auth/google', (req, res) => {
  if (!googleSeat.enabled()) {
    return res.status(404).render('error', {
      title: 'Not available', message: 'Sign in with Google is not available right now — use your email and password below.',
    });
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.googleState = state;
  res.redirect(googleSeat.authUrl(state));
});
router.get('/auth/google/callback', async (req, res) => {
  if (!googleSeat.enabled()) {
    return res.status(404).render('error', {
      title: 'Not available', message: 'Sign in with Google is not available right now — use your email and password below.',
    });
  }
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const expected = req.session.googleState;
    delete req.session.googleState;
    if (!code || !state || !expected || state !== expected) throw new Error('state_mismatch');
    const profile = await googleSeat.exchangeCode(code);
    const r = await googleSeat.resolveGoogleSeat(profile);
    if (!r.ok || !r.user) throw new Error(r.error || 'resolve_failed');
    req.session.userId = r.user.id;
    // OneMind: the Google door seats the same website tie as every
    // other door — the moment of the sitting is what counts.
    await onemind.seatQuietly(r.user.id, 'website');
    await enforceSessionCap(req);
    if (r.created) {
      // New seat via Google gets the same opening-raffle entry a
      // web signup gets (idempotent, best effort).
      try { await require('../lib/founding').enterRaffleOnSignup(r.user.id); }
      catch (e) { console.error('raffle entry on google signup failed:', e.message); }
      req.session.flash = 'Welcome to Tattoo Art Customs!';
    }
    const dest = req.session.returnTo || '/account';
    delete req.session.returnTo;
    res.redirect(dest);
  } catch (e) {
    console.error('google sign-in failed:', e.message);
    req.session.flash = 'Google sign-in did not complete — try again, or use your email and password.';
    res.redirect('/login');
  }
});
router.post('/login', authLimiter, checkHoneypot, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    req.session.flash = 'Email or password is incorrect.';
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  // OneMind: signing in on the website seats the account's website
  // tie (first-seated sticks, last-seen moves). Best-effort.
  await onemind.seatQuietly(user.id, 'website');
  await enforceSessionCap(req); // evicts oldest sessions when over the plan cap
  const dest = req.session.returnTo || '/account';
  delete req.session.returnTo;
  res.redirect(dest);
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/forgot', (req, res) => res.render('auth/forgot', {
  title: 'Reset password — Tattoo Art Customs', metaDescription: 'Reset your password.',
}));
router.post('/forgot', authLimiter, checkHoneypot, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await db.get('SELECT id, email FROM users WHERE email = ?', [email]);
  // Always respond the same way to avoid leaking which emails exist.
  if (user) {
    const token = crypto.randomBytes(24).toString('hex');
    await db.update('users', user.id, { reset_token: token, reset_expires: Date.now() + 3600 * 1000 });
    const link = `${config.baseUrl}/reset/${token}`;
    // Best effort — a mail failure must never 500 the reset request (the
    // token is already saved; the generic response below must not leak
    // whether the email exists or whether delivery worked).
    try {
      await sendMail({
        to: user.email, subject: 'Reset your Tattoo Art Customs password',
        text: `Reset your password here (valid 1 hour): ${link}`,
      });
    } catch (e) { console.error('password reset email failed:', e.message); }
  }
  req.session.flash = 'If that email is registered, a reset link is on its way.';
  res.redirect('/login');
});

router.get('/reset/:token', async (req, res) => {
  const user = await db.get(
    'SELECT id FROM users WHERE reset_token = ? AND reset_expires > ?', [req.params.token, Date.now()]);
  if (!user) return res.status(400).render('error', { title: 'Invalid link', message: 'This reset link is invalid or expired.' });
  res.render('auth/reset', { title: 'Choose a new password — Tattoo Art Customs', token: req.params.token });
});
router.post('/reset/:token', authLimiter, checkHoneypot, async (req, res) => {
  const user = await db.get(
    'SELECT id FROM users WHERE reset_token = ? AND reset_expires > ?', [req.params.token, Date.now()]);
  if (!user) return res.status(400).render('error', { title: 'Invalid link', message: 'This reset link is invalid or expired.' });
  const password = String(req.body.password || '');
  if (password.length < 8) { req.session.flash = 'Password must be at least 8 characters.'; return res.redirect(`/reset/${req.params.token}`); }
  await db.update('users', user.id, {
    password_hash: await bcrypt.hash(password, 12), reset_token: null, reset_expires: null,
  });
  req.session.flash = 'Password updated — please log in.';
  res.redirect('/login');
});

module.exports = router;
