// JSON API for the Android app: account linking + linked-account info.
// The app POSTs the user's website email + password once, stores the
// returned api_token, and sends it with /play/verify so Play purchases
// attach to (and activate memberships on) the website account.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { hasAnyActiveSubscription } = require('../middleware/auth');
const { isSaleWindow, premadePriceCents, customFullCents } = require('../lib/pricing');
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

// Main design list for app clients: approved gallery-scope designs only.
// Designer pre-design opt-ins are included here; portfolio-only custom
// pieces are NOT (they live on /api/artists/:id).
router.get('/designs', async (req, res) => {
  const rows = await db.all(
    `SELECT d.id, d.title, d.style, d.categories, d.linework_wm_path, d.listing_type,
            u.display_name AS artist_name
     FROM designs d LEFT JOIN users u ON u.id = d.artist_id
     WHERE d.status = 'approved' AND d.listing_scope = 'gallery'
     ORDER BY d.created_at DESC`);
  res.json({
    ok: true,
    sale: isSaleWindow(),
    premade_price_cents: premadePriceCents(),
    designs: rows.map((d) => ({
      id: d.id, title: d.title, style: d.style || '',
      categories: JSON.parse(d.categories || '[]'),
      thumb_url: d.linework_wm_path ? `/img/designs/${String(d.linework_wm_path).split('/').pop()}` : null,
      price_cents: premadePriceCents(),
      listing_type: d.listing_type || 'predesign',
      artist_name: d.artist_name || '',
    })),
  });
});

// Public artist portfolio for app clients (watermarked linework only).
router.get('/artists/:id', async (req, res) => {
  const artist = await db.get(
    "SELECT id, display_name FROM users WHERE id = ? AND role = 'design_artist'", [req.params.id]);
  if (!artist) return res.status(404).json({ ok: false, error: 'not found' });
  const profile = await db.get('SELECT bio FROM artist_profiles WHERE user_id = ?', [artist.id]);
  const rows = await db.all(
    "SELECT id, title, style, categories, linework_wm_path, listing_type FROM designs WHERE artist_id = ? AND status = 'approved' ORDER BY created_at DESC",
    [artist.id]);
  res.json({
    ok: true,
    sale: isSaleWindow(),
    artist: { id: artist.id, display_name: artist.display_name || '', bio: profile ? profile.bio : '' },
    custom_price_cents: customFullCents(),
    premade_price_cents: premadePriceCents(),
    pieces: rows.map((d) => ({
      id: d.id, title: d.title, style: d.style || '',
      categories: JSON.parse(d.categories || '[]'),
      thumb_url: d.linework_wm_path ? `/img/designs/${String(d.linework_wm_path).split('/').pop()}` : null,
      listing_type: d.listing_type || 'predesign',
      price_cents: d.listing_type === 'custom' ? customFullCents() : premadePriceCents(),
    })),
  });
});

module.exports = { router, userFromToken };
