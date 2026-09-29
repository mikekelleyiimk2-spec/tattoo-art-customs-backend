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
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.paypal.com', 'https://www.sandbox.paypal.com'],
      // helmet defaults script-src-attr to 'none', which kills inline
      // onclick handlers even when script-src allows 'unsafe-inline'.
      // The mobile hamburger, cookie banner, and payout controls all use
      // inline handlers, so drop that directive entirely.
      scriptSrcAttr: null,
      frameSrc: ["'self'", 'https://www.paypal.com', 'https://www.sandbox.paypal.com'],
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

// Flash messages (one-shot notices).
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.paypalReady = config.paypalConfigured();
  res.locals.adsenseId = config.adsense.publisherId;
  res.locals.siteName = 'Tattoo Art Customs';
  res.locals.baseUrl = config.baseUrl;
  res.locals.googleVerification = config.googleSiteVerification;
  res.locals.playStoreUrl = config.playStoreUrl;
  res.locals.money = (cents) => `$${(cents / 100).toFixed(2)}`;
  next();
});

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

// Public static files.
app.use(express.static(path.join(__dirname, 'public')));

// PUBLIC gallery images: ONLY watermarked linework is ever served publicly.
// Clean color + clean linework live under ASSET_DIR but are NOT mounted here;
// buyers receive them through time-limited secure download links (/orders).
const wmDir = path.join(config.assetDir, 'designs', 'linework-wm');
const photosDir = path.join(config.assetDir, 'uploads', 'photos');
const adsDir = path.join(config.assetDir, 'uploads', 'ads');
fs.mkdirSync(wmDir, { recursive: true });
fs.mkdirSync(photosDir, { recursive: true });
fs.mkdirSync(adsDir, { recursive: true });
app.use('/img/designs', express.static(wmDir));
app.use('/img/photos', express.static(photosDir));
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
app.use('/shop', require('./routes/shop'));
app.use('/orders', require('./routes/orders'));
app.use('/play', require('./routes/play'));
app.use('/api', require('./routes/api').router);
app.use('/studio', require('./routes/studio'));
app.use('/prints', require('./routes/prints'));
app.use('/', require('./routes/ads'));
app.use('/messages', require('./routes/messages'));
app.use('/admin', require('./routes/admin'));
// Shop toolset (booking, gift cards, intake, waitlist, events, social, journal).
app.use('/bookings', require('./routes/bookings'));
app.use('/giftcards', require('./routes/giftcards'));
app.use('/intake', require('./routes/intake'));
app.use('/waitlist', require('./routes/waitlist'));
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

async function start() {
  await migrate();
  // Periodic cleanup of expired sessions.
  setInterval(() => {
    db.query('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]).catch(() => {});
  }, 3600 * 1000).unref();
  // Weekly automated commission payouts (Mondays ~9am CT).
  require('./lib/scheduler').startScheduler();
  app.listen(config.port, () => {
    console.log(`Tattoo Art Customs listening on port ${config.port} (${db.getMode()})`);
    if (!config.paypalConfigured()) {
      console.log('NOTE: PayPal credentials are not set — checkout and subscriptions are disabled until configured (see SETUP.md).');
    }
  });
}

if (require.main === module) {
  start().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = app;
