// Video-game background → matching by-request character mapping.
//
// Each video-game background design (vg-<game>-bg and vg-<game>-bg-fullpage,
// see migrations/067_vg_bg_character_notes.pg.sql) was drawn to fit a specific
// character. This module maps background design IDs to the by-request
// character slugs that belong to them, so the gallery/design pages can link
// each background to its characters.
//
// The slugs must exist in assets/catalog/by-request.json (validated by the
// /order/custom?character=<slug> route). Backgrounds with no matching
// character in the catalog (Tetris, Punch-Out) map to an empty list.
const fs = require('fs');
const path = require('path');

let nameCache = null;
function characterNames() {
  if (nameCache) return nameCache;
  nameCache = {};
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, '..', '..', 'assets', 'catalog', 'by-request.json'), 'utf8');
    for (const item of JSON.parse(raw).items || []) {
      if (item.slug) nameCache[item.slug] = item.name;
    }
  } catch {
    // by-request.json missing — names fall back to the slug.
  }
  return nameCache;
}

// Background design ID base (without -fullpage suffix) → by-request slugs.
const VG_BG_CHARACTERS = {
  'vg-tetris-bg': [],
  'vg-minecraft-bg': ['steve'],
  'vg-zelda-oot-bg': ['link'],
  'vg-mario-bros-bg': ['mario'],
  'vg-zelda-botw-bg': ['link'],
  'vg-rdr2-bg': ['arthur-morgan'],
  'vg-mario-64-bg': ['mario'],
  'vg-half-life-2-bg': ['gordon-freeman'],
  'vg-elden-ring-bg': ['ranni-the-witch', 'malenia'],
  'vg-witcher-3-bg': ['geralt-of-rivia'],
  'vg-portal-2-bg': ['glados', 'companion-cube'],
  'vg-gta-v-bg': ['carl-cj-johnson'],
  'vg-pac-man-bg': ['pac-man'],
  'vg-ff7-bg': ['cloud-strife', 'tifa-lockhart', 'sephiroth'],
  'vg-mario-bros-arcade-bg': ['mario', 'luigi'],
  'vg-punch-out-bg': [],
  'vg-donkey-kong-bg': ['donkey-kong'],
  'vg-zelda-1986-bg': ['link'],
  'vg-megaman-bg': ['mega-man'],
};

// Returns [{ slug, name }] for the characters belonging to a background
// design, or [] when the design is not a video-game background (or has no
// cataloged character). Handles the -fullpage edition suffix.
function matchingCharacters(designId) {
  if (!designId) return [];
  const base = String(designId).replace(/-fullpage$/, '');
  const slugs = VG_BG_CHARACTERS[base];
  if (!slugs || !slugs.length) return [];
  const names = characterNames();
  return slugs.map((slug) => ({ slug, name: names[slug] || slug }));
}

module.exports = { matchingCharacters, VG_BG_CHARACTERS };
