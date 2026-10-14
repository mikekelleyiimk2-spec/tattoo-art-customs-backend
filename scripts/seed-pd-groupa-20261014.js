// One-time seed: final 2 Group A public-domain character designs (original renditions).
// Tarzan = Edgar Rice Burroughs' 1912 novel version (public domain) — original
// book interpretation only, no Disney or later film trade dress.
// Sun Wukong = the 16th-century Journey to the West Monkey King (public domain) —
// original interpretation only, never the Black Myth: Wukong game design.
// Owner standing rule 2026-10-08 + rights triage 2026-10-12: public-domain versions
// go in the MAIN GALLERY as original art; copyrighted versions stay by-request only.
// Generated 2026-10-13 (run interrupted before filing); filed 2026-10-14.
// Run via Render shell: node scripts/seed-pd-groupa-20261014.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "pd-tarzan",
  "title": "Tarzan",
  "style": "Original",
  "category": "Classic Tales > Tarzan",
  "slug": "tarzan",
  "description": "Original public-domain tattoo design of Tarzan from Edgar Rice Burroughs' 1912 novel — long-haired jungle hero in a loincloth, gripping a vine. Full color with shading plus matching clean linework included.",
  "hasColor": true
 },
 {
  "id": "pd-wukong",
  "title": "Sun Wukong, the Monkey King",
  "style": "Original",
  "category": "Mythology & Fantasy > Sun Wukong, the Monkey King",
  "slug": "wukong",
  "description": "Original public-domain tattoo design of Sun Wukong, the Monkey King from the 16th-century Journey to the West — armored monkey warrior with his staff and tiger-skin sash. Full color with shading plus matching clean linework included.",
  "hasColor": true
 }
];
(async () => {
  await db.init();
  const now = Date.now();
  for (const d of DESIGNS) {
    await db.upsert('designs', 'id', {
      id: d.id, title: d.title,
      description: d.description,
      categories: JSON.stringify([d.category]),
      linework_wm_path: `/img/designs/${d.slug}.jpg`,
      linework_path: `designs/linework-clean/${d.slug}.jpg`,
      color_path: d.hasColor ? `designs/color-clean/${d.slug}.jpg` : '',
      style: d.style, price_cents: 7500, status: 'approved', listing_scope: 'gallery',
      created_at: now, sale_count: 0,
    });
    console.log(`upserted: ${d.id} (color: ${d.hasColor ? 'yes' : 'linework-only'})`);
  }
  console.log('DONE');
  await db.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
