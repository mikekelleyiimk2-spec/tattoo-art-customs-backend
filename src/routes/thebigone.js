// Dawnfold — web edition + money surfaces (owner order 2026-10-27,
// Lane A). The publication's OWN face: its own layout (cream / ink /
// gold masthead grammar, ported from the app's first screen), never
// the TAC layout skin.
//
// RENAMED 2026-10-28 (owner strike): the publication was "The Big
// One"; it is Dawnfold now. The doors moved to /dawnfold*; the old
// /the-big-one GET doors 301-redirect below (query preserved), the
// old POST paths stay mounted alongside the new ones (a redirect
// cannot carry a form post), and the old sign-in link verify door
// stays mounted so links already emailed keep working. Internal
// names (this file, lib/thebigone, plan slugs the_big_one*) never
// changed — display name only.
//
//   GET  /dawnfold              Edition No. 1 + every money door
//   GET  /dawnfold/signin       sets the return path, into /login
//   GET  /dawnfold/sponsors     the rate card (same face)
//   GET  /dawnfold/classifieds  listings + submission form
//   POST /dawnfold/classifieds  submission -> orders (pending_review)
//   POST /dawnfold/gift         gift subscription -> orders + claim
//
// OneMind tie: the page is public; the sign-in door runs through the
// site's existing auth (Google + email/password on /login, and the
// email sign-in link door at /api/onemind/link/*), and every one of
// those doors seats the account via seatQuietly in routes/auth.js /
// lib/seatClaims.js — the tie attaches at the sitting, here like
// everywhere. The gift path mirrors the guest-commerce bridge: the
// recipient's claim tap seats them and attaches the purchase
// (lib/seatClaims.startPurchaseClaim, contract §7/§10).
const express = require('express');
const db = require('../db');
const config = require('../config');
const tbo = require('../lib/thebigone');
const li = require('../lib/localinsert');
const pricing = require('../lib/pricing');
const { requireLogin } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Pre-rename GET doors (RENAMED 2026-10-28, was "The Big One"):
// 301 to the Dawnfold doors, query string preserved.
const OLD_GET_DOORS = [
  '/the-big-one', '/the-big-one/signin', '/the-big-one/sponsors',
  '/the-big-one/classifieds', '/the-big-one/local/search',
  '/the-big-one/local/weather',
];
router.get(OLD_GET_DOORS, (req, res) => {
  const target = req.path.replace(/^\/the-big-one/, '/dawnfold');
  const qs = req.originalUrl.includes('?')
    ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  return res.redirect(301, `${target}${qs}`);
});

function face(res, view, locals) {
  const base = config.baseUrl.replace(/\/$/, '');
  return res.render(view, {
    layout: 'layout-thebigone',
    canonical: `${base}${locals.path}`,
    ...locals,
  });
}

async function doorLocals(req) {
  const plans = await tbo.getPlans();
  return {
    plans,
    money: pricing.money,
    user: req.user || null,
    foundingLeft: await tbo.foundingSpotsLeft(),
    foundingCap: tbo.FOUNDING_CAP,
    founder: req.user ? await tbo.founderInfo(req.user.id) : null,
    paypalReady: Object.fromEntries(tbo.PLAN_SLUGS.map((s) => [s, tbo.paypalReadyFor(s)])),
    tipJarUrl: tbo.TIP_JAR_URL,
    ...(await localLocals(req)),
  };
}

// The "Your Local" insert (owner order 2026-10-28: locals for ALL
// customers, not just Abbeville): the reader's locality comes from
// their account when they've set one, else the house hometown
// (Abbeville) — the bundled/default edition locality. Guests pick on
// the device (localStorage, swapped in by thebigone-local.js through
// the JSON doors below); no location is ever taken without a tap.
async function localLocals(req) {
  let local = li.HOUSE_LOCALITY;
  if (req.user) {
    const saved = await li.getUserLocality(req.user.id);
    if (saved) local = saved;
  }
  return {
    local,
    localWx: await li.getLocalWeather(local.lat, local.lon),
    briefs: li.briefSlots(local),
  };
}

// Edition No. 1 — Wed Oct 28 2026, Vol I No 1. The edition body is
// ported verbatim from the app's bundled index.html (departments,
// sources, colophon intact) into views/site/thebigone-edition.ejs.
router.get('/dawnfold', async (req, res) => {
  face(res, 'site/thebigone', {
    path: '/dawnfold',
    title: 'Dawnfold — Vol. I, No. 1 · Wednesday, October 28, 2026',
    metaDescription: 'Dawnfold: the whole day in one sitting — news in two frames, world events, the Spotlight, weather, money in plain words, Today In…, the Documentary Shelf, the Back of the Book, and IN ORDER!, the daily puzzle you can finish.',
    ...(await doorLocals(req)),
    flash: res.locals.flash || null,
  });
});

// Your Local — typed-place search (the World Weather pattern:
// Open-Meteo geocoding; no location without a tap, anywhere here).
router.get('/dawnfold/local/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q.length < 2) return res.json({ ok: true, places: [] });
  const places = await li.searchPlaces(q);
  res.json({ ok: true, places });
});

// Your Local — weather for an arbitrary locality (the guest device
// pick path; signed-in readers get theirs rendered server-side).
router.get('/dawnfold/local/weather', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ ok: false, error: 'bad coordinates' });
  }
  const label = String(req.query.label || '').trim().slice(0, 120);
  const weather = await li.getLocalWeather(lat, lon);
  res.json({ ok: true, locality: { label, lat, lon }, weather });
});

// Your Local — save the reader's locality to their account (the
// OneMind seat carries it to every device). Guests never POST here;
// their pick lives on the device (see thebigone-local.js).
router.post(['/dawnfold/locality', '/the-big-one/locality'], formLimiter, checkHoneypot, async (req, res) => {
  if (!req.user) {
    req.session.flash = 'Sign in first — then your town saves to your account and follows you to every device.';
    return res.redirect('/dawnfold#your-local');
  }
  let pick = null;
  const lat = Number(req.body.lat);
  const lon = Number(req.body.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon) && String(req.body.label || '').trim()) {
    pick = {
      label: String(req.body.label).trim().slice(0, 120),
      name: String(req.body.name || '').trim().slice(0, 80),
      region: String(req.body.region || '').trim().slice(0, 80),
      country: String(req.body.country || '').trim().slice(0, 80),
      lat, lon,
    };
  } else if (String(req.body.place || '').trim()) {
    const places = await li.searchPlaces(String(req.body.place).trim().slice(0, 80));
    if (places.length) pick = places[0];
  }
  const saved = pick ? await li.saveUserLocality(req.user.id, pick) : null;
  req.session.flash = saved
    ? `Your local page is set to ${saved.label} — its weather and briefs now ride your edition.`
    : 'That place didn’t resolve — try the town name with its state or country.';
  res.redirect('/dawnfold#your-local');
});

// The sign-in door: aim the login flow's existing returnTo slot back
// at the publication (the same mechanism OneMind's own door uses in
// routes/onemindWeb.js), then hand off to the standard /login page —
// Google, email + password, and account creation all live there, and
// every path seats the OneMind tie via seatQuietly.
router.get('/dawnfold/signin', (req, res) => {
  if (req.user) return res.redirect('/dawnfold');
  try { if (req.session) req.session.returnTo = '/dawnfold'; } catch (e) { /* session unavailable */ }
  res.redirect('/login');
});

// The email sign-in link (the "magic link" door): the site's §7
// seat-claim machinery (lib/seatClaims) on the website surface — the
// same mechanism the API door at /api/onemind/link/start runs. The
// difference here is only the landing: the tap comes back to THIS
// page's verify route, which sets the web session, so the reader
// lands signed in on the publication instead of the app's seat page.
router.post(['/dawnfold/link', '/the-big-one/link'], formLimiter, checkHoneypot, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
  if (!EMAIL_RE.test(email)) {
    req.session.flash = 'Enter a valid email address and we’ll send your sign-in link.';
    return res.redirect('/dawnfold');
  }
  const seatClaims = require('../lib/seatClaims');
  const claim = await seatClaims.startClaim(email, 'website');
  if (!claim.ok) {
    req.session.flash = 'We couldn’t start that sign-in link — try again, or use the sign-in door above.';
    return res.redirect('/dawnfold');
  }
  const link = `${config.baseUrl.replace(/\/$/, '')}/dawnfold/link/verify?token=${claim.token}`;
  let sent = 0;
  try {
    const { sendMail } = require('../lib/mail');
    await sendMail({
      to: claim.email,
      subject: 'Your Chorvix sign-in link — Dawnfold',
      text: [
        'Tap this link to finish — it signs you in, or creates your Chorvix account if you’re new.',
        'One account works on everything Useful Appz makes, and this tap seats you at the table.',
        '',
        link,
        '',
        'The link works once and expires in 1 hour. If you didn’t ask for it, ignore this email.',
      ].join('\n'),
    });
    sent = 1;
  } catch (e) { console.error('thebigone link email failed:', e.message); }
  // Never claim success unless the mail actually went out (the
  // contact form's honesty rule, applied here too).
  req.session.flash = sent > 0
    ? `Sign-in link sent to ${email} — tap it within the hour and you’re seated.`
    : 'Sorry — the sign-in link couldn’t be sent right now. Use the Google or password door above.';
  res.redirect('/dawnfold');
});

router.get(['/dawnfold/link/verify', '/the-big-one/link/verify'], async (req, res) => {
  const seatClaims = require('../lib/seatClaims');
  const result = await seatClaims.verifyClaim(String(req.query.token || ''));
  if (!result.ok || !result.user) {
    return res.status(400).render('site/thebigone-message', {
      layout: 'layout-thebigone',
      path: '/dawnfold',
      title: 'That link couldn’t seat you — Dawnfold',
      metaDescription: 'That sign-in link is invalid, expired, or already used.',
      heading: 'That link couldn’t seat you',
      body: 'The link is invalid, expired, or already used. Head back to Dawnfold and ask for a fresh one — it only takes a tap.',
      flash: null,
    });
  }
  req.session.userId = result.user.id;
  await require('../lib/onemind').seatQuietly(result.user.id, 'website');
  try { await require('../lib/sessionLimits').enforceSessionCap(req); } catch (e) { /* best effort */ }
  req.session.flash = result.created_account
    ? 'Welcome — your Chorvix account is created and you’re seated. This same account signs you in everywhere Useful Appz makes.'
    : 'You’re seated — welcome back. This same account signs you in everywhere Useful Appz makes.';
  res.redirect('/dawnfold');
});

// Sponsors — the rate card, in the publication's face. Every offer's
// inquiry runs through the site's existing contact machinery
// (POST /contact, the form pattern the HerbHaul partner door uses).
router.get('/dawnfold/sponsors', async (req, res) => {
  face(res, 'site/thebigone-sponsors', {
    path: '/dawnfold/sponsors',
    title: 'Sponsor Dawnfold — Founding Rate Card',
    metaDescription: 'Sponsor Dawnfold: edition “Presented by”, department sponsorships, sponsored IN ORDER! contests, waiting-room subscriptions, the Acadiana local bundle, classifieds, and feed licensing — at founding rates.',
    offers: tbo.SPONSORS.map((o) => ({ ...o, priceCents: pricing.withFeeCents(o.baseCents) })),
    listings: Object.values(tbo.LISTINGS).map((l) => ({ ...l, priceCents: tbo.listingPriceCents(l.kind) })),
    money: pricing.money,
    user: req.user || null,
    flash: res.locals.flash || null,
  });
});

// Classifieds + Notices: the public board (honest while empty) and
// the submission form. Nothing auto-publishes — submissions land in
// `orders` as pending_review register products for the desk.
router.get('/dawnfold/classifieds', async (req, res) => {
  await tbo.ensurePlans();
  let published = [];
  try {
    published = await db.all(
      `SELECT * FROM orders WHERE order_type = 'the_big_one_listing' AND status = 'published'
       ORDER BY created_at DESC LIMIT 50`);
  } catch (e) { /* board renders empty-honest regardless */ }
  const listings = published.map((o) => {
    let meta = {};
    try { meta = JSON.parse(o.guest_note || '{}'); } catch (e) { /* keep empty */ }
    return { business: meta.business || '', text: meta.text || '', kind: meta.kind || 'classifieds' };
  });
  face(res, 'site/thebigone-classifieds', {
    path: '/dawnfold/classifieds',
    title: 'Dawnfold — Classifieds & Notices',
    metaDescription: 'Classifieds and notices in Dawnfold: founding listings are open. A small register product — reviewed by the desk, never auto-published.',
    listings,
    prices: Object.fromEntries(Object.values(tbo.LISTINGS).map((l) => [l.kind, tbo.listingPriceCents(l.kind)])),
    money: pricing.money,
    user: req.user || null,
    flash: res.locals.flash || null,
  });
});

router.post(['/dawnfold/classifieds', '/the-big-one/classifieds'], formLimiter, checkHoneypot, async (req, res) => {
  const business = String(req.body.business_name || '').trim().slice(0, 120);
  const email = String(req.body.contact_email || '').trim().toLowerCase().slice(0, 160);
  const text = String(req.body.listing_text || '').trim().slice(0, 600);
  const kind = req.body.department === 'notices' ? 'notices' : 'classifieds';
  if (!business || !EMAIL_RE.test(email) || text.length < 10) {
    req.session.flash = 'Please include your business name, a valid contact email, and your listing text (at least a sentence).';
    return res.redirect('/dawnfold/classifieds');
  }
  const priceCents = tbo.listingPriceCents(kind);
  const orderId = await db.insert('orders', {
    buyer_id: req.user ? req.user.id : '',
    order_type: 'the_big_one_listing',
    amount_cents: priceCents,
    fee_cents: 0,
    status: 'pending_review',
    payment_method: 'paypal_manual',
    guest_email: email,
    guest_note: JSON.stringify({ business, text, kind }),
    created_at: db.now(),
  });
  // Desk review queue: the same admin-notification machinery the
  // contact form uses — a human reads every listing before it runs.
  try {
    await require('../lib/notify').notifyAdmins({
      kind: 'contact', title: `Dawnfold ${kind} submission: ${business}`,
      body: `${business} <${email}> — ${pricing.money(priceCents)} listing, awaiting review + payment confirmation (order ${orderId})`,
      link: '/dawnfold/classifieds',
    });
  } catch (e) { console.error('classifieds notify failed:', e.message); }
  req.session.flash = `Listing received for review — nothing publishes automatically. The desk confirms payment (${pricing.money(priceCents)} via the Business PayPal link on this page) and reviews the text, then your ${kind === 'notices' ? 'notice' : 'classified'} runs for 30 days. Order reference: ${orderId}.`;
  res.redirect('/dawnfold/classifieds');
});

// Gift a subscription (owner order 2026-10-27): buyer + recipient
// emails, mirroring the site gift-card register pattern (a pending
// orders row first, payment confirmation at the desk) and the
// guest-commerce claim bridge (the recipient's emailed claim tap
// seats their Chorvix account and attaches the purchase).
router.post(['/dawnfold/gift', '/the-big-one/gift'], requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const recipient = String(req.body.recipient_email || '').trim().toLowerCase().slice(0, 160);
  const slug = req.body.plan === 'the_big_one_annual' ? 'the_big_one_annual' : 'the_big_one';
  if (!EMAIL_RE.test(recipient)) {
    req.session.flash = 'Enter the recipient’s email address for the gift.';
    return res.redirect('/dawnfold');
  }
  if (recipient === String(req.user.email || '').toLowerCase()) {
    req.session.flash = 'That’s your own email — a gift needs a recipient. For yourself, use the subscribe door.';
    return res.redirect('/dawnfold');
  }
  const plans = await tbo.getPlans();
  const plan = plans[slug];
  if (!plan) {
    req.session.flash = 'That gift plan is not in the register yet — please try again shortly.';
    return res.redirect('/dawnfold');
  }
  const orderId = await db.insert('orders', {
    buyer_id: req.user.id,
    order_type: 'the_big_one_gift',
    amount_cents: plan.price_cents,
    fee_cents: 0,
    status: 'pending_review',
    payment_method: 'paypal_manual',
    guest_email: recipient,
    guest_note: JSON.stringify({ plan_slug: slug, buyer_email: req.user.email }),
    created_at: db.now(),
  });
  // The claim bridge: one emailed link; the recipient's tap seats
  // them (existing account signs in; a new email registers) and the
  // purchase attaches to the seat. Best-effort like every bridge call.
  try {
    await require('../lib/seatClaims').startPurchaseClaim(recipient);
  } catch (e) { console.error('thebigone gift claim failed:', e.message); }
  try {
    await require('../lib/notify').notifyAdmins({
      kind: 'contact', title: `Dawnfold gift: ${plan.name}`,
      body: `${req.user.email} gifted ${plan.name} (${pricing.money(plan.price_cents)}) to ${recipient} — order ${orderId}, awaiting payment confirmation`,
      link: '/dawnfold',
    });
  } catch (e) { console.error('thebigone gift notify failed:', e.message); }
  req.session.flash = `Gift recorded: ${plan.name} for ${recipient}. The desk confirms payment at the register (PayPal, like everything in the house) and a one-tap claim link is on its way to ${recipient} — their tap seats their Chorvix account and attaches the gift.`;
  res.redirect('/dawnfold');
});

module.exports = router;
