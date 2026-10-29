// Developer Tools for other developers — the three Bundle B faces
// (owner approved all 12 month-end brainstorm ideas, Oct 28 2026).
// Each tool gets its OWN address and its own face (layout-devtools
// face variants), never the TAC skin:
//
//   GET  /fill-my-list        FillMyList as a standalone service
//   GET  /rolodex-demo        Affiliate Rolodex public demo (no signup)
//   GET  /money-watch         Money Watch for developers — offer
//   POST /money-watch/interest  interest -> orders (pending_review)
//
// The machinery is all existing house machinery, wired — not rebuilt:
// the fill cycle (lib/fillCycle.js) behind POST /api/testers/fill/*,
// the register's orders table for interest, and the settled prices in
// lib/devtools.js (one config place). Honest payment states only:
// the fill order records 'awaiting_payment' until the desk confirms;
// Money Watch takes no payment at all yet — an interest list.
//
// OneMind tie: every page is public; the sign-in door is the site's
// standard /login (Google + email), and signing in seats the account
// via seatQuietly like everywhere else.
const express = require('express');
const config = require('../config');
const pricing = require('../lib/pricing');
const devtools = require('../lib/devtools');
const fillCycle = require('../lib/fillCycle');
const rolodex = require('../lib/rolodex');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FACES = {
  fill: { key: 'fill', name: 'FillMyList' },
  rolodex: { key: 'rolodex', name: 'Affiliate Rolodex' },
  moneywatch: { key: 'moneywatch', name: 'Money Watch' },
};

function face(res, view, locals) {
  const base = config.baseUrl.replace(/\/$/, '');
  return res.render(view, {
    layout: 'layout-devtools',
    canonical: `${base}${locals.path}`,
    money: pricing.money,
    tipJarUrl: devtools.TIP_JAR_URL,
    user: locals.user || null,
    flash: res.locals.flash || null,
    ...locals,
  });
}

// ---- FillMyList — the standalone service face ---------------------
router.get('/fill-my-list', async (req, res) => {
  let board = null;
  try { board = await fillCycle.lightBoard(6); } catch (e) { board = null; }
  face(res, 'site/devtools-fill', {
    path: '/fill-my-list',
    face: FACES.fill,
    title: 'FillMyList — your 12 testers, handled | Useful Appz Developer Tools',
    metaDescription: 'FillMyList: the tester fill, sold on its own. $24.99 per app per fill until FULL — the opted-in pool routed to your app in waves; testers tap their own Play opt-in; confirmations counted live.',
    user: req.user || null,
    fill: devtools.FILL,
    fillRegisterCents: devtools.fillRegisterCents(),
    poolCount: await devtools.poolCount(),
    board,
    rolodexTiers: devtools.ROLODEX_TIERS,
    moneyWatchPriceCents: devtools.MONEY_WATCH.priceCents,
  });
});

// ---- Affiliate Rolodex — the public demo ----------------------------
router.get('/rolodex-demo', (req, res) => {
  face(res, 'site/devtools-rolodex-demo', {
    path: '/rolodex-demo',
    face: FACES.rolodex,
    title: 'Affiliate Rolodex — the demo | Useful Appz Developer Tools',
    metaDescription: 'Paste your scattered affiliate links and watch the Rolodex organize them into one book — program, link, code, rate, cookie, disclosure, placements. Free demo, no signup, runs in your browser.',
    user: req.user || null,
    doors: {
      affiliateCents: devtools.ROLODEX_TIERS.affiliate.baseCents,
      socialCents: devtools.ROLODEX_TIERS.social.baseCents,
      masterCents: devtools.ROLODEX_TIERS.master.baseCents,
      appsUrl: '/apps',
      hubUrl: '/tester-hub',
    },
    // No house placements on the demo page: the demo is about the
    // VISITOR's book, and the house programs are tattoo-supply fit,
    // not developer fit. The sweeper doors below carry the page.
    partners: [],
    disclosureStandard: rolodex.disclosureStandard(),
    rolodexTiers: devtools.ROLODEX_TIERS,
    moneyWatchPriceCents: devtools.MONEY_WATCH.priceCents,
    fill: devtools.FILL,
  });
});

// ---- Money Watch — for developers -----------------------------------
router.get('/money-watch', (req, res) => {
  face(res, 'site/devtools-moneywatch', {
    path: '/money-watch',
    face: FACES.moneywatch,
    title: 'Money Watch for Developers — never search for a payout again | Useful Appz',
    metaDescription: 'Money Watch, productized for other developers: every payout source watched, every landing flashed ("you made X in Y time"), your own split map drawn on every landing. Read-only first — it never moves your money. $4.99, interest list open.',
    user: req.user || null,
    priceCents: devtools.MONEY_WATCH.priceCents,
    sourceDoors: devtools.MONEY_WATCH.sourceDoors,
    doors: { appsUrl: '/apps', hubUrl: '/tester-hub' },
    rolodexTiers: devtools.ROLODEX_TIERS,
    fill: devtools.FILL,
  });
});

router.post('/money-watch/interest', formLimiter, checkHoneypot, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
  const sources = String(req.body.sources || '').trim().slice(0, 600);
  if (!EMAIL_RE.test(email)) {
    req.session.flash = 'Enter a valid email and you are on the list — that is the whole form.';
    return res.redirect('/money-watch#interest');
  }
  try {
    const orderId = await devtools.recordMoneyWatchInterest({
      name, email, sources, userId: req.user ? req.user.id : '',
    });
    req.session.flash = `You are on the Money Watch interest list (reference ${orderId}). No payment is taken today — when the developer edition opens at ${pricing.money(devtools.MONEY_WATCH.priceCents)}, the list hears first.`;
  } catch (e) {
    console.error('money watch interest failed:', e.message);
    req.session.flash = 'The interest door hiccuped — try once more in a moment.';
  }
  res.redirect('/money-watch#interest');
});

module.exports = router;
