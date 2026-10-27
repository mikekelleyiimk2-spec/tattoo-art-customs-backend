// OneMind on the web — the hub, the table, and the branch pages
// (owner directive 2026-10-26 ~20:03–20:09 CDT).
//
// THE LAW this file is built on, in the owner's sense:
// - EVERYTHING is tied to OneMind. No exceptions, no carve-outs. The
//   tattoo shop is every bit as tied as everything else — the website
//   is logged surface #1 and its logins ARE OneMind logins; the only
//   correction ever made about TAC was that its PAGE is the website
//   itself, so the hub links out to it instead of hosting a copy.
// - A LOGIN ANYWHERE IS A ONEMIND LOGIN. The sign-in on this page is
//   the real web door (POST /login + the Google door + the one-tap
//   email link of /api/onemind/link/*) — the same account, the same
//   seat, the 'website' tie. Branch pages carry no separate accounts.
// - Reachability is DUAL: anything is reachable directly at its own
//   link OR through OneMind. The tie runs underneath both paths,
//   always. Independent never means untied.
//
// STRUCTURE (owner's pages):
//   Page 1 — GET /onemind: sign up / sign in to OneMind, the seat
//     board (live from the Codex), the price, and the door to page 2.
//   Page 2 — GET /onemind/table: "the table" — the familiar browsers
//     pitch, every plug from the Codex, and every branch as a lit
//     card with its own link.
//   Branches — full standalone pages at their own links, reachable
//     directly or through the table: /onemind/poppy-and-ziggy,
//     /onemind/little-inkers (both kid-safe, walled layout),
//     /onemind/killintime, /onemind/tools, and /onemind/tester-hub
//     (routes to the existing /tester-hub, which stands on its own).
//   The tattoo shop is NOT a branch page: the hub and the table link
//   OUT to its own home — this website's front door (/).
//
// THE MAIN LINK: GET / redirects to /onemind ONLY when the env flag
// ONEMIND_FRONT_DOOR=on (read live per request). Default OFF — the
// flip is the owner's one tap. When off, / behaves exactly as today.
//
// Mounted BEFORE the site router (see src/index.js) so this file owns
// /onemind and can intercept / first; the site router's older /onemind
// product page remains in place as fallback code but is unreachable
// while this router is mounted. Everything here is additive: new
// routes, new templates, no other lane's files rewritten.
const express = require('express');
const config = require('../config');
const db = require('../db');
const codex = require('../lib/codex');
const rolodex = require('../lib/rolodex');
const googleSeat = require('../lib/googleSeat');
const onemind = require('../lib/onemind');

const router = express.Router();

const base = () => config.baseUrl.replace(/\/$/, '');

// The front-door flag: env ONEMIND_FRONT_DOOR=on makes / the OneMind
// door. Read live so the flip needs no code change (and so the suite
// can pin the truth table).
function frontDoorEnabled() {
  return String(process.env.ONEMIND_FRONT_DOOR || '').trim().toLowerCase() === 'on';
}

// Same seat-chip mapping the site router's /onemind page used — the
// board must tell the identical truth in both places (pinned by
// test/codex.js: exactly one "Seated — configured", Gemini).
function seatChip(state) {
  const s = String(state || '');
  if (/phone lane/i.test(s)) return 'Phone lane — chair unclaimed';
  if (/not built/i.test(s)) return 'Named — not built yet';
  if (/seated/i.test(s) && !/unconfigured/i.test(s)) return 'Seated — configured';
  return 'Not configured yet';
}

function tableBook() {
  const book = codex.publicBook();
  const seats = (book.seats || []).map((s) => ({
    name: s.name,
    state: s.state,
    chip: seatChip(s.state),
    configured: seatChip(s.state) === 'Seated — configured',
    lastVerified: (s.liveness && s.liveness.last_verified) || null,
  }));
  const ai2ai = (book.plugs || []).find((p) => /AI-to-AI Messenger/i.test(p.name || ''));
  return {
    book,
    seats,
    plugs: book.plugs || [],
    codexUpdated: book.updated || null,
    ai2aiState: ai2ai ? String(ai2ai.state || '') : '',
    ai2aiBuilding: ai2ai ? /^building/i.test(String(ai2ai.state || '')) : false,
    ai2aiLive: ai2ai ? /^live/i.test(String(ai2ai.state || '')) : false,
  };
}

// Honest live numbers only — every figure is read from the same
// sources the APIs serve (designs table, the Codex book, the
// Rolodex). Nothing is rounded up, seeded, or dressed.
async function liveNumbers(book) {
  let designs = null;
  try {
    const row = await db.get("SELECT COUNT(*) AS n FROM designs WHERE status = 'approved'");
    designs = row ? Number(row.n) : null;
  } catch (e) { designs = null; }
  return {
    designs,
    doors: (book.doors || []).length,
    plugs: (book.plugs || []).length,
    seats: (book.seats || []).length,
    partners: rolodex.livePrograms().length,
  };
}

// Affiliate placements pulled live from the Rolodex — the same data
// /api/rolodex serves (src/lib/rolodex.js is that endpoint's source).
// A page names the placement surfaces that honestly cover it; the
// rolodex returns whole entries only (link + code + disclosure travel
// together — the disclosure lock). No hardcoded affiliate links.
function placementsFor(surfaceTokens, { kidSafe = false } = {}) {
  const seen = new Map();
  for (const tok of surfaceTokens) {
    for (const p of rolodex.queryLive({ surface: tok, kidSafe })) seen.set(p.name, p);
  }
  return [...seen.values()];
}

const HUB_PLACEMENTS = ['REFERRAL-HUB'];
const TABLE_PLACEMENTS = ['REFERRAL-HUB', 'house-ads rotation'];

// --- The main link (flag-gated) -------------------------------------
router.get('/', (req, res, next) => {
  if (!frontDoorEnabled()) return next();
  return res.redirect(302, '/onemind');
});

// --- Page 1: /onemind — sign up to OneMind ---------------------------
router.get('/onemind', async (req, res) => {
  const t = tableBook();
  const numbers = await liveNumbers(t.book);
  let seat = null;
  const cu = res.locals.currentUser;
  if (cu) {
    try {
      const full = await db.get('SELECT * FROM users WHERE id = ?', [cu.id]);
      if (full) seat = await onemind.seatSummary(full);
    } catch (e) { seat = null; }
  }
  res.render('onemind/hub', {
    title: 'OneMind — All Your AIs, One Team | Useful Appz',
    metaDescription: 'OneMind is the table everything Useful Appz makes is tied to: one sign-in everywhere, your AIs at one table, every plug and branch reachable from here or at its own link. OneMind Team $9.99/mo, in closed testing now.',
    canonical: `${base()}/onemind`,
    // As the product page before it: no kid-world house creatives in
    // this page's layout slots (the tie is universal; the ad wall is
    // not — kid surfaces are never advertised into from here).
    houseAdExclude: ['littleinkers', 'poppyziggy'],
    seats: t.seats,
    codexUpdated: t.codexUpdated,
    ai2aiState: t.ai2aiState,
    ai2aiBuilding: t.ai2aiBuilding,
    ai2aiLive: t.ai2aiLive,
    numbers,
    seat,
    googleSignin: googleSeat.enabled(),
    partners: placementsFor(HUB_PLACEMENTS),
    disclosureStandard: rolodex.disclosureStandard(),
  });
});

// --- Page 2: /onemind/table — the table ------------------------------
router.get('/onemind/table', async (req, res) => {
  const t = tableBook();
  const numbers = await liveNumbers(t.book);
  res.render('onemind/table', {
    title: 'The Table — OneMind | Useful Appz',
    metaDescription: 'The OneMind table on the web: the familiar browsers running with our plugs — the AIs, the APIs, the tools — and every branch of the house, each tied to the table and each reachable at its own link.',
    canonical: `${base()}/onemind/table`,
    houseAdExclude: ['littleinkers', 'poppyziggy'],
    seats: t.seats,
    plugs: t.plugs,
    codexUpdated: t.codexUpdated,
    numbers,
    partners: placementsFor(TABLE_PLACEMENTS),
    disclosureStandard: rolodex.disclosureStandard(),
  });
});

// --- Branches ----------------------------------------------------------
// Kid-safe law on the two kid branches: the walled Little Inkers
// layout, kid-safe Rolodex programs only, no tattoo affiliates, no
// tattoo commerce links, no links back into grown-up commerce — the
// tie to OneMind is stated in words for grown-ups, never as a door
// a kid can walk through into the shop.

router.get('/onemind/poppy-and-ziggy', (req, res) => {
  res.render('onemind/branch-poppy', {
    layout: 'layout-li',
    title: 'Poppy & Ziggy — the Kids\' Cartoon | OneMind Branch',
    metaDescription: 'Poppy & Ziggy: the cartoon where a coloring page comes to life. New episode every Friday at 5 PM CT, a fun Short every day. Kid-safe branch page — grown-ups, start here.',
    canonical: `${base()}/onemind/poppy-and-ziggy`,
    kidPartners: rolodex.queryLive({ kidSafe: true }),
    disclosureStandard: rolodex.disclosureStandard(),
  });
});

router.get('/onemind/little-inkers', (req, res) => {
  res.render('onemind/branch-little-inkers', {
    layout: 'layout-li',
    title: 'Little Inkers — Free Coloring Fun for Kids | OneMind Branch',
    metaDescription: 'Little Inkers: the free coloring show and app where coloring pages come to life — Color With Us every Wednesday and Saturday, new coloring pages every Monday. Kid-safe branch page.',
    canonical: `${base()}/onemind/little-inkers`,
    kidPartners: rolodex.queryLive({ kidSafe: true }),
    disclosureStandard: rolodex.disclosureStandard(),
  });
});

router.get('/onemind/killintime', async (req, res) => {
  const t = tableBook();
  const numbers = await liveNumbers(t.book);
  res.render('onemind/branch-killintime', {
    title: 'KillinTime — the Ports Shelf | Useful Appz',
    metaDescription: 'KillinTime is the Useful Appz ports console: classic games, licensed properly, brought to phones. Ports carry no ads, ever. A OneMind plug — reachable here directly or through the table.',
    canonical: `${base()}/onemind/killintime`,
    numbers,
  });
});

router.get('/onemind/tools', async (req, res) => {
  const t = tableBook();
  const numbers = await liveNumbers(t.book);
  res.render('onemind/branch-tools', {
    title: 'The Tools — the Useful Appz Toolbox | OneMind Branch',
    metaDescription: 'The tool apps of Useful Appz: the Affiliate Rolodex, RoboSweeper, RoboScraper, Money Watch, Email Keeper, Connection Doctor, Service Plug and more — every one tied to OneMind, every one at its own link.',
    canonical: `${base()}/onemind/tools`,
    numbers,
    partners: placementsFor(HUB_PLACEMENTS),
    disclosureStandard: rolodex.disclosureStandard(),
  });
});

// The Tester Hub stands on its own page; the branch link routes to it.
router.get('/onemind/tester-hub', (req, res) => res.redirect(302, '/tester-hub'));

module.exports = router;
module.exports.frontDoorEnabled = frontDoorEnabled;
