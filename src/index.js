// Tattoo Art Customs — marketplace backend entry point.
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const layouts = require('express-ejs-layouts');
const { money } = require('./lib/pricing');
const config = require('./config');
const db = require('./db');
const { migrate } = require('./db/migrate');
const { DbStore } = require('./middleware/sessionStore');
const { loadUser } = require('./middleware/auth');
const { i18nMiddleware } = require('./i18n');

// Safety net: Express 4 does NOT forward async handler rejections to error
// middleware — one bad query (e.g. a Postgres-incompatible GROUP_CONCAT on
// /admin) used to terminate the whole node process, 502'ing the entire site
// until Render restarted it. Patch Layer.handle_request (the choke point
// every route/middleware handler flows through) so a failure renders a 500
// for that request only. Must run before any router handles a request.
{
  const Layer = require('express/lib/router/layer');
  const orig = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function (req, res, next) {
    const fn = this.handle;
    // Leave error-handling layers (4 args) and non-functions to Express.
    if (typeof fn !== 'function' || fn.length > 3) {
      return orig.call(this, req, res, next);
    }
    try {
      const r = fn.call(this, req, res, next);
      if (r && typeof r.catch === 'function') r.catch(next);
    } catch (err) { next(err); }
  };
}

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');
app.use(layouts);
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // PayPal checkout buttons/webhooks need these.
      // 'unsafe-inline' is required: the site's own UI (mobile nav toggle,
      // cookie banner, plan pickers, payout controls) uses inline handlers.
      // Without it, CSP silently kills those clicks (reported: hamburger
      // menu and cookie "Got it" button dead on mobile).
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.paypal.com', 'https://www.sandbox.paypal.com',
        // AdSense: without these the adsbygoogle.js tag the site injects is
        // blocked and no ads render (found 2026-09-29 during hamburger CSP test).
        'https://pagead2.googlesyndication.com', 'https://googleads.g.doubleclick.net'],
      // helmet defaults script-src-attr to 'none', which kills inline
      // onclick handlers even when script-src allows 'unsafe-inline'.
      // The mobile hamburger, cookie banner, and payout controls all use
      // inline handlers, so drop that directive entirely.
      scriptSrcAttr: null,
      frameSrc: ["'self'", 'https://www.paypal.com', 'https://www.sandbox.paypal.com',
        // AdSense renders creatives in iframes from these hosts.
        'https://googleads.g.doubleclick.net', 'https://tpc.googlesyndication.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", 'https://api-m.paypal.com', 'https://api-m.sandbox.paypal.com'],
    },
  },
}));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Defaults available even if the session store fails mid-request.
app.use((req, res, next) => {
  res.locals.currentUser = null;
  res.locals.flash = null;
  res.locals.money = money;
  res.locals.safeJson = require('./lib/safeJson').safeJson;
  next();
});

app.use(session({
  store: new DbStore(),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 14 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax' },
}));

app.use(loadUser);

// Opening-sale visitor counter: one count per session (lib/visitors).
// Fire-and-forget so the counter write never slows the response; the
// session flag is set synchronously so a session can never double-count.
app.use((req, res, next) => {
  if (req.session) {
    try { require('./lib/visitors').countVisitor(req.session).catch(() => {}); } catch (e) { /* never break a request */ }
  }
  next();
});

// Flash messages (one-shot notices).
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  // Never let browsers cache pages rendered for a signed-in user: the nav
  // user-chip and impersonation banner must always reflect the live session.
  if (req.session && req.session.userId) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
  }
  res.locals.paypalReady = config.paypalConfigured();
  res.locals.adsenseId = config.adsense.publisherId;
  res.locals.siteName = 'Tattoo Art Customs';
  res.locals.baseUrl = config.baseUrl;
  res.locals.googleVerification = config.googleSiteVerification;
  res.locals.playStoreUrl = config.playStoreUrl;
  res.locals.playStoreProUrl = config.playStoreProUrl;
  res.locals.appStoreUrl = config.appStoreUrl;
  res.locals.youtubeUrl = config.youtubeUrl;
  res.locals.money = (cents) => `$${(cents / 100).toFixed(2)}`;
  next();
});

// i18n: locale detection (?hl= > tac_locale cookie > Accept-Language) plus
// t(), fmtMoney(), fxNote(), vatNote exposed to every EJS view. The legacy
// `money` helper above stays USD so untranslated views keep working.
app.use(i18nMiddleware);

// Active direct-sold ads, available to every view (see partials/ad-slot).
// Counts one impression per page view for each live ad (directional stats).
app.use(async (req, res, next) => {
  try {
    const { getActiveAds, recordImpressions } = require('./lib/ads');
    const activeAds = await getActiveAds();
    res.locals.activeAds = activeAds;
    recordImpressions(Object.values(activeAds).map((a) => a.id)).catch(() => {});
  } catch (e) {
    res.locals.activeAds = {};
  }
  next();
});

// Public static files (logos, css, etc.) — cache 7 days like gallery images.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

// PUBLIC gallery images: ONLY watermarked linework is ever served publicly.
// Clean color + clean linework live under the upload dir but are NOT mounted
// here; buyers receive them through time-limited secure download links.
// Baked gallery images ship in the Docker image under ASSET_DIR; user uploads
// (including newly watermarked pieces) live under UPLOAD_DIR — the persistent
// disk on Render. /img/designs checks the upload dir first, then falls
// through to the baked set (express.static calls next() on a miss).
const wmDir = path.join(config.assetDir, 'designs', 'linework-wm');
const uploadWmDir = path.join(config.uploadDir, 'designs', 'linework-wm');
const photosDir = path.join(config.uploadDir, 'photos');
const avatarsDir = path.join(config.uploadDir, 'avatars');
const adsDir = path.join(config.uploadDir, 'ads');
const healedDir = path.join(config.assetDir, 'uploads', 'healed');
for (const d of [wmDir, uploadWmDir, photosDir, avatarsDir, adsDir, healedDir]) fs.mkdirSync(d, { recursive: true });
// Gallery previews change rarely (watermarked files can be regenerated in
// place on re-approval), so allow a week of caching with ETag revalidation.
const imgCacheOpts = { maxAge: '7d' };
app.use('/img/designs', express.static(uploadWmDir, imgCacheOpts));
app.use('/img/designs', express.static(wmDir, imgCacheOpts));
app.use('/img/photos', express.static(photosDir));
app.use('/img/healed', express.static(healedDir));
app.use('/img/avatars', express.static(avatarsDir));
app.use('/img/ads', express.static(adsDir));

// Routes
// Health check (for hosting monitors / load balancers).
// commit = deployed version (RENDER_GIT_COMMIT is set by Render at build time).
const BUILD_COMMIT = process.env.RENDER_GIT_COMMIT || null;
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now(), commit: BUILD_COMMIT }));

app.use('/', require('./routes/site'));
app.use('/', require('./routes/auth'));
app.use('/membership', require('./routes/memberships'));
app.use('/account', require('./routes/account'));
app.use('/artist', require('./routes/artist'));
app.use('/shop', require('./shop/routes'));
app.use('/orders', require('./routes/orders'));
app.use('/play', require('./routes/play'));
app.use('/api', require('./routes/api').router);
app.use('/api/muse', require('./routes/muse'));
app.use('/api/ingest', require('./routes/ingest'));
app.use('/studio', require('./routes/studio'));
app.use('/prints', require('./routes/prints'));
app.use('/merch', require('./routes/merch'));
app.use('/contests', require('./routes/contests'));
app.use('/', require('./routes/ads'));
app.use('/messages', require('./routes/messages'));
app.use('/admin', require('./routes/admin'));
// Shop toolset (booking, gift cards, intake, waitlist, events, social, journal).
app.use('/bookings', require('./shop/routes-bookings'));
app.use('/giftcards', require('./shop/routes-giftcards'));
app.use('/gift-cards', require('./routes/siteGiftCards'));
app.use('/ios-app', require('./routes/iosApp'));
app.use('/intake', require('./shop/routes-intake'));
app.use('/waitlist', require('./shop/routes-waitlist'));
app.use('/toolkit', require('./shop/routes-toolkit'));
app.use('/events', require('./routes/events'));
app.use('/social', require('./routes/social'));
app.use('/journal', require('./routes/journal'));

// 404 + error handlers
// Test-only route: proves an async handler failure renders a 500 for that
// request instead of crashing the process (the old /admin GROUP_CONCAT bug
// 502'd the whole site). Only exists when TAC_TEST_ROUTES=1.
if (process.env.TAC_TEST_ROUTES === '1') {
  app.get('/__test_async_crash', async () => { throw new Error('intentional test crash'); });
}
app.use((req, res) => res.status(404).render('error', {
  title: 'Not found', message: 'That page does not exist.',
}));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', {
    title: 'Something went wrong',
    message: 'Please try again. If this keeps happening, contact support.',
  });
});

// --- Graceful shutdown state (module scope so signal handlers reach it) ---
let server = null;
let shuttingDown = false;
let sessionCleanupTimer = null;
let contestExpiryTimer = null;
const openSockets = new Set();

// Destroy sockets that have no in-flight request (idle keep-alives) so
// server.close() can complete promptly instead of waiting on them.
function drainIdleSockets() {
  for (const socket of openSockets) {
    if (!socket._inFlight) {
      try { socket.destroy(); } catch (e) { /* already gone */ }
    }
  }
}

// Bounded drain window: Render sends SIGTERM ~30s before killing the
// container. In-flight requests get up to SHUTDOWN_DRAIN_MS, then any
// lingering sockets are destroyed, the DB pool is closed, and we exit.
const SHUTDOWN_DRAIN_MS = 25000;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal} — shutting down gracefully…`);
  if (sessionCleanupTimer) clearInterval(sessionCleanupTimer);
  if (contestExpiryTimer) clearInterval(contestExpiryTimer);
  try { require('./lib/scheduler').stopScheduler(); } catch (e) {
    console.error('scheduler stop failed:', e.message);
  }
  if (server) {
    server.close(); // stop accepting new connections
    drainIdleSockets(); // drop idle keep-alives right away when nothing is busy
    await Promise.race([
      new Promise((resolve) => server.once('close', resolve)),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref()),
    ]);
    // Whatever is still hanging around gets destroyed — never hang shutdown.
    for (const socket of openSockets) {
      try { socket.destroy(); } catch (e) { /* already gone */ }
    }
    await new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.once('close', resolve);
      setTimeout(resolve, 2000).unref(); // final backstop
    });
  }
  try {
    await db.close();
  } catch (e) {
    console.error('db close failed:', e.message);
  }
  console.log('Shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// A single unhandled promise rejection must never take down the worker:
// Node's default is to crash the process, which 502s the entire site
// until the platform restarts it. Log loudly so the underlying bug still
// gets fixed, but keep serving traffic.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection (worker kept alive):', reason);
});

async function start() {
  await migrate();
  // Periodic cleanup of expired sessions.
  sessionCleanupTimer = setInterval(() => {
    db.query('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]).catch(() => {});
  }, 3600 * 1000).unref();
  // Design-contest expiry (hourly): past-deadline contests -> refund to site
  // credit when no entries, or 'judging' when entries await a winner pick.
  // .unref()'d so this timer never holds the process open by itself.
  contestExpiryTimer = setInterval(() => {
    require('./lib/contests').expireContests(Date.now())
      .catch((e) => console.error('contest expiry failed:', e.message));
  }, 3600 * 1000).unref();
  // Weekly automated commission payouts (Mondays ~9am CT).
  require('./lib/scheduler').startScheduler();
  server = app.listen(config.port, () => {
    console.log(`Tattoo Art Customs listening on port ${config.port} (${db.getMode()})`);
    // Upload-disk self-report: proves in the deploy logs whether UPLOAD_DIR
    // sits on the persistent Render disk (~1GB total) or the ephemeral
    // container filesystem. No PII, just mount facts for ops.
    try {
      const st = fs.statfsSync(config.uploadDir);
      const gb = (n) => (n / 1073741824).toFixed(2) + 'GB';
      console.log(`[disk] uploadDir=${config.uploadDir} total=${gb(st.blocks * st.bsize)} free=${gb(st.bfree * st.bsize)}`);
    } catch (e) {
      console.log(`[disk] uploadDir=${config.uploadDir} statfs unavailable (${e.message}); dir exists=${fs.existsSync(config.uploadDir)}`);
    }
    if (!config.paypalConfigured()) {
      console.log('NOTE: PayPal credentials are not set — checkout and subscriptions are disabled until configured (see SETUP.md).');
    }
  });
  // Track open sockets (with per-socket in-flight request counts) so
  // shutdown can tell a busy request apart from an idle keep-alive
  // connection — server.close() alone waits on idle keep-alives forever.
  server.on('connection', (socket) => {
    socket._inFlight = 0;
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
  server.on('request', (req, res) => {
    const socket = req.socket;
    socket._inFlight = (socket._inFlight || 0) + 1;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      socket._inFlight = Math.max(0, (socket._inFlight || 1) - 1);
      if (shuttingDown) drainIdleSockets();
    };
    res.on('finish', settle);
    res.on('close', settle);
  });
}

if (require.main === module) {
  start().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = app;
