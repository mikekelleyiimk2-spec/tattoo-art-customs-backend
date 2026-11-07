'use strict';
// Backfill design text fields (AdSense DO-NOW pass 2026-11-07).
//
// The render layer (src/lib/designDescription.js) already guarantees
// every design page substantive, unique text at request time: built
// descriptions for rows whose stored description is a stamp/caption,
// guide or fallback tattooing notes for every tattoo design, coloring
// guidance for coloring pages. This script performs the matching
// STORAGE-side backfill for the legacy rows, so the data itself is
// right too — exports, feeds and any future consumer see real text:
//
//   1. designs.description — for every approved row whose stored
//      description is NOT substantive (stamp family, caption-length,
//      or empty), write the built description for that row's own
//      record. Rows with genuine artist descriptions are never touched.
//   2. designs.style — for rows with an empty style whose categories
//      or id carry a style this site has a guide for, write the guide
//      slug as the stored style (only confident resolutions: a style
//      carried in the categories, or the style token embedded in a
//      nightly id, that notesForStyle actually resolves).
//
// Usage (production shell on the live host, or local):
//   node scripts/backfill-design-text.js            # dry run (default)
//   node scripts/backfill-design-text.js --apply    # write changes
//
// Idempotent: after a successful apply, a second run reports 0 changes.
// Runs inside one transaction; prints counts before and after.
require('dotenv').config();
const db = require('../src/db');
const designDesc = require('../src/lib/designDescription');
const { notesForStyle } = require('../src/lib/styleGuides');

const APPLY = process.argv.includes('--apply');

function slugKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+/g, '-');
}

// Mirror of the style resolution inside notesForDesign: categories
// first, then the style token embedded in nightly-style ids. Returns a
// guide slug only when notesForStyle resolves it — never a guess.
function confidentStyleSlug(design) {
  let cats = design.categories;
  if (typeof cats === 'string') {
    try { cats = JSON.parse(cats); } catch { cats = [cats]; }
  }
  if (!Array.isArray(cats)) cats = [];
  for (const c of cats) {
    const k = slugKey(c);
    if (!k) continue;
    const n = notesForStyle(k);
    if (n && n.guideSlug) return n.guideSlug;
  }
  const idTokens = String(design.id || '').toLowerCase().split('-');
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= idTokens.length; i++) {
      const cand = idTokens.slice(i, i + n).join('-');
      const notes = notesForStyle(cand);
      if (notes && notes.guideSlug) return notes.guideSlug;
    }
  }
  return null;
}

(async () => {
  await db.init();
  const rows = await db.all("SELECT * FROM designs WHERE status = 'approved'");
  const artistRows = await db.all('SELECT id, display_name FROM users');
  const artistName = new Map(artistRows.map((u) => [u.id, u.display_name]));
  let descWrites = 0;
  let styleWrites = 0;
  let kept = 0;
  const updates = [];
  for (const d of rows) {
    const set = {};
    if (!designDesc.isSubstantiveDescription(d.description)) {
      const built = designDesc
        .descriptionParagraphs(d, d.artist_id ? artistName.get(d.artist_id) : null)
        .join('\n\n');
      if (built && built !== String(d.description || '')) {
        set.description = built;
        descWrites++;
      }
    } else {
      kept++;
    }
    if (!String(d.style || '').trim()) {
      const slug = confidentStyleSlug(d);
      if (slug) {
        set.style = slug;
        styleWrites++;
      }
    }
    if (Object.keys(set).length) updates.push({ id: d.id, set });
  }
  console.log(`approved designs scanned: ${rows.length}`);
  console.log(`descriptions kept as stored (genuine): ${kept}`);
  console.log(`descriptions to backfill: ${descWrites}`);
  console.log(`empty styles to backfill: ${styleWrites}`);
  if (!APPLY) {
    console.log('DRY RUN — no writes. Re-run with --apply to write.');
    process.exit(0);
  }
  // db.update runs on the shared handle; on SQLite the single connection
  // makes sequential updates atomic enough for this maintenance write,
  // and on Postgres they run inside the pool's normal flow. (The db
  // module's transaction handle speaks query/get/all only.)
  for (const u of updates) {
    await db.update('designs', u.id, u.set);
  }
  console.log(`APPLIED: ${updates.length} rows updated.`);
  process.exit(0);
})().catch((e) => {
  console.error('backfill failed:', e);
  process.exit(1);
});
