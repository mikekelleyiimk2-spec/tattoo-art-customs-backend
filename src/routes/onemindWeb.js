// OneMind on the web — the hub, the table, and the branch pages
// RENAME NOTE (Oct 28 2026): the platform brand is now Chorvix (owner strike, coined-word clearance round). Internal working names — files, routes (/onemind, /api/onemind), ids (onemind_id), env (ONEMIND_STANDALONE) — keep the onemind names by standing law; only people-facing copy carries Chorvix.
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
//   Page 1 — GET /onemind: OneMind's own front door, wearing
//     OneMind's OWN face — the same browser face as page 2 (the
//     table template in layout-onemind), never the tattoo shop's
//     site skin. An unseated visitor gets the face with a standard
//     sign-in card in the stage (the real web door: Google +
//     POST /login + the one-tap email link of /api/onemind/link/*)
//     and nothing else on top of it: no pitch, no seat board, no
//     price section — the face law below governs page 1 exactly as
//     it governs page 2. (The old page 1 was a manifesto hub
//     rendered in the shop's skin; the owner named that as the bug:
//     OneMind's face is its own.) A seated session skips page 1
//     entirely — straight to page 2 (owner ruling 2026-10-27
//     08:57 CDT).
//   Page 2 — GET /onemind/table: "the table" — a BROWSER face in
//     Chrome's grammar (owner ruling 2026-10-27 09:33 CDT): wordmark,
//     one search/URL bar, shortcut tiles to the real AIs and every
//     branch. The plumbing is invisible — no pitch, no plug cards,
//     no manifesto copy on the face; the tie runs underneath.
//   Branches — full standalone pages at their own links, reachable
//     directly or through the table: /onemind/poppy-and-ziggy,
//     /onemind/little-inkers (both kid-safe, walled layout),
//     /onemind/killintime, /onemind/tools, and /onemind/tester-hub
//     (routes to the existing /tester-hub, which stands on its own).
//   The tattoo shop is NOT a branch page: the hub and the table link
//   OUT to its own home — this website's front door (/).
//
// THE MAIN LINK: GET / is the tattoo shop's front door — ALWAYS.
// An earlier build could redirect / to /onemind behind the
// ONEMIND_FRONT_DOOR env flag; the owner retired that 2026-10-27
// 09:38 CDT: nobody is ever taken somewhere they didn't ask to go —
// "that's exactly how you lost their interest on step 1." OneMind
// has its own address (/onemind) and is reached only by asking for
// it (typing it, tapping its own link). The env flag is inert.
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
const { LESSER_ROSTER } = require('../worker/apiLane');

const router = express.Router();

const base = () => config.baseUrl.replace(/\/$/, '');

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

// --- The main link ---------------------------------------------------
// GET / belongs to the tattoo shop (the site router serves it). This
// router never intercepts it: no redirect to OneMind, ever — people
// reach OneMind by asking for it, at its own address.

// --- Page 1: /onemind — OneMind's own front door ----------------------
router.get('/onemind', async (req, res) => {
  // Owner ruling 2026-10-27 08:57 CDT ("web sign-in goes straight to
  // the table too"): a SEATED session never stops at page 1 — it goes
  // straight to page 2. "Seated" is the session the loadUser middleware
  // resolved (res.locals.currentUser, src/middleware/auth.js): every
  // sign-in path (signup, login, Google callback) runs
  // onemind.seatQuietly(user, 'website'), so an authenticated session
  // IS a seated session — the tie attaches at the sitting.
  if (res.locals.currentUser) return res.redirect(302, '/onemind/table');
  // Unseated: OneMind's OWN face — the browser face in its own layout
  // (layout-onemind), with the standard sign-in card in the stage.
  // The old render wore the tattoo shop's site skin (no layout was
  // passed, so it fell back to the TAC layout) and carried the
  // manifesto hub; that was the bug the owner named — OneMind's
  // face is its own. The hub template stays on disk, unrouted.
  seatReturnTo(req);
  const data = await tableLocals();
  res.render('onemind/table', {
    layout: 'layout-onemind',
    title: 'Chorvix',
    metaDescription: 'Chorvix — your browsers, your AIs, your tools, behind one search bar.',
    canonical: `${base()}/onemind`,
    // No kid-world house creatives ride this face's data (the tie is
    // universal; the ad wall is not — kid surfaces are never
    // advertised into from here).
    houseAdExclude: ['littleinkers', 'poppyziggy'],
    ...data,
    user: null,
    googleSignin: googleSeat.enabled(),
  });
});

// The table's eight AI bars, in the order the owner named them for
// the participants rail (2026-10-27 GPT-reference rebuild). Each
// bar's live state comes from the Codex book (tableBook's seat
// chips) — the rail tells the same truth as the seat board on
// page 1, never a dressed-up one. `url` is the AI's own home (the
// same doors the shortcut tiles opened). Muse is the house AI: it
// has no outside door, so its row links INTO the table's own ask
// stage (#omt-composer — the ask/send lane on this face) instead of
// dead-ending as an untappable row (owner report 2026-10-27 21:40
// CDT: "I can't even tap on Muse to see it"). The chip stays
// whatever the book says — the row simply stops being a dead end.
const AI_BARS = [
  { name: 'Muse', url: '#omt-composer', favicon: null },
  { name: 'ChatGPT', url: 'https://chatgpt.com', favicon: 'chatgpt.com' },
  { name: 'Claude', url: 'https://claude.ai', favicon: 'claude.ai' },
  { name: 'Gemini', url: 'https://gemini.google.com', favicon: 'gemini.google.com' },
  { name: 'Grok', url: 'https://grok.com', favicon: 'grok.com' },
  { name: 'Perplexity', url: 'https://www.perplexity.ai', favicon: 'perplexity.ai' },
  { name: 'DeepSeek', url: 'https://chat.deepseek.com', favicon: 'deepseek.com' },
  { name: 'Copilot', url: 'https://copilot.microsoft.com', favicon: 'copilot.microsoft.com' },
];

// The LESSER TABLE — the understudy bench (owner-approved
// 2026-10-23): secondary providers seated under their own names,
// OUTSIDE the primary roster above, never merged into its rail
// (labeling law in src/worker/apiLane.js: a lesser seat answers
// only as itself and is never dressed up as, swapped in for, or
// failed over to/from a primary). The roster order and names come
// from the worker's LESSER_ROSTER — the one code truth; the chips
// come from the Codex book, the same seatChip truth as the primary
// rail. `url` is each provider's own home.
const LESSER_DOORS = {
  Groq: { url: 'https://groq.com', favicon: 'groq.com' },
  OpenRouter: { url: 'https://openrouter.ai', favicon: 'openrouter.ai' },
  Cloudflare: { url: 'https://www.cloudflare.com', favicon: 'cloudflare.com' },
  NVIDIA: { url: 'https://www.nvidia.com', favicon: 'nvidia.com' },
  Mistral: { url: 'https://mistral.ai', favicon: 'mistral.ai' },
};

// The table face's data — ONE builder for both doors that serve the
// face (GET /onemind for unseated visitors, GET /onemind/table for
// everyone), so the two can never drift apart. Bars carry the Codex
// seat truth (tableBook's chips); the numbers are the honest live
// ones, read from the same sources the APIs serve.
async function tableLocals() {
  const t = tableBook();
  const numbers = await liveNumbers(t.book);
  const seatByName = new Map(t.seats.map((s) => [s.name, s]));
  const bars = AI_BARS.map((b) => {
    const seat = seatByName.get(b.name);
    return {
      ...b,
      chip: seat ? seat.chip : 'Not configured yet',
      configured: seat ? seat.configured : false,
      lastVerified: seat ? seat.lastVerified : null,
    };
  });
  const lesser = LESSER_ROSTER.map((name) => {
    const seat = seatByName.get(name);
    return {
      name,
      ...(LESSER_DOORS[name] || { url: null, favicon: null }),
      chip: seat ? seat.chip : 'Not configured yet',
      configured: seat ? seat.configured : false,
      lastVerified: seat ? seat.lastVerified : null,
    };
  });
  return {
    seats: t.seats,
    plugs: t.plugs,
    codexUpdated: t.codexUpdated,
    numbers,
    bars,
    lesser,
    configuredCount: bars.filter((b) => b.configured).length,
    partners: placementsFor(TABLE_PLACEMENTS),
    disclosureStandard: rolodex.disclosureStandard(),
  };
}

// A guest who signs in at OneMind's own door lands on the table.
// req.session.returnTo is the login flow's deep-link slot — set by
// requireLogin for gated pages and honored (then cleared) by
// POST /login, POST /signup and the Google callback in
// src/routes/auth.js. Setting it here aims that same mechanism at
// OneMind's own page 2: the person is already standing at OneMind's
// door asking to sit down, so the table is their own destination —
// nobody is funneled anywhere they didn't ask to go.
function seatReturnTo(req) {
  try { if (req.session) req.session.returnTo = '/onemind/table'; } catch (e) { /* session unavailable */ }
}

// --- Page 2: /onemind/table — the table ------------------------------
router.get('/onemind/table', async (req, res) => {
  const data = await tableLocals();
  const cu = res.locals.currentUser;
  // A guest reading the table directly gets the same sign-in card in
  // the stage, and the same landing when they use it.
  if (!cu) seatReturnTo(req);
  res.render('onemind/table', {
    layout: 'layout-onemind',
    title: 'Chorvix',
    metaDescription: 'Chorvix — your browsers, your AIs, your tools, behind one search bar.',
    canonical: `${base()}/onemind/table`,
    houseAdExclude: ['littleinkers', 'poppyziggy'],
    ...data,
    user: cu ? { name: cu.display_name || cu.email, email: cu.email } : null,
    googleSignin: googleSeat.enabled(),
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
    title: 'Poppy & Ziggy — the Kids\' Cartoon | Chorvix Branch',
    metaDescription: 'Poppy & Ziggy: the cartoon where a coloring page comes to life. New episode every Friday at 5 PM CT, a fun Short every day. Kid-safe branch page — grown-ups, start here.',
    canonical: `${base()}/onemind/poppy-and-ziggy`,
    pzFace: true,
    kidPartners: rolodex.queryLive({ kidSafe: true }),
    disclosureStandard: rolodex.disclosureStandard(),
  });
});

router.get('/onemind/little-inkers', (req, res) => {
  res.render('onemind/branch-little-inkers', {
    layout: 'layout-li',
    title: 'Little Inkers — Free Coloring Fun for Kids | Chorvix Branch',
    metaDescription: 'Little Inkers: the free coloring show and app where coloring pages come to life — Color With Us every Wednesday and Saturday, new coloring pages every Monday. Kid-safe branch page.',
    canonical: `${base()}/onemind/little-inkers`,
    liFace: true,
    kidPartners: rolodex.queryLive({ kidSafe: true }),
    disclosureStandard: rolodex.disclosureStandard(),
  });
});

router.get('/onemind/killintime', async (req, res) => {
  const t = tableBook();
  const numbers = await liveNumbers(t.book);
  res.render('onemind/branch-killintime', {
    title: 'Neon Tombstone — the Ports Shelf | Useful Appz',
    metaDescription: 'Neon Tombstone is the Useful Appz ports console: classic games, licensed properly, brought to phones. Ports carry no ads, ever. A Chorvix plug — reachable here directly or through the table.',
    canonical: `${base()}/onemind/killintime`,
    numbers,
  });
});

router.get('/onemind/tools', async (req, res) => {
  const t = tableBook();
  const numbers = await liveNumbers(t.book);
  res.render('onemind/branch-tools', {
    title: 'The Tools — the Useful Appz Toolbox | Chorvix Branch',
    metaDescription: 'The tool apps of Useful Appz: the Affiliate Rolodex, RoboSweeper, RoboScraper, Money Watch, Email Keeper, Connection Doctor, Service Plug and more — every one tied to Chorvix, every one at its own link.',
    canonical: `${base()}/onemind/tools`,
    numbers,
    partners: placementsFor(HUB_PLACEMENTS),
    disclosureStandard: rolodex.disclosureStandard(),
  });
});

// FillMyList stands on its own page; the branch link routes to it.
router.get('/onemind/tester-hub', (req, res) => res.redirect(302, '/tester-hub'));

module.exports = router;
