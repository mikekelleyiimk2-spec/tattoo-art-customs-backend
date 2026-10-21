// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-20).
// Run via Render shell: node scripts/seed-nightly-20261020.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-bioluminescent-fire-smoke",
  "title": "Ember Jellyfish Rising From the Campfire",
  "style": "Bioluminescent",
  "category": "Fire & Smoke > Ember Jellyfish Rising From the Campfire"
 },
 {
  "id": "nightly-surrealism-wings",
  "title": "The Umbrella That Grew Wings",
  "style": "Surrealism",
  "category": "Wings > The Umbrella That Grew Wings"
 },
 {
  "id": "nightly-topographic-fire-smoke",
  "title": "Elevation Lines of the Smoking Peak",
  "style": "Topographic",
  "category": "Fire & Smoke > Elevation Lines of the Smoking Peak"
 },
 {
  "id": "nightly-blueprint-mixed-combination-concepts",
  "title": "Octopus Lantern Engine Schematic",
  "style": "Blueprint",
  "category": "Mixed / Combination Concepts > Octopus Lantern Engine Schematic"
 },
 {
  "id": "nightly-topographic-pirates",
  "title": "Contour Map to Dead Man's Cove",
  "style": "Topographic",
  "category": "Pirates > Contour Map to Dead Man's Cove"
 },
 {
  "id": "nightly-original-celestial-cosmic",
  "title": "Fox Curled Around the Crescent Moon",
  "style": "Original",
  "category": "Celestial / Cosmic > Fox Curled Around the Crescent Moon"
 },
 {
  "id": "nightly-surrealism-angels-demons",
  "title": "The Angel and the Imp Sharing Tea",
  "style": "Surrealism",
  "category": "Angels & Demons > The Angel and the Imp Sharing Tea"
 },
 {
  "id": "nightly-circuit-bloom-nature-scene-concepts",
  "title": "Circuit Vine Blooming Over the Riverbank",
  "style": "Circuit Bloom",
  "category": "Nature / Scene Concepts > Circuit Vine Blooming Over the Riverbank"
 },
 {
  "id": "nightly-postmodern-farmland-barns",
  "title": "Deconstructed Barn in Primary Blocks",
  "style": "Postmodern",
  "category": "Farmland & Barns > Deconstructed Barn in Primary Blocks"
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
