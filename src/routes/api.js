// JSON API for the Android app: account linking + linked-account info.
// The app POSTs the user's website email + password once, stores the
// returned api_token, and sends it with /play/verify so Play purchases
// attach to (and activate memberships on) the website account.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { hasAnyActiveSubscription, isAdminRole, isActiveMember, isCustomerMember } = require('../middleware/auth');
const { isSaleWindow, premadePriceCents, customFullCents, salePriceActive } = require('../lib/pricing');
const { viewerFor, displayImgFile } = require('../lib/contentPolicy');
const { designThumbUrl } = require('../lib/designThumbs');
const { authLimiter, formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { enforceSessionCap } = require('../lib/sessionLimits');
const rolodex = require('../lib/rolodex');

const router = express.Router();

// Verified merch + affiliate link set for app clients (merch/affiliate
// completeness audit 2026-10-16): the same links the website carries on
// /merch + /discounts, so any app surface can render the full set from one
// payload. Keep in sync with src/lib/merchCatalog.js. CNC Tattoo is
// shop-subscriber-gated and NEVER appears here or on any public surface.
//
// Affiliate Rolodex plug (Slice 2, 2026-10-26): the affiliate entries'
// URLs are NO LONGER hard-coded here — each one is pulled live from the
// rolodex (src/lib/rolodex.js, data in src/data/rolodex.json), so a link
// change in the rolodex updates this payload with no code change. The
// slot list below only fixes the response shape app clients already
// consume (id / display name / order); per the plug contract only LIVE
// rolodex programs render, so a program that leaves `live` drops out of
// the payload rather than serving a stale link. Amazon Associates has no
// single program link by design — its rolodex `code` IS the Associates
// tag, so its URL is the Amazon storefront carrying that tag.
const APP_LINK_AFFILIATES = [
  { id: 'baselabs', name: 'Base Labs', program: 'Base Labs' },
  { id: 'electrum', name: 'Electrum Supply', program: 'Electrum Supply' },
  { id: 'drtattooskin', name: 'DrTattooSkin', program: 'DrTattooSkin' },
  { id: 'recovery', name: 'Recovery Aftercare', program: 'Recovery Aftercare' },
  { id: 'leda', name: 'Leda Art Supply', program: 'Leda Art Supply' },
  { id: 'amazon', name: 'Amazon', program: 'Amazon Associates', urlFromTag: true },
  { id: 'monstersink', name: 'Monsters Ink', program: 'Monsters Ink' },
];

function appLinkSet(config) {
  const base = config.baseUrl;
  const affiliates = [];
  for (const slot of APP_LINK_AFFILIATES) {
    const p = rolodex.findLiveByName(slot.program);
    if (!p) continue;
    const url = p.link || (slot.urlFromTag && p.code ? `https://www.amazon.com/?tag=${p.code}` : null);
    if (!url) continue;
    affiliates.push({ id: slot.id, name: slot.name, url });
  }
  return {
    merch: `${base}/merch`,
    discounts: `${base}/discounts`,
    aftercare: `${base}/aftercare`,
    giftCards: `${base}/gift-cards/buy`,
    affiliates,
  };
}

// Public app store links for app clients: the free app's "Go Pro" upsell
// reads playStoreProUrl here (falls back to the website /apps page when empty).
// Never a dead button — empty strings mean "not published yet".
router.get('/app-links', (req, res) => {
  const config = require('../config');
  res.json({
    ok: true,
    playStoreUrl: config.playStoreUrl || '',
    playStoreProUrl: config.playStoreProUrl || '',
    // Alias the app's Go-Pro upsell expects (resolveProUrl in prolink.js).
    proStoreUrl: config.playStoreProUrl || '',
    appStoreUrl: config.appStoreUrl || '',
    appsPage: `${config.baseUrl}/apps`,
    links: appLinkSet(config),
  });
});

// Affiliate Rolodex — the live plug endpoint (Slice 2, 2026-10-26).
// Serves src/data/rolodex.json per the plug contract (canonical project:
// ~/workspace/app/affiliate-rolodex/ — README.md + PLUG.md):
//   GET /api/rolodex                  all live programs
//   GET /api/rolodex?name=Base+Labs   one live program by name
//   GET /api/rolodex?surface=/merch   live programs placed on a surface
//   GET /api/rolodex?kid_safe=1       live kid-safe programs only
// Only status=live entries are EVER returned — there is deliberately no
// ?all=1: pending / approved-not-placed / closed entries stay out of
// every response. Every entry carries link + code + disclosure together
// (the disclosure lock, enforced in src/lib/rolodex.js) — there is no
// way to pull a bare link from this endpoint.
router.get('/rolodex', (req, res) => {
  const name = String(req.query.name || '').trim();
  if (name) {
    const program = rolodex.findLiveByName(name);
    if (!program) return res.status(404).json({ ok: false, error: 'not found' });
    return res.json({ ok: true, program });
  }
  const surface = String(req.query.surface || '').trim();
  const kidSafe = req.query.kid_safe === '1' || req.query.kid_safe === 'true';
  const programs = rolodex.queryLive({ surface, kidSafe });
  res.json({
    ok: true,
    rolodex: 'Affiliate Rolodex',
    version: rolodex.version(),
    updated: rolodex.updated(),
    disclosure: rolodex.disclosureStandard(),
    count: programs.length,
    programs,
  });
});

function publicUser(user, isSubscriber, eligibleFor6Month) {
  return {
    ok: true,
    user_id: user.id,
    api_token: user.api_token,
    email: user.email,
    display_name: user.display_name || '',
    role: user.role,
    is_subscriber: !!isSubscriber,
    // Pro-app perk (owner directive 2026-10-05): the Pro app reads this to
    // surface the 6-month membership offer natively. True only when the
    // offer is actually purchasable (verified Pro purchase + no active
    // customer-plan membership).
    eligibleFor6Month: !!eligibleFor6Month,
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
  const eligibleFor6Month = await require('../lib/proPurchases').hasVerifiedProPurchase(user.id)
    && !await isCustomerMember(user);
  return res.json(publicUser(user, isSub, eligibleFor6Month));
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
  const eligibleFor6Month = await require('../lib/proPurchases').hasVerifiedProPurchase(user.id)
    && !await isCustomerMember(user);
  return res.json(publicUser(user, isSub, eligibleFor6Month));
});

// Bootstrap a website session inside the app's WebView: the app loads
// /api/bootstrap?api_token=<token>&next=/studio, we set the session cookie
// and redirect. Lets linked app users reach subscriber pages (Design Studio)
// without typing their password into the WebView.
router.get('/bootstrap', async (req, res) => {
  const token = String(req.query.api_token || '').slice(0, 128);
  // JSON variant for the app's Go-Pro upsell (prolink.js resolveProUrl):
  // the HTML redirect below is a WebView session bootstrap, not a JSON
  // payload, so ?format=json exposes the store URLs as JSON instead.
  // Public info (same as /api/app-links); token is optional here.
  if (req.query.format === 'json') {
    const config = require('../config');
    const payload = {
      ok: true,
      playStoreUrl: config.playStoreUrl || '',
      playStoreProUrl: config.playStoreProUrl || '',
      proStoreUrl: config.playStoreProUrl || '',
      appStoreUrl: config.appStoreUrl || '',
      appsPage: `${config.baseUrl}/apps`,
      links: appLinkSet(config),
    };
    if (token) {
      const user = await db.get('SELECT id FROM users WHERE api_token = ?', [token]);
      if (user) payload.user_id = user.id;
    }
    return res.json(payload);
  }
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
  // Pagination (perf fix 2026-10-12): ?limit= / ?offset= are honored —
  // previously limit was ignored and every call returned the whole
  // catalog. With no limit param the full list is still returned
  // (back-compat for existing clients); thumb_url now points at the
  // compressed 640px grid thumbnail, preview_url at the full
  // watermarked preview.
  const total = rows.length;
  let offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  let limit = parseInt(req.query.limit, 10);
  const paged = Number.isFinite(limit) && limit > 0;
  limit = paged ? Math.min(limit, 1000) : total;
  const pageRows = rows.slice(offset, offset + limit);
  res.set('X-Total-Count', String(total));
  res.json({
    ok: true,
    sale: await salePriceActive(user),
    premade_price_cents: premadePriceCents(new Date(), member),
    pagination: { total, limit, offset, has_more: offset + pageRows.length < total },
    designs: pageRows.map((d) => {
      const f = displayImgFile(d, viewer);
      return {
        id: d.id, title: d.title, style: d.style || '',
        categories: JSON.parse(d.categories || '[]'),
        thumb_url: f ? designThumbUrl(f) : null,
        preview_url: f ? `/img/designs/${f}` : null,
        price_cents: premadePriceCents(new Date(), member),
        listing_type: d.listing_type || 'predesign',
        artist_name: d.artist_name || '',
      };
    }),
  });
});

// Full detail for ONE design (perf fix 2026-10-12): the list endpoint
// above stays slim for grids; clients that open a design fetch its full
// record here. Same visibility rules as the list (approved, gallery
// scope, members-only hidden from non-members) and the same content
// policy — only the viewer's watermarked (or blurred) preview is ever
// exposed, never a clean color/linework path.
router.get('/designs/:id', async (req, res) => {
  const user = await userFromToken(req);
  const member = await isActiveMember(user);
  const viewer = await viewerFor(user);
  const d = await db.get(
    `SELECT d.id, d.title, d.description, d.style, d.categories, d.linework_wm_path,
            d.linework_blur_path, d.sensitivity, d.artist_id, d.listing_type,
            d.members_only, d.created_at,
            u.display_name AS artist_name
     FROM designs d LEFT JOIN users u ON u.id = d.artist_id
     WHERE d.id = ? AND d.status = 'approved' AND d.listing_scope = 'gallery'`,
    [req.params.id]);
  if (!d || (d.members_only && !member)) {
    return res.status(404).json({ ok: false, error: 'not found' });
  }
  const f = displayImgFile(d, viewer);
  res.json({
    ok: true,
    sale: await salePriceActive(user),
    design: {
      id: d.id, title: d.title, description: d.description || '',
      style: d.style || '',
      categories: JSON.parse(d.categories || '[]'),
      thumb_url: f ? designThumbUrl(f) : null,
      preview_url: f ? `/img/designs/${f}` : null,
      price_cents: d.listing_type === 'custom'
        ? customFullCents(new Date(), member)
        : premadePriceCents(new Date(), member),
      listing_type: d.listing_type || 'predesign',
      artist_id: d.artist_id || null,
      artist_name: d.artist_name || '',
      members_only: !!d.members_only,
      created_at: d.created_at,
    },
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
    pieces: rows.map((d) => {
      const f = displayImgFile(d, viewer);
      return {
        id: d.id, title: d.title, style: d.style || '',
        categories: JSON.parse(d.categories || '[]'),
        thumb_url: f ? designThumbUrl(f) : null,
        preview_url: f ? `/img/designs/${f}` : null,
        listing_type: d.listing_type || 'predesign',
        price_cents: d.listing_type === 'custom' ? customFullCents(new Date(), member) : premadePriceCents(new Date(), member),
      };
    }),
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

// Tester pool size for the /testers page and admin checks. Returns ONLY
// the count — no emails or names ever leave through here.
router.get('/testers/count', async (req, res) => {
  try {
    const row = await db.get('SELECT COUNT(*) AS n FROM tester_signups');
    res.json({ ok: true, count: (row && row.n) || 0 });
  } catch (e) {
    res.json({ ok: true, count: 0 });
  }
});

// Owner's raffle share link for promo posts. The referral code is public by
// design (it ships inside every promo post), so this returns only the share
// URL — no user id, no email, nothing else.
router.get('/raffle/owner-share', async (req, res) => {
  try {
    const { ownerUserId } = require('../lib/commissions');
    const { ensureReferralCode } = require('../lib/referrals');
    const config = require('../config');
    const ownerId = await ownerUserId();
    if (!ownerId) return res.status(503).json({ ok: false, error: 'owner not configured' });
    const code = await ensureReferralCode(ownerId);
    if (!code) return res.status(503).json({ ok: false, error: 'no referral code' });
    res.json({ ok: true, share_url: `${config.baseUrl.replace(/\/$/, '')}/raffle?ref=${code}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'unavailable' });
  }
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
// [merchhearts] Favorites are typed (migration 100): 'design' rows point at
// gallery designs, 'merch' rows at merchCatalog products. The id column is
// shared (design ids and catalog slugs never collide). Responses keep the
// legacy `ids` array and add typed `items` alongside it.
const merchCatalog = require('../lib/merchCatalog');

async function favoriteItemsFor(userId) {
  const rows = await db.all(
    'SELECT design_id, item_type FROM user_favorites WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  return rows.map((r) => ({ id: r.design_id, type: r.item_type === 'merch' ? 'merch' : 'design' }));
}

async function favoriteIdsFor(userId) {
  return (await favoriteItemsFor(userId)).map((i) => i.id);
}

// Item type for a favorites/likes call: body.type or ?type=, default design.
function favoriteItemType(req, explicit) {
  const raw = String(explicit || (req.body && req.body.type) || req.query.type || '').toLowerCase();
  return raw === 'merch' ? 'merch' : 'design';
}

async function validFavoriteDesign(designId) {
  const id = String(designId || '').slice(0, 128);
  if (!id) return null;
  return db.get("SELECT id FROM designs WHERE id = ? AND status = 'approved'", [id]);
}

// Validate a typed favorite/like target. Designs must be approved gallery
// rows; merch ids must exist in the static catalog (any status — hearts on
// coming-soon cards are how demand shows before Printful lights up).
async function validFavoriteItem(rawId, type) {
  const id = String(rawId || '').slice(0, 128);
  if (!id) return null;
  if (type === 'merch') {
    const p = merchCatalog.getProduct(id);
    return p ? { id: p.id, type: 'merch' } : null;
  }
  const design = await validFavoriteDesign(id);
  return design ? { id: design.id, type: 'design' } : null;
}

async function favoritesResponse(req, res) {
  const items = await favoriteItemsFor(req.user.id);
  return res.json({ ok: true, ids: items.map((i) => i.id), items });
}

router.get('/favorites', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'login required' });
  return favoritesResponse(req, res);
});

// Merge guest localStorage favorites into the server set (dedupe).
// Accepts legacy `ids` (strings, all designs) and typed `items`
// ([{id, type}]); entries may also be {id, type} objects inside `ids`.
router.post('/favorites/merge', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'login required' });
  const entries = [];
  const rawIds = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  const rawItems = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  for (const raw of rawIds) {
    if (raw && typeof raw === 'object') entries.push({ id: raw.id, type: favoriteItemType(req, raw.type) });
    else entries.push({ id: raw, type: 'design' });
  }
  for (const raw of rawItems) {
    if (raw && typeof raw === 'object') entries.push({ id: raw.id, type: favoriteItemType(req, raw.type) });
  }
  const now = db.now();
  for (const entry of entries.slice(0, 500)) {
    const item = await validFavoriteItem(entry.id, entry.type);
    if (!item) continue;
    await db.query(
      'INSERT INTO user_favorites (user_id, design_id, item_type, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, design_id) DO NOTHING',
      [req.user.id, item.id, item.type, now]);
  }
  return favoritesResponse(req, res);
});

router.post('/favorites/:designId', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'login required' });
  const item = await validFavoriteItem(req.params.designId, favoriteItemType(req));
  if (!item) return res.status(404).json({ ok: false, error: 'not available' });
  await db.query(
    'INSERT INTO user_favorites (user_id, design_id, item_type, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, design_id) DO NOTHING',
    [req.user.id, item.id, item.type, db.now()]);
  return res.json({ ok: true, favorited: true, id: item.id, type: item.type });
});

router.delete('/favorites/:designId', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'login required' });
  const id = String(req.params.designId || '').slice(0, 128);
  const typeGiven = String((req.body && req.body.type) || req.query.type || '').toLowerCase();
  if (typeGiven === 'merch' || typeGiven === 'design') {
    await db.query('DELETE FROM user_favorites WHERE user_id = ? AND design_id = ? AND item_type = ?',
      [req.user.id, id, typeGiven]);
  } else {
    await db.query('DELETE FROM user_favorites WHERE user_id = ? AND design_id = ?',
      [req.user.id, id]);
  }
  return res.json({ ok: true, favorited: false, id });
});

// Top-loved leaderboard (design likes) — [toploved] feature.
// Gallery hearts double as "love" votes. No login required: logged-in users
// vote as 'user:<id>'; guests vote with a client UUID (tac_voter_uuid).
// design_like_counts is recomputed from design_likes after every change so
// the tally can never drift.
function likeVoterKey(req) {
  if (req.user) return 'user:' + req.user.id;
  const raw = String((req.body && req.body.voter_key) || '').slice(0, 64);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(raw)) return null;
  return 'guest:' + raw;
}

async function refreshLikeCount(designId) {
  const row = await db.get('SELECT COUNT(*) AS n FROM design_likes WHERE design_id = ?', [designId]);
  const n = Number((row && row.n) || 0);
  await db.query(
    `INSERT INTO design_like_counts (design_id, like_count) VALUES (?, ?)
     ON CONFLICT(design_id) DO UPDATE SET like_count = excluded.like_count`,
    [designId, n]);
  return n;
}

// [merchhearts] Product likes mirror design likes in the parallel
// merch_likes / merch_like_counts tables (migration 100), same voter-key
// mechanics. The web client only pings likes for signed-in users (owner
// rule 2026-10-11: guest saves stay local and cast no public vote).
async function refreshMerchLikeCount(merchId) {
  const row = await db.get('SELECT COUNT(*) AS n FROM merch_likes WHERE merch_id = ?', [merchId]);
  const n = Number((row && row.n) || 0);
  await db.query(
    `INSERT INTO merch_like_counts (merch_id, like_count) VALUES (?, ?)
     ON CONFLICT(merch_id) DO UPDATE SET like_count = excluded.like_count`,
    [merchId, n]);
  return n;
}

router.post('/likes/:designId', express.json(), formLimiter, async (req, res) => {
  const type = favoriteItemType(req);
  const item = await validFavoriteItem(req.params.designId, type);
  if (!item) return res.status(404).json({ ok: false, error: 'not available' });
  const voterKey = likeVoterKey(req);
  if (!voterKey) return res.status(400).json({ ok: false, error: 'voter_key required' });
  if (item.type === 'merch') {
    await db.query(
      'INSERT INTO merch_likes (merch_id, voter_key, created_at) VALUES (?, ?, ?) ON CONFLICT(merch_id, voter_key) DO NOTHING',
      [item.id, voterKey, db.now()]);
    const likeCount = await refreshMerchLikeCount(item.id);
    return res.json({ ok: true, liked: true, id: item.id, type: 'merch', like_count: likeCount });
  }
  await db.query(
    'INSERT INTO design_likes (design_id, voter_key, created_at) VALUES (?, ?, ?) ON CONFLICT(design_id, voter_key) DO NOTHING',
    [item.id, voterKey, db.now()]);
  const likeCount = await refreshLikeCount(item.id);
  return res.json({ ok: true, liked: true, id: item.id, like_count: likeCount });
});

router.delete('/likes/:designId', express.json(), formLimiter, async (req, res) => {
  const voterKey = likeVoterKey(req);
  if (!voterKey) return res.status(400).json({ ok: false, error: 'voter_key required' });
  const id = String(req.params.designId || '').slice(0, 128);
  if (favoriteItemType(req) === 'merch') {
    await db.query('DELETE FROM merch_likes WHERE merch_id = ? AND voter_key = ?', [id, voterKey]);
    const likeCount = await refreshMerchLikeCount(id);
    return res.json({ ok: true, liked: false, id, type: 'merch', like_count: likeCount });
  }
  await db.query('DELETE FROM design_likes WHERE design_id = ? AND voter_key = ?', [id, voterKey]);
  const likeCount = await refreshLikeCount(id);
  return res.json({ ok: true, liked: false, id, like_count: likeCount });
});

// --- Little Inkers pipeline ---
// POST /api/little-inkers/redeem { code } — the kids app validates a
// LIL-XXXXXX code (no auth: the code itself is the credential; the kid has
// no account). Marks the code used and returns the watermarked linework.
router.post('/little-inkers/redeem', express.json(), async (req, res) => {
  const { redeemCode } = require('../lib/littleInkers');
  const result = await redeemCode(req.body && req.body.code);
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  return res.json({ ok: true, design: result.design });
});

// POST /api/little-inkers/submit-code { code } — validate a TAC-XXXXXX
// submission code from the app's parent zone. Returns a draft token the
// /doodle-to-tattoo page accepts to pre-fill the order.
router.post('/little-inkers/submit-code', express.json(), async (req, res) => {
  const { checkSubmissionCode } = require('../lib/littleInkers');
  const result = await checkSubmissionCode(req.body && req.body.code);
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  return res.json({ ok: true, code: result.code });
});

// POST /api/little-inkers/mint-submit — mint a TAC-XXXXXX submission code
// for a parent (logged-in). The app calls this behind its parent gate;
// the website "send" flow uses the same function server-side.
router.post('/little-inkers/mint-submit', express.json(), async (req, res) => {
  const user = await userFromToken(req);
  const { mintSubmissionCode } = require('../lib/littleInkers');
  const code = await mintSubmissionCode(user ? user.id : null);
  return res.json({ ok: true, code });
});

// --- Little Inkers weekly bundles manifest (2026-10-07) ---
// Public, no auth: the kids app fetches this on launch to discover new
// weekly coloring-page bundles. The weekly cron inserts rows into lil_bundles.
router.get('/little-inkers/bundles', async (req, res) => {
  try {
    const rows = await db.all(
      "SELECT id, title, theme, design_count, published_at, file_url FROM lil_bundles WHERE active = 1 ORDER BY published_at DESC LIMIT 52"
    );
    res.json({
      ok: true,
      bundles: rows.map((r) => ({
        id: r.id,
        title: r.title,
        theme: r.theme,
        designCount: Number(r.design_count || 0),
        publishedAt: Number(r.published_at),
        fileUrl: r.file_url,
      })),
    });
  } catch (e) {
    console.error('bundles manifest failed:', e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- Little Inkers hearts (2026-10-23) ---
// Kid-safe like counts for coloring pages, in their own lil_likes /
// lil_like_counts tables (migration 101) — fully separate from
// design_likes and merch_likes so the LI numbers can never mix with
// tattoo-side numbers. No auth and no accounts exist on the LI side:
// the voter is an anonymous per-install UUID the app mints and keeps in
// local storage. The ping carries a page key and that random number —
// never artwork, never personal data (owner ruling 2026-10-23: the
// likes ping is the ONE content-free outbound call the kids app may
// make). lil_like_counts is recomputed from lil_likes after every
// change so the tally can never drift.
//
// page_key is a surface-prefixed slug so the three LI page namespaces
// can never collide:
//   app:<slug>                 flagship launch pages (app:penguin)
//   bundle:<YYYY-Www>:<slug>   weekly bundle pages (bundle:2026-W42:fox)
//   coloring:<slug>            Coloring app local catalog (future use)
const LIL_PAGE_KEY_RE = /^(?:app|coloring):[a-z0-9][a-z0-9_-]{0,95}$|^bundle:\d{4}-W\d{2}:[a-z0-9][a-z0-9_-]{0,95}$/;

function lilPageKey(raw) {
  const key = String(raw || '').slice(0, 160);
  return LIL_PAGE_KEY_RE.test(key) ? key : null;
}

function lilVoterKey(req) {
  const raw = String((req.body && (req.body.voter || req.body.voter_key)) || '').slice(0, 64);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(raw)) return null;
  return raw;
}

async function refreshLilLikeCount(pageKey) {
  const row = await db.get('SELECT COUNT(*) AS n FROM lil_likes WHERE page_key = ?', [pageKey]);
  const n = Number((row && row.n) || 0);
  await db.query(
    `INSERT INTO lil_like_counts (page_key, like_count) VALUES (?, ?)
     ON CONFLICT(page_key) DO UPDATE SET like_count = excluded.like_count`,
    [pageKey, n]);
  return n;
}

// POST /api/little-inkers/likes/:pageKey { voter } — cast a heart.
// DELETE same path — take it back. Both idempotent per (page, voter).
router.post('/little-inkers/likes/:pageKey', express.json(), formLimiter, async (req, res) => {
  const pageKey = lilPageKey(req.params.pageKey);
  if (!pageKey) return res.status(400).json({ ok: false, error: 'bad page_key' });
  const voterKey = lilVoterKey(req);
  if (!voterKey) return res.status(400).json({ ok: false, error: 'voter required' });
  await db.query(
    'INSERT INTO lil_likes (page_key, voter_key, created_at) VALUES (?, ?, ?) ON CONFLICT(page_key, voter_key) DO NOTHING',
    [pageKey, voterKey, db.now()]);
  const likeCount = await refreshLilLikeCount(pageKey);
  return res.json({ ok: true, liked: true, page_key: pageKey, like_count: likeCount });
});

router.delete('/little-inkers/likes/:pageKey', express.json(), formLimiter, async (req, res) => {
  const pageKey = lilPageKey(req.params.pageKey);
  if (!pageKey) return res.status(400).json({ ok: false, error: 'bad page_key' });
  const voterKey = lilVoterKey(req);
  if (!voterKey) return res.status(400).json({ ok: false, error: 'voter required' });
  await db.query('DELETE FROM lil_likes WHERE page_key = ? AND voter_key = ?', [pageKey, voterKey]);
  const likeCount = await refreshLilLikeCount(pageKey);
  return res.json({ ok: true, liked: false, page_key: pageKey, like_count: likeCount });
});

// GET /api/little-inkers/top-loved[?limit=] — LI counts only, most
// loved first. Pages with zero hearts are omitted.
router.get('/little-inkers/top-loved', async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const rows = await db.all(
    'SELECT page_key, like_count FROM lil_like_counts WHERE like_count > 0 ORDER BY like_count DESC, page_key ASC LIMIT ?',
    [limit]);
  return res.json({
    ok: true,
    pages: rows.map((r) => ({ page_key: r.page_key, like_count: Number(r.like_count || 0) })),
  });
});

module.exports = { router, userFromToken };
