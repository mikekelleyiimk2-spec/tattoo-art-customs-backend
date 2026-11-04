// One-time seed: 7 style x category pair-filler designs (nightly 2026-11-04).
// NOTE: 2 of the night's 9 picks (Watercolor x Mermaids & Sirens, Minimalist x
// Horror) could not be generated this run and are NOT seeded here — no files
// exist for them. Re-pick them on a later nightly run.
// Run via Render shell: node scripts/seed-nightly-20261104.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-surrealism-military-patriotic",
  "title": "The General Whose Medals Bloomed Into Clocks",
  "style": "Surrealism",
  "category": "Military / Patriotic > The General Whose Medals Bloomed Into Clocks"
 },
 {
  "id": "nightly-dark-anime-fire-smoke",
  "title": "The Girl Who Walked Out of the Burning City Smiling",
  "style": "Dark Anime",
  "category": "Fire & Smoke > The Girl Who Walked Out of the Burning City Smiling"
 },
 {
  "id": "nightly-mycelium-mythology-fantasy",
  "title": "The God That Grew From a Single Spore",
  "style": "Mycelium",
  "category": "Mythology & Fantasy > The God That Grew From a Single Spore"
 },
 {
  "id": "nightly-postmodern-horror",
  "title": "The Smile That Was Copied One Too Many Times",
  "style": "Postmodern",
  "category": "Horror > The Smile That Was Copied One Too Many Times"
 },
 {
  "id": "nightly-smoke-form-portraits-memorial",
  "title": "The Grandmother Whose Face Rose With the Incense",
  "style": "Smoke Form",
  "category": "Portraits / Memorial > The Grandmother Whose Face Rose With the Incense"
 },
 {
  "id": "nightly-absurdist-music",
  "title": "The Trumpet That Played a Fish Instead of a Note",
  "style": "Absurdist",
  "category": "Music > The Trumpet That Played a Fish Instead of a Note"
 },
 {
  "id": "nightly-frost-fractal-cultural-heritage",
  "title": "The Quilt Pattern That Froze Into Geometry",
  "style": "Frost Fractal",
  "category": "Cultural Heritage > The Quilt Pattern That Froze Into Geometry"
 }
];
(async () => {
  await db.init();
  const now = Date.now();
  for (const d of DESIGNS) {
    const file = `${d.id}.jpg`;
    await db.upsert('designs', 'id', {
      id: d.id, title: d.title,
      description: `Original ${d.style} tattoo design "${d.title}". Full color with shading and background plus matching clean linework included.`,
      categories: JSON.stringify([d.category]),
      color_path: `/img/designs/${file}`, linework_path: `/img/designs/${file}`, linework_wm_path: `/img/designs/${file}`,
      style: d.style, price_cents: 7500, status: 'approved', listing_scope: 'gallery',
      created_at: now, sale_count: 0,
    });
    console.log(`upserted: ${d.id}`);
  }
  console.log('DONE');
  await db.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
