// Affiliate Rolodex — the live plug (Slice 2, 2026-10-26).
//
// CANONICAL SOURCE: ~/workspace/app/affiliate-rolodex/rolodex.json — the
// Slice 1 project folder (its README.md + PLUG.md define the schema and the
// plug contract). The copy this backend serves lives at
// src/data/rolodex.json and is a verbatim copy of the canonical file.
// Refresh the served copy FROM the canonical source when programs change;
// never hand-edit the served copy — a link lands once in the rolodex and
// lights up everywhere, or it doesn't land at all.
//
// Plug contract (PLUG.md), enforced here so no caller can break it:
// - Only status=live entries are ever returned. There is no "all" mode:
//   pending / approved-not-placed / closed entries stay out of every
//   response, public or internal.
// - DISCLOSURE LOCK: an entry is only usable whole. publicEntry() always
//   projects the full placement field set — link, code and disclosure
//   travel together in the same object; there is no way to pull a bare
//   link out of this module.
// - `notes` are internal operations history and are NOT projected.
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'rolodex.json');

let cached = null;

function load() {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    if (!cached || !Array.isArray(cached.programs)) throw new Error('rolodex.json: programs[] missing');
  } catch (e) {
    // Fail safe: a broken rolodex file means surfaces render no affiliate
    // placements — never a crash on a money page, never a guessed link.
    console.error('rolodex load failed:', e.message);
    cached = { rolodex: 'Affiliate Rolodex', version: null, updated: null, programs: [] };
  }
  return cached;
}

function publicEntry(p) {
  return {
    name: p.name,
    network: p.network || null,
    status: p.status,
    link: p.link != null ? p.link : null,
    code: p.code != null ? p.code : null,
    rate: p.rate != null ? p.rate : null,
    cookie: p.cookie != null ? p.cookie : null,
    payout: p.payout != null ? p.payout : null,
    disclosure: p.disclosure || '',
    kid_safe: p.kid_safe === true,
    surfaces_placed: Array.isArray(p.surfaces_placed) ? p.surfaces_placed : [],
  };
}

function liveRaw() {
  return load().programs.filter((p) => p && p.status === 'live');
}

// All live programs, projected whole (disclosure lock).
function livePrograms() {
  return liveRaw().map(publicEntry);
}

// One live program by name (case-insensitive exact match), or null.
// Non-live programs return null — by name is still a placement pull.
function findLiveByName(name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  const hit = liveRaw().find((p) => String(p.name || '').toLowerCase() === want);
  return hit ? publicEntry(hit) : null;
}

// Live programs filtered by surface and/or the kid-safe flag.
// `surface` matches against the program's surfaces_placed list (any entry
// containing the surface string, case-insensitive) — surfaces_placed is
// free-text placement history ("/merch (sketchbook cards)"), so the match
// is a containment check, per the Slice 2 spec ("filter by surfaces_placed").
function queryLive({ surface = '', kidSafe = false } = {}) {
  const s = String(surface || '').trim().toLowerCase();
  return liveRaw()
    .filter((p) => !kidSafe || p.kid_safe === true)
    .filter((p) => !s || (Array.isArray(p.surfaces_placed)
      && p.surfaces_placed.some((x) => String(x).toLowerCase().includes(s))))
    .map(publicEntry);
}

module.exports = {
  livePrograms,
  findLiveByName,
  queryLive,
  version: () => load().version != null ? load().version : null,
  updated: () => load().updated || null,
  disclosureStandard: () => load().disclosure_standard || null,
};
