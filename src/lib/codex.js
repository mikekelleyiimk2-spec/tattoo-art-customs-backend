// The Codex for OneMind — the live plug (Slice 1, 2026-10-26).
//
// CANONICAL SOURCE: ~/workspace/app/codex/codex.json — the Codex project
// (its README.md defines the book: the written registry of the table —
// Directory + every tie, seat, price, and result; a plug, price, or tie
// that isn't in the codex isn't real). The copy this backend serves lives
// at src/data/codex.json and is a verbatim copy of the canonical file.
// Refresh the served copy FROM the canonical source when the book
// changes; never hand-edit the served copy.
//
// Public projection, enforced here so no caller can break it:
// - Only the public field set leaves this module: name, kind, state, and
//   liveness {how_checked, last_verified} per entry; codex/version/
//   updated at the top; the prices law + draft status (the law is public
//   doctrine; the draft doc path is an internal file reference and is
//   NOT projected).
// - `notes` are internal operations history (custody debts, staged
//   fixes, believed inbox contents) and are NEVER projected.
// - Nothing sensitive exists downstream of this module because nothing
//   sensitive is ever projected: no key material (the book holds none),
//   no pool addresses, no tokens, no connector account ids.
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'codex.json');

let cached = null;

function load() {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    if (!cached || !Array.isArray(cached.doors) || !Array.isArray(cached.plugs)
      || !Array.isArray(cached.seats)) {
      throw new Error('codex.json: doors/plugs/seats arrays missing');
    }
  } catch (e) {
    // Fail safe: a broken book means the board shows an empty registry —
    // never a crash, never a guessed state.
    console.error('codex load failed:', e.message);
    cached = { codex: 'The Codex for OneMind', version: null, updated: null, law: null, doors: [], plugs: [], seats: [], prices: null };
  }
  return cached;
}

function publicEntry(e) {
  const lv = (e && e.liveness) || {};
  return {
    name: e.name,
    kind: e.kind || null,
    state: e.state != null ? e.state : null,
    liveness: {
      how_checked: lv.how_checked || null,
      last_verified: lv.last_verified || null,
    },
  };
}

function publicBook() {
  const b = load();
  const prices = b.prices || {};
  return {
    codex: b.codex || 'The Codex for OneMind',
    version: b.version != null ? b.version : null,
    updated: b.updated || null,
    law: b.law || null,
    doors: (b.doors || []).map(publicEntry),
    plugs: (b.plugs || []).map(publicEntry),
    seats: (b.seats || []).map(publicEntry),
    prices: {
      status: prices.status || null,
      law: prices.law || null,
      entries: ((prices && prices.entries) || []).map(publicEntry),
    },
  };
}

module.exports = { publicBook };
