// Link Rolodexes — per-family link registries (2026-10-26).
//
// Owner route (2026-10-26 13:26–13:32): the Affiliate Rolodex holds
// affiliates and stays its OWN product (src/lib/rolodex.js — untouched by
// this module). Every OTHER link family gets the same rolodex pattern as
// its own separable registry: one data file per family in src/data/,
// one read endpoint per family, and /api/links as the Master index.
// A link lands once in its family file and lights up everywhere; a change
// in the file updates every pull. Families are NEVER blended into one
// blob — each is independently pullable.
//
// Contract, enforced here:
// - visibility:"internal" entries are NEVER projected publicly. There is
//   no "all" mode.
// - Entries with url:null are state records (a storefront that exists
//   but has no canonical URL in the records yet) — they project with
//   url:null and their state/verified fields saying why; a URL is never
//   invented to fill the slot.
// - Kid-safe pulls (?kid_safe=1) return kid_safe:true entries only, so a
//   kid surface can pull a family without ever seeing a tattoo/21+ link.
const fs = require('fs');
const path = require('path');

const FAMILIES = {
  socials: { file: 'social-links.json', endpoint: '/api/social-links', label: 'Social Link Rolodex' },
  web_pages: { file: 'web-links.json', endpoint: '/api/web-links', label: 'Web Links' },
  channels: { file: 'channel-links.json', endpoint: '/api/channel-links', label: 'Channel Links' },
  storefronts: { file: 'storefront-links.json', endpoint: '/api/storefront-links', label: 'Storefront Links' },
  app_links: { file: 'play-links.json', endpoint: '/api/play-links', label: 'App & Store Links' },
  money: { file: 'money-links.json', endpoint: '/api/money-links', label: 'Money Links' },
};

const cache = {};

function load(key) {
  if (cache[key]) return cache[key];
  const fam = FAMILIES[key];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', fam.file), 'utf8'));
    if (!raw || !Array.isArray(raw.entries)) throw new Error(`${fam.file}: entries[] missing`);
    cache[key] = raw;
  } catch (e) {
    // Fail safe: a broken family file serves an empty family — never a
    // crash, never a guessed link.
    console.error(`links load failed (${key}):`, e.message);
    cache[key] = { family: key, version: null, updated: null, entries: [] };
  }
  return cache[key];
}

function publicEntry(e) {
  return {
    name: e.name,
    url: e.url != null ? e.url : null,
    kind: e.kind || null,
    world: e.world || null,
    kid_safe: e.kid_safe === true,
    state: e.state || null,
    verified: e.verified || null,
    placed: Array.isArray(e.placed) ? e.placed : [],
  };
}

function publicEntries(key, { kidSafe = false } = {}) {
  return load(key).entries
    .filter((e) => e && e.visibility !== 'internal')
    .filter((e) => !kidSafe || e.kid_safe === true)
    .map(publicEntry);
}

function familyPayload(key, opts) {
  const fam = FAMILIES[key];
  const data = load(key);
  const entries = publicEntries(key, opts);
  return {
    ok: true,
    family: key,
    rolodex: fam.label,
    version: data.version != null ? data.version : null,
    updated: data.updated || null,
    count: entries.length,
    entries,
  };
}

// The Master Rolodex index ("All My Links"): every family as a section —
// the affiliate family points at its own untouched /api/rolodex.
function indexPayload(rolodexCounts) {
  const families = {
    affiliates: {
      endpoint: '/api/rolodex',
      label: 'Affiliate Rolodex',
      count: rolodexCounts && rolodexCounts.total != null ? rolodexCounts.total : null,
      live: rolodexCounts && rolodexCounts.live != null ? rolodexCounts.live : null,
    },
  };
  for (const key of Object.keys(FAMILIES)) {
    families[key] = {
      endpoint: FAMILIES[key].endpoint,
      label: FAMILIES[key].label,
      count: publicEntries(key).length,
    };
  }
  return { ok: true, rolodex: 'Master Link Rolodex — All My Links', updated: '2026-10-26', families };
}

module.exports = { FAMILIES, load, publicEntries, familyPayload, indexPayload };
