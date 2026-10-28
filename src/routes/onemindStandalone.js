// OneMind standalone host — onemind.onrender.com (owner order
// RENAME NOTE (Oct 28 2026): the platform brand is now Chorvix (owner strike, coined-word clearance round). Internal working names — files, routes (/onemind, /api/onemind), ids (onemind_id), env (ONEMIND_STANDALONE) — keep the onemind names by standing law; only people-facing copy carries Chorvix.
// 2026-10-27 09:49 CDT: "just change the fucking domain name to
// onemind then build all other pages onemind/tac,
// onemind/poppyandziggy, onemind/ports, onemind/toolbox&plugs").
//
// HOW THIS WORKS WITHOUT BREAKING THE TIE:
// - The main service is NEVER renamed — a rename would kill every
//   live link, the Google OAuth redirect URI, and every app pointer
//   to tattoo-art-customs.onrender.com (a replug disaster).
// - Instead a SECOND Render service named "onemind" runs this same
//   repo with ONEMIND_STANDALONE=on, the same DATABASE_URL and the
//   same SESSION_SECRET. Same database = same accounts, same seats,
//   same ties. Sign-in here IS the OneMind sign-in (the Google door
//   carries a redirect URI for this host too).
// - This router mounts ONLY when the flag is on (see src/index.js);
//   the tattoo shop's service never loads it, so nothing about the
//   shop's behavior changes.
//
// THE SHAPE ON THIS HOST:
//   GET /              → OneMind itself: seated sessions go straight
//                        to the browser face (/onemind/table); new
//                        visitors go to the OneMind door (/onemind).
//                        On THIS host that is not a funnel — typing
//                        "onemind" IS asking for OneMind.
//   GET /tac           → the Tattoo Art Customs DOOR: its own page,
//                        its own look, one way in — the shop itself
//                        stays at its own address (its own house).
//   GET /poppyandziggy → the Poppy & Ziggy branch face.
//   GET /ports         → the Neon Tombstone ports shelf.
//   GET /toolbox       → the Toolbox & Plugs branch face.
//   GET /little-inkers → the Little Inkers branch face (kid-safe).
//   GET /herbhaul      → the HerbHaul DOOR: its own black/neon face,
//                        founding-list intake only (not live yet).
//                        (Renamed from CannaDash 2026-10-28; the old
//                        /cannadash address 301-redirects here.)
// Every door is reachable directly, at its own address, wearing its
// own face — nobody passes through another place to reach it
// (arrival law, owner 2026-10-27 09:48 CDT).
const express = require('express');
const config = require('../config');
const rolodex = require('../lib/rolodex');
const cannadashFounding = require('../lib/cannadashFounding');
const cannadashRoster = require('../lib/cannadashRoster');
const db = require('../db');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const WAITLIST_ROLES = ['order', 'drive', 'partner'];

const router = express.Router();

const base = () => config.baseUrl.replace(/\/$/, '');
const SHOP = 'https://tattoo-art-customs.onrender.com';

function standaloneEnabled() {
  return String(process.env.ONEMIND_STANDALONE || '').trim().toLowerCase() === 'on';
}

// --- Root: OneMind itself ---------------------------------------------
function rootHandler(req, res) {
  if (res.locals.currentUser) return res.redirect(302, '/onemind/table');
  return res.redirect(302, '/onemind');
}
router.get('/', rootHandler);

// --- The TAC door -------------------------------------------------------
function tacDoorHandler(req, res) {
  res.render('onemind/door-tac', {
    layout: 'layout-onemind',
    title: 'Tattoo Art Customs — the Tattoo Shop | Chorvix',
    metaDescription: 'Tattoo Art Customs: custom tattoo designs, a gallery of real artists, stencils and full-color work. The shop lives at its own address — this is its door.',
    canonical: `${base()}/tac`,
    shopUrl: SHOP,
  });
}
router.get('/tac', tacDoorHandler);

// --- Branch doors (same branch faces, at this host's addresses) --------
function poppyHandler(req, res) {
  res.render('onemind/branch-poppy', {
    layout: 'layout-li',
    title: 'Poppy & Ziggy — the Kids\' Cartoon | Chorvix',
    metaDescription: 'Poppy & Ziggy: the cartoon where a coloring page comes to life. New episode every Friday at 5 PM CT, a fun Short every day. Kid-safe branch page — grown-ups, start here.',
    canonical: `${base()}/poppyandziggy`,
    pzFace: true,
    kidPartners: rolodex.queryLive({ kidSafe: true }),
    disclosureStandard: rolodex.disclosureStandard(),
  });
}
router.get('/poppyandziggy', poppyHandler);

function littleInkersHandler(req, res) {
  res.render('onemind/branch-little-inkers', {
    layout: 'layout-li',
    title: 'Little Inkers — Free Coloring Fun for Kids | Chorvix',
    metaDescription: 'Little Inkers: the free coloring show and app where coloring pages come to life — Color With Us every Wednesday and Saturday, new coloring pages every Monday. Kid-safe branch page.',
    canonical: `${base()}/little-inkers`,
    liFace: true,
    kidPartners: rolodex.queryLive({ kidSafe: true }),
    disclosureStandard: rolodex.disclosureStandard(),
  });
}
router.get('/little-inkers', littleInkersHandler);

function portsHandler(req, res) {
  res.render('onemind/door-ports', {
    layout: 'layout-onemind',
    title: 'Ports — Neon Tombstone | Chorvix',
    metaDescription: 'Neon Tombstone Ports: classic games, licensed properly, brought to phones. Ports carry no ads, ever.',
    canonical: `${base()}/ports`,
  });
}
router.get('/ports', portsHandler);

function toolboxHandler(req, res) {
  res.render('onemind/door-toolbox', {
    layout: 'layout-onemind',
    title: 'Toolbox & Plugs | Chorvix',
    metaDescription: 'The Useful Appz toolbox: the Affiliate Rolodex, FillMyList, Money Watch, AI to AI, Connection Doctor, Service Plug — tools built from real wounds.',
    canonical: `${base()}/toolbox`,
  });
}
router.get('/toolbox', toolboxHandler);

// --- The HerbHaul door --------------------------------------------------
// HerbHaul's own address + own face on this host (owner order
// 2026-10-27; visual anchor = the owner's Grok-fetched candidate:
// black field, the approved ring mark big, "Legal cannabis.
// Delivered.", area-check pill, quiet 21+ trust line, three doors).
// RENAMED 2026-10-28: the platform was CannaDash until the owner's
// HerbHaul strike; the mark carries no name, so only words moved.
// This router mounts BEFORE the site router, so on THIS host the
// door wins /herbhaul; the main host never loads this router and
// keeps its informational site/cannadash page untouched (served at
// /herbhaul there; /cannadash redirects on both hosts).
//
// FUNCTION IS INTAKE ONLY (legality gate, money audit gap 8):
// HerbHaul is not live in any market yet and no market opens until
// counsel clears it and a licensed partner signs. The area check
// answers honestly (not live anywhere yet), and the three doors lead
// to founding-list (waitlist) applications that persist to
// cannadash_waitlist (table name kept — internal, pre-rename). NO
// payments, NO ordering — the face never implies otherwise.
function waitlistRole(v) {
  const r = String(v || '').trim().toLowerCase();
  return WAITLIST_ROLES.includes(r) ? r : 'order';
}

function cannadashDoorHandler(req, res) {
  const q = req.query || {};
  const joined = WAITLIST_ROLES.includes(String(q.joined || '')) ? String(q.joined) : null;
  res.render('onemind/door-cannadash', {
    layout: 'layout-onemind',
    title: 'HerbHaul — Legal Cannabis. Delivered. | Chorvix',
    metaDescription: 'HerbHaul: legal cannabis delivery from licensed dispensaries — order, drive, or partner. Not live in any market yet; join the founding list. 21+ only.',
    canonical: `${base()}/herbhaul`,
    joinRole: waitlistRole(q.join || joined),
    joined,
    joinedAgain: joined && q.again === '1',
    joinError: ['email', 'name', 'age', 'driver'].includes(String(q.error || '')) ? String(q.error) : null,
    checkedArea: q.checked ? String(q.checked).slice(0, 80) : null,
    driverApkUrl: cannadashRoster.driverApkReady() ? cannadashRoster.DRIVER_APK_URL : null,
  });
}
router.get('/herbhaul', cannadashDoorHandler);
// Pre-rename address (retired 2026-10-28): never break a live link —
// the old door 301s to /herbhaul, query string carried along.
router.get('/cannadash', (req, res) => {
  const qs = String(req.originalUrl || '').slice('/cannadash'.length);
  return res.redirect(301, `/herbhaul${qs}`);
});

// --- The HerbHaul founding partner offer --------------------------------
// GET /herbhaul/founding: the founding partner offer for dispensaries
// (Bundle C Build 1, 2026-10-28). Structure, lock promise, and cohort
// cap render from src/lib/cannadashFounding.js; while that config's
// pricesLive flag is false (status PENDING OWNER STRIKE) every price
// cell carries the withheld label and NO assessed dollar figure
// renders — the running dispensary campaign promised a founding rate
// locked with no figure quoted, and this page keeps that promise.
// Applications reuse the door's founding-list intake below
// (POST /herbhaul/join, role=partner) — no second intake is built.
function cannadashFoundingHandler(req, res) {
  res.render('onemind/cannadash-founding', {
    layout: 'layout-onemind',
    title: 'HerbHaul Founding Partners — Rate Locked at Joining | Chorvix',
    metaDescription: 'HerbHaul founding partners: licensed dispensaries join the first cohort with their founding rate locked at joining for 12 months. The full rate sheet goes to founding partners first.',
    canonical: `${base()}/herbhaul/founding`,
    founding: cannadashFounding.publicFoundingOffer(),
    offer: cannadashFounding.publicFoundingOffer(),
    feeRows: cannadashFounding.publicFeeRows(),
    pricesLive: cannadashFounding.pricesLive,
  });
}
router.get('/herbhaul/founding', cannadashFoundingHandler);
router.get('/cannadash/founding', (req, res) => {
  const qs = String(req.originalUrl || '').slice('/cannadash/founding'.length);
  return res.redirect(301, `/herbhaul/founding${qs}`);
});

function cannadashCheckHandler(req, res) {
  const area = String((req.body || {}).area || '').trim().slice(0, 80);
  if (!area) return res.redirect(302, '/herbhaul#check');
  return res.redirect(302, `/herbhaul?checked=${encodeURIComponent(area)}#check`);
}
router.post('/herbhaul/check', formLimiter, checkHoneypot, cannadashCheckHandler);
// Legacy POST kept mounted: a redirect cannot carry a form post, so
// pre-rename forms still land in the same handler (which now answers
// back to /herbhaul).
router.post('/cannadash/check', formLimiter, checkHoneypot, cannadashCheckHandler);

async function cannadashJoinHandler(req, res) {
  const body = req.body || {};
  const role = waitlistRole(body.role);
  const name = String(body.name || '').trim().slice(0, 80);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
  const area = String(body.area || '').trim().slice(0, 120);
  const detail = String(body.detail || '').trim().slice(0, 200);
  const back = (qs) => res.redirect(302, `/herbhaul?${qs}#join`);
  if (!name) return back(`join=${role}&error=name`);
  if (!EMAIL_RE.test(email)) return back(`join=${role}&error=email`);
  if (!body.age_ok) return back(`join=${role}&error=age`);
  if (role === 'drive' && !body.driver_ok) return back(`join=${role}&error=driver`);
  try {
    const existing = await db.get(
      'SELECT id FROM cannadash_waitlist WHERE role = ? AND email = ?', [role, email]);
    if (existing) {
      await db.update('cannadash_waitlist', existing.id, {
        name, area: area || null, detail: detail || null,
      });
      return back(`joined=${role}&again=1`);
    }
    await db.insert('cannadash_waitlist', {
      role, name, email, area: area || null, detail: detail || null,
      source: 'cannadash-door',
    });
    return back(`joined=${role}`);
  } catch (e) {
    console.error('cannadash waitlist join failed:', e.message);
    return back(`join=${role}&error=email`);
  }
}
router.post('/herbhaul/join', formLimiter, checkHoneypot, cannadashJoinHandler);
// Legacy POST kept mounted (see /check above): same handler, same
// cannadash_waitlist intake, answers back to /herbhaul.
router.post('/cannadash/join', formLimiter, checkHoneypot, cannadashJoinHandler);

module.exports = router;
module.exports.standaloneEnabled = standaloneEnabled;
module.exports.handlers = {
  rootHandler, tacDoorHandler, poppyHandler, littleInkersHandler, portsHandler, toolboxHandler,
  cannadashDoorHandler, cannadashCheckHandler, cannadashJoinHandler, cannadashFoundingHandler,
};
module.exports.WAITLIST_ROLES = WAITLIST_ROLES;
