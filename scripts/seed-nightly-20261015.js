// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-15).
// Run via Render shell: node scripts/seed-nightly-20261015.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-crossstitch-technology",
  "title": "Stitched Circuit Heart",
  "style": "Cross-Stitch",
  "category": "Technology & Cyber > Stitched Circuit Heart"
 },
 {
  "id": "nightly-crossstitch-dinosaurs",
  "title": "Stitched Triceratops Sampler",
  "style": "Cross-Stitch",
  "category": "Dinosaurs / Prehistoric > Stitched Triceratops Sampler"
 },
 {
  "id": "nightly-origami-military",
  "title": "Origami Eagle Salute",
  "style": "Origami",
  "category": "Military / Patriotic > Origami Eagle Salute"
 },
 {
  "id": "nightly-pixelated-graveyards",
  "title": "Pixel Tombstone Moonrise",
  "style": "Pixelated",
  "category": "Graveyards & Tombs > Pixel Tombstone Moonrise"
 },
 {
  "id": "nightly-absurdist-chess",
  "title": "Melting Chess Knight's Banquet",
  "style": "Absurdist",
  "category": "Chess & Games > Melting Chess Knight's Banquet"
 },
 {
  "id": "nightly-xray-waterfalls",
  "title": "Dissected Cascade Anatomy",
  "style": "X-Ray / Dissection",
  "category": "Waterfalls & Rivers > Dissected Cascade Anatomy"
 },
 {
  "id": "nightly-aurora-glaciers",
  "title": "Veiled Iceberg Aurora",
  "style": "Aurora Veil",
  "category": "Glaciers & Icebergs > Veiled Iceberg Aurora"
 },
 {
  "id": "nightly-aurora-americana",
  "title": "Aurora Americana Eagle",
  "style": "Aurora Veil",
  "category": "Americana / Traditional > Aurora Americana Eagle"
 },
 {
  "id": "nightly-showcase-warriors",
  "title": "Golden Samurai Showpiece",
  "style": "Showcase",
  "category": "Warriors > Golden Samurai Showpiece"
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
