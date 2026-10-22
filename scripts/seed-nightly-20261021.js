// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-21).
// Run via Render shell: node scripts/seed-nightly-20261021.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-surrealism-biomechanical",
  "title": "The Aquarium Inside the Machine",
  "style": "Surrealism",
  "category": "Biomechanical > The Aquarium Inside the Machine"
 },
 {
  "id": "nightly-surrealism-bridges",
  "title": "The Bridge That Crossed the Sky",
  "style": "Surrealism",
  "category": "Bridges > The Bridge That Crossed the Sky"
 },
 {
  "id": "nightly-watercolor-forests",
  "title": "The Fox the Forest Painted",
  "style": "Watercolor",
  "category": "Forests > The Fox the Forest Painted"
 },
 {
  "id": "nightly-geometric-portraits-memorial",
  "title": "Her Face in Golden Triangles",
  "style": "Geometric",
  "category": "Portraits / Memorial > Her Face in Golden Triangles"
 },
 {
  "id": "nightly-carved-wood-graveyards-tombs",
  "title": "The Owl Above the Wooden Gate",
  "style": "Carved Wood",
  "category": "Graveyards & Tombs > The Owl Above the Wooden Gate"
 },
 {
  "id": "nightly-dark-anime-religious-spiritual-occult",
  "title": "Seraph of the Black Chapel",
  "style": "Dark Anime",
  "category": "Religious / Spiritual / Occult > Seraph of the Black Chapel"
 },
 {
  "id": "nightly-graffiti-dolls-toys",
  "title": "The Marionette Who Tagged the Moon",
  "style": "Graffiti",
  "category": "Dolls & Toys > The Marionette Who Tagged the Moon"
 },
 {
  "id": "nightly-mosaic-chess-games",
  "title": "The Knight Who Broke the Board",
  "style": "Mosaic",
  "category": "Chess & Games > The Knight Who Broke the Board"
 },
 {
  "id": "nightly-geometric-fitness-gym",
  "title": "Strength in Every Angle",
  "style": "Geometric",
  "category": "Fitness / Gym > Strength in Every Angle"
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
