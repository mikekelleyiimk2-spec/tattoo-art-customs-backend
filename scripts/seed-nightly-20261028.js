// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-28).
// Run via Render shell: node scripts/seed-nightly-20261028.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-stained-shard-forests",
  "title": "The Pine That Grew Through Stained Glass",
  "style": "Stained Shard",
  "category": "Forests > The Pine That Grew Through Stained Glass"
 },
 {
  "id": "nightly-script-lettering-portals-doors",
  "title": "The Door That Spelled Itself Open",
  "style": "Script / Lettering",
  "category": "Portals & Doors > The Door That Spelled Itself Open"
 },
 {
  "id": "nightly-topographic-mythology-fantasy",
  "title": "The Dragon That Slept in Contour Lines",
  "style": "Topographic",
  "category": "Mythology & Fantasy > The Dragon That Slept in Contour Lines"
 },
 {
  "id": "nightly-trash-polka-coral-reefs",
  "title": "The Reef That Shattered in Red and Black",
  "style": "Trash Polka",
  "category": "Coral Reefs > The Reef That Shattered in Red and Black"
 },
 {
  "id": "nightly-showcase-tattoo-styles",
  "title": "The Wheel That Showcased Every Style",
  "style": "Showcase",
  "category": "Tattoo Styles > The Wheel That Showcased Every Style"
 },
 {
  "id": "nightly-aurora-veil-sci-fi-futuristic",
  "title": "The City Beneath the Aurora Veil",
  "style": "Aurora Veil",
  "category": "Sci-Fi / Futuristic > The City Beneath the Aurora Veil"
 },
 {
  "id": "nightly-showcase-mixed-combination-concepts",
  "title": "The Koi That Swam Through Clockwork Blooms",
  "style": "Showcase",
  "category": "Mixed / Combination Concepts > The Koi That Swam Through Clockwork Blooms"
 },
 {
  "id": "nightly-topographic-floral-botanical",
  "title": "The Rose Mapped in Contour Lines",
  "style": "Topographic",
  "category": "Floral & Botanical > The Rose Mapped in Contour Lines"
 },
 {
  "id": "nightly-dark-anime-cultural-heritage",
  "title": "The Lantern Guardian of the Harvest Festival",
  "style": "Dark Anime",
  "category": "Cultural Heritage > The Lantern Guardian of the Harvest Festival"
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
