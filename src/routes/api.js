// JSON API for the Android app: account linking + linked-account info.
// The app POSTs the user's website email + password once, stores the
// returned api_token, and sends it with /play/verify so Play purchases
// attach to (and activate memberships on) the website account.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { hasAnyActiveSubscription } = require('../middleware/auth');
const { authLimiter, checkHoneypot } = require('../middleware/rateLimit');

const router = express.Router();

function publicUser(user, isSubscriber) {
  return {
    ok: true,
    user_id: user.id,
    api_token: user.api_token,
    email: user.email,
    display_name: user.display_name || '',
    role: user.role,
    is_subscriber: !!isSubscriber,
  };
}

// Link the app to a website account: verify credentials, mint/return api_token.
router.post('/link-account', authLimiter, checkHoneypot, express.json(), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 160);
  const password = String(req.body?.password || '').slice(0, 200);
  if (!email || !password) return res.status(400).json({ ok: false, error: 'email and password required' });
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ ok: false, error: 'invalid credentials' });
  }
  if (!user.api_token) {
    user.api_token = db.newId() + db.newId();
    await db.update('users', user.id, { api_token: user.api_token });
  }
  const isSub = user.role === 'admin' || await hasAnyActiveSubscription(user.id);
  return res.json(publicUser(user, isSub));
});

// Linked-account info for the app (header x-api-token).
async function userFromToken(req) {
  const token = String(req.get('x-api-token') || req.query.api_token || '').slice(0, 128);
  if (!token) return null;
  return db.get('SELECT * FROM users WHERE api_token = ?', [token]);
}

router.get('/me', async (req, res) => {
  const user = await userFromToken(req);
  if (!user) return res.status(401).json({ ok: false, error: 'not linked' });
  const isSub = user.role === 'admin' || await hasAnyActiveSubscription(user.id);
  return res.json(publicUser(user, isSub));
});

// Bootstrap a website session inside the app's WebView: the app loads
// /api/bootstrap?api_token=<token>&next=/studio, we set the session cookie
// and redirect. Lets linked app users reach subscriber pages (Design Studio)
// without typing their password into the WebView.
router.get('/bootstrap', async (req, res) => {
  const token = String(req.query.api_token || '').slice(0, 128);
  const next = String(req.query.next || '/account').slice(0, 200);
  if (!token) return res.status(401).render('error', { title: 'Not linked', message: 'Link your website account in the app first.' });
  const user = await db.get('SELECT id FROM users WHERE api_token = ?', [token]);
  if (!user) return res.status(401).render('error', { title: 'Not linked', message: 'Link your website account in the app first.' });
  req.session.userId = user.id;
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/account';
  res.redirect(safeNext);
});

module.exports = { router, userFromToken };
