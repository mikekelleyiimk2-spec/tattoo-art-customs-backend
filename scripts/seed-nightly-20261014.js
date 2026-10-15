// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-14).
// Run via Render shell: node scripts/seed-nightly-20261014.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-topographic-weather",
  "title": "Contour Stormfront",
  "style": "Topographic",
  "category": "Weather & Storms > Contour Stormfront"
 },
 {
  "id": "nightly-realism-celestial",
  "title": "Nebula Watcher",
  "style": "Realism",
  "category": "Celestial / Cosmic > Nebula Watcher"
 },
 {
  "id": "nightly-circuitbloom-cultural",
  "title": "Heritage Circuit Lantern",
  "style": "Circuit Bloom",
  "category": "Cultural Heritage > Heritage Circuit Lantern"
 },
 {
  "id": "nightly-surrealism-sports",
  "title": "Upside-Down Finish Line",
  "style": "Surrealism",
  "category": "Sports > Upside-Down Finish Line"
 },
 {
  "id": "nightly-trashpolka-peace",
  "title": "Peace in the Red Noise",
  "style": "Trash Polka",
  "category": "Peace & Harmony > Peace in the Red Noise"
 },
 {
  "id": "nightly-carvedwood-characters",
  "title": "Timberwood Storyteller",
  "style": "Carved Wood",
  "category": "Characters / People > Timberwood Storyteller"
 },
 {
  "id": "nightly-xray-dolls",
  "title": "Porcelain Anatomy Doll",
  "style": "X-Ray / Dissection",
  "category": "Dolls & Toys > Porcelain Anatomy Doll"
 },
 {
  "id": "nightly-pixelated-glaciers",
  "title": "8-Bit Iceberg Drift",
  "style": "Pixelated",
  "category": "Glaciers & Icebergs > 8-Bit Iceberg Drift"
 },
 {
  "id": "nightly-showcase-biomechanical",
  "title": "Chrome Heart Engine",
  "style": "Showcase",
  "category": "Biomechanical > Chrome Heart Engine"
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
