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
  await enforceSessionCap(req); // new account: no other sessions, a no-op
  if (!req.session.flash) req.session.flash = 'Welcome to Tattoo Art Customs!';
  res.redirect(req.session.returnTo || '/account');
});

router.get('/login', (req, res) => res.render('auth/login', {
  title: 'Log in — Tattoo Art Customs', metaDescription: 'Log in to Tattoo Art Customs.',
}));
router.post('/login', authLimiter, checkHoneypot, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    req.session.flash = 'Email or password is incorrect.';
    return res.redirect('/login');
  }
  req.session.userId = user.id;
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
    await sendMail({
      to: user.email, subject: 'Reset your Tattoo Art Customs password',
      text: `Reset your password here (valid 1 hour): ${link}`,
    });
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
