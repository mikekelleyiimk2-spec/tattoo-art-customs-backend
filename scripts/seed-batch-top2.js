// One-time seed: 15 style top-up designs (batch top2).
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "batch-top2-blue1",
  "title": "Blueprint Castle",
  "style": "Blueprint",
  "category": "Castles & Fortresses > Blueprint Castle"
 },
 {
  "id": "batch-top2-blue2",
  "title": "Blueprint Lighthouse",
  "style": "Blueprint",
  "category": "Lighthouses & Beacons > Blueprint Lighthouse"
 },
 {
  "id": "batch-top2-wood1",
  "title": "Carved Wood Face",
  "style": "Carved Wood",
  "category": "Portraits / Memorial > Carved Wood Face"
 },
 {
  "id": "batch-top2-circuit1",
  "title": "Circuit Robot",
  "style": "Circuit Bloom",
  "category": "Technology & Cyber > Circuit Robot"
 },
 {
  "id": "batch-top2-anime1",
  "title": "Dark Anime Demon",
  "style": "Dark Anime",
  "category": "Horror > Dark Anime Demon"
 },
 {
  "id": "batch-top2-cross1",
  "title": "Cross-Stitch Flower",
  "style": "Cross-Stitch",
  "category": "Floral & Botanical > Cross-Stitch Flower"
 },
 {
  "id": "batch-top2-cross2",
  "title": "Cross-Stitch Fox",
  "style": "Cross-Stitch",
  "category": "Animals & Wildlife > Cross-Stitch Fox"
 },
 {
  "id": "batch-top2-cross3",
  "title": "Cross-Stitch Heart",
  "style": "Cross-Stitch",
  "category": "Hearts & Anatomy > Cross-Stitch Heart"
 },
 {
  "id": "batch-top2-cross4",
  "title": "Cross-Stitch Moon",
  "style": "Cross-Stitch",
  "category": "Celestial / Cosmic > Cross-Stitch Moon"
 },
 {
  "id": "batch-top2-frost1",
  "title": "Frost Polar Bear",
  "style": "Frost Fractal",
  "category": "Arctic & Polar > Frost Polar Bear"
 },
 {
  "id": "batch-top2-frost2",
  "title": "Frost Iceberg",
  "style": "Frost Fractal",
  "category": "Glaciers & Icebergs > Frost Iceberg"
 },
 {
  "id": "batch-top2-frost3",
  "title": "Frost Snowflake",
  "style": "Frost Fractal",
  "category": "Seasons > Frost Snowflake"
 },
 {
  "id": "batch-top2-frost4",
  "title": "Frost Crystal",
  "style": "Frost Fractal",
  "category": "Crystals & Gems > Frost Crystal"
 },
 {
  "id": "batch-top2-geo1",
  "title": "Geometric Wolf",
  "style": "Geometric",
  "category": "Animals & Wildlife > Geometric Wolf"
 },
 {
  "id": "batch-top2-geo2",
  "title": "Geometric Mountain",
  "style": "Geometric",
  "category": "Nature / Scene Concepts > Geometric Mountain"
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
