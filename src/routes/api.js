// JSON API for the Android app: account linking + linked-account info.
// The app POSTs the user's website email + password once, stores the
// returned api_token, and sends it with /play/verify so Play purchases
// attach to (and activate memberships on) the website account.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { hasAnyActiveSubscription, isAdminRole, isActiveMember } = require('../middleware/auth');
const { isSaleWindow, premadePriceCents, customFullCents, salePriceActive } = require('../lib/pricing');
const { viewerFor, displayImgFile } = require('../lib/contentPolicy');
const { authLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { enforceSessionCap } = require('../lib/sessionLimits');

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
  const isSub = isAdminRole(user.role) || await hasAnyActiveSubscription(user.id);
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
  const isSub = isAdminRole(user.role) || await hasAnyActiveSubscription(user.id);
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
  // The app reaches the site through this WebView bootstrap, so session
  // cookies carry over and device caps apply automatically (app parity).
  await enforceSessionCap(req);
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/account';
  res.redirect(safeNext);
});

// App quick-buy: create a pending premade order for the linked account and
// hand back the manual checkout path. The app opens that path through
// /api/bootstrap, so the buyer lands signed-in, straight on the payment page.
// No money moves here — payment happens on the /orders/manual/:id page.
router.post('/orders/quick-buy/:designId', express.json(), async (req, res) => {
  const user = await userFromToken(req);
  if (!user) return res.status(401).json({ ok: false, error: 'not linked' });
  const design = await db.get("SELECT * FROM designs WHERE id = ? AND status = 'approved'", [
    req.params.designId,
  ]);
  if (!design) return res.status(404).json({ ok: false, error: 'not available' });
  const member = await isActiveMember(user);
  if (design.members_only && !member) {
    return res.status(403).json({ ok: false, error: 'members only' });
  }
  const {
    premadePriceCents: premadeCents,
    customFullCents: customCents,
    lineworkOnlyPriceCents,
    processingFeeCents,
  } = require('../lib/pricing');
  const isCustom = design.listing_type === 'custom';
  const listPrice = isCustom
    ? customCents(new Date(), member)
    : premadeCents(new Date(), member);
  const lineworkOnly = design.color_source === 'none';
  const price = lineworkOnly ? lineworkOnlyPriceCents(listPrice) : listPrice;
  const fee = processingFeeCents(price);
  const orderId = await db.insert('orders', {
    buyer_id: user.id,
    design_id: design.id,
    order_type: 'premade',
    amount_cents: price,
    fee_cents: fee,
    status: 'pending',
    payment_method: 'paypal',
    referral_code: '',
    referred_shop_id: null,
    linework_only: lineworkOnly ? 1 : 0,
    created_at: db.now(),
  });
  return res.json({ ok: true, checkout_path: `/orders/manual/${orderId}` });
});

// Main design list for app clients: approved gallery-scope designs only.
// Designer pre-design opt-ins are included here; portfolio-only custom
// pieces are NOT (they live on /api/artists/:id). Member-exclusive designs
// are hidden from non-members.
router.get('/designs', async (req, res) => {
  const user = await userFromToken(req);
  const member = await isActiveMember(user);
  const viewer = await viewerFor(user);
  const rows = await db.all(
    `SELECT d.id, d.title, d.style, d.categories, d.linework_wm_path, d.linework_blur_path,
            d.sensitivity, d.artist_id, d.listing_type,
            u.display_name AS artist_name
     FROM designs d LEFT JOIN users u ON u.id = d.artist_id
     WHERE d.status = 'approved' AND d.listing_scope = 'gallery'
       AND (d.members_only = 0 OR ? = 1)
     ORDER BY d.created_at DESC`, [member ? 1 : 0]);
  res.json({
    ok: true,
    sale: await salePriceActive(user),
    premade_price_cents: premadePriceCents(new Date(), member),
    designs: rows.map((d) => ({
      id: d.id, title: d.title, style: d.style || '',
      categories: JSON.parse(d.categories || '[]'),
      thumb_url: (() => { const f = displayImgFile(d, viewer); return f ? `/img/designs/${f}` : null; })(),
      price_cents: premadePriceCents(new Date(), member),
      listing_type: d.listing_type || 'predesign',
      artist_name: d.artist_name || '',
    })),
  });
});

// Public artist portfolio for app clients (watermarked linework only).
router.get('/artists/:id', async (req, res) => {
  const user = await userFromToken(req);
  const member = await isActiveMember(user);
  const artist = await db.get(
    `SELECT u.id, u.display_name, u.is_founding_artist FROM users u
     LEFT JOIN shop_profiles sp ON sp.user_id = u.id
     WHERE u.id = ? AND u.role IN ('design_artist','tattoo_shop','admin','head_admin')`,
    [req.params.id]);
  if (!artist) return res.status(404).json({ ok: false, error: 'not found' });
  const profile = await db.get("SELECT bio FROM artist_profiles WHERE user_id = ? AND bio_status = 'ok'", [artist.id]);
  const rows = await db.all(
    `SELECT id, title, style, categories, linework_wm_path, linework_blur_path,
            sensitivity, artist_id, listing_type
     FROM designs WHERE artist_id = ? AND status = 'approved'
       AND (members_only = 0 OR ? = 1) ORDER BY created_at DESC`,
    [artist.id, member ? 1 : 0]);
  const viewer = await viewerFor(user);
  res.json({
    ok: true,
    sale: await salePriceActive(user),
    artist: { id: artist.id, display_name: artist.display_name || '', bio: profile ? profile.bio : '', is_founding_artist: !!artist.is_founding_artist },
    custom_price_cents: customFullCents(new Date(), member),
    premade_price_cents: premadePriceCents(new Date(), member),
    pieces: rows.map((d) => ({
      id: d.id, title: d.title, style: d.style || '',
      categories: JSON.parse(d.categories || '[]'),
      thumb_url: (() => { const f = displayImgFile(d, viewer); return f ? `/img/designs/${f}` : null; })(),
      listing_type: d.listing_type || 'predesign',
      price_cents: d.listing_type === 'custom' ? customFullCents(new Date(), member) : premadePriceCents(new Date(), member),
    })),
  });
});

// Founding-program status for promo posts: spots left + raffle progress.
router.get('/founding-status', async (req, res) => {
  const s = await require('../lib/founding').getFoundingStatus();
  res.json({
    ok: true,
    artists_left: s.artistsLeft,
    shops_left: s.shopsLeft,
    raffle_entries: s.raffleEntries,
    raffle_entry_target: s.raffleEntryTarget,
    raffle_min_closes_at: s.raffleMinClosesAt,
    raffle_profit_target_cents: s.raffleProfitTargetCents,
    raffle_open: s.raffleOpen,
    raffle_drawn: s.raffleDrawn,
  });
});

// ---- Push notifications ----
// VAPID public key for Web Push subscriptions (site).
router.get('/push/vapid-key', async (req, res) => {
  const { vapidPublicKey } = require('../lib/push');
  const key = await vapidPublicKey();
  if (!key) return res.status(503).json({ ok: false, error: 'push unavailable' });
  res.json({ ok: true, publicKey: key });
});

// Save a Web Push subscription for the logged-in website user.
router.post('/push/subscribe', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'login required' });
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ ok: false, error: 'invalid subscription' });
  }
  const endpoint = String(sub.endpoint).slice(0, 500);
  // Idempotent upsert: one row per endpoint.
  await db.query('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]).catch(() => {});
  await db.insert('push_subscriptions', {
    user_id: req.user.id, endpoint,
    p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 200),
    created_at: db.now(),
  }).catch(() => {});
  res.json({ ok: true });
});

// Remove a Web Push subscription.
router.post('/push/unsubscribe', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'login required' });
  const endpoint = String((req.body && req.body.endpoint) || '').slice(0, 500);
  if (endpoint) {
    await db.query('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.user.id]).catch(() => {});
  }
  res.json({ ok: true });
});

// Send a test push to the logged-in website user's own subscriptions, so
// they can verify end-to-end delivery right after enabling.
router.post('/push/test', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'login required' });
  const { pushToUser } = require('../lib/push');
  const sent = await pushToUser(req.user.id, {
    title: 'Test push',
    body: 'Push notifications are working on this device.',
    url: '/notifications',
  });
  res.json({ ok: true, sent });
});

// Register the native app's Expo push token (x-api-token auth).
router.post('/push/expo-token', express.json(), async (req, res) => {
  const user = await userFromToken(req);
  if (!user) return res.status(401).json({ ok: false, error: 'invalid token' });
  const token = String((req.body && req.body.expo_push_token) || '').slice(0, 200);
  if (!token.startsWith('ExponentPushToken[')) {
    return res.status(400).json({ ok: false, error: 'invalid expo token' });
  }
  await db.query('UPDATE users SET expo_push_token = ? WHERE id = ?', [token, user.id]).catch(() => {});
  res.json({ ok: true });
});

// Wishlist (favorites) for the gallery — [wishlist] feature.
// Guests keep favorites in localStorage only; logged-in users get server
// persistence via the session (req.user). Writes 401 for guests.
async function favoriteIdsFor(userId) {
  const rows = await db.all(
    'SELECT design_id FROM user_favorites WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  return rows.map((r) => r.design_id);
}

async function validFavoriteDesign(designId) {
  const id = String(designId || '').slice(0, 128);
  if (!id) return null;
  return db.get("SELECT id FROM designs WHERE id = ? AND status = 'approved'", [id]);
}

router.get('/favorites', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'login required' });
  return res.json({ ok: true, ids: await favoriteIdsFor(req.user.id) });
});

// Merge guest localStorage favorites into the server set (dedupe).
router.post('/favorites/merge', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'login required' });
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  const now = db.now();
  for (const raw of ids.slice(0, 500)) {
    const design = await validFavoriteDesign(raw);
    if (!design) continue;
    await db.query(
      'INSERT INTO user_favorites (user_id, design_id, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id, design_id) DO NOTHING',
      [req.user.id, design.id, now]);
  }
  return res.json({ ok: true, ids: await favoriteIdsFor(req.user.id) });
});

router.post('/favorites/:designId', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'login required' });
  const design = await validFavoriteDesign(req.params.designId);
  if (!design) return res.status(404).json({ ok: false, error: 'not available' });
  await db.query(
    'INSERT INTO user_favorites (user_id, design_id, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id, design_id) DO NOTHING',
    [req.user.id, design.id, db.now()]);
  return res.json({ ok: true, favorited: true, id: design.id });
});

router.delete('/favorites/:designId', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'login required' });
  const id = String(req.params.designId || '').slice(0, 128);
  await db.query('DELETE FROM user_favorites WHERE user_id = ? AND design_id = ?',
    [req.user.id, id]);
  return res.json({ ok: true, favorited: false, id });
});

module.exports = { router, userFromToken };
