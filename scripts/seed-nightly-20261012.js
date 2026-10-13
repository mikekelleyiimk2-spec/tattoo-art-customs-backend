// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-12).
// Run via Render shell: node scripts/seed-nightly-20261012.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-trashpolka-western",
  "title": "Outlaw Chaos Collage",
  "style": "Trash Polka",
  "category": "Western > Outlaw Chaos Collage"
 },
 {
  "id": "nightly-blueprint-americana",
  "title": "Liberty Draft",
  "style": "Blueprint",
  "category": "Americana / Traditional > Liberty Draft"
 },
 {
  "id": "nightly-smokeform-chess",
  "title": "Smoke Gambit",
  "style": "Smoke Form",
  "category": "Chess & Games > Smoke Gambit"
 },
 {
  "id": "nightly-ignorant-architecture",
  "title": "Wonky Tower Block",
  "style": "Ignorant Style",
  "category": "Architecture > Wonky Tower Block"
 },
 {
  "id": "nightly-darkanime-gardens",
  "title": "Midnight Maze Garden",
  "style": "Dark Anime",
  "category": "Gardens & Mazes > Midnight Maze Garden"
 },
 {
  "id": "nightly-frostfractal-mushrooms",
  "title": "Frostcap Cluster",
  "style": "Frost Fractal",
  "category": "Mushrooms / Discworld > Frostcap Cluster"
 },
 {
  "id": "nightly-minimalist-love",
  "title": "One Line, Two Hearts",
  "style": "Minimalist",
  "category": "Love / Hearts / Couples > One Line, Two Hearts"
 },
 {
  "id": "nightly-crossstitch-portals",
  "title": "Stitched Threshold",
  "style": "Cross-Stitch",
  "category": "Portals & Doors > Stitched Threshold"
 },
 {
  "id": "nightly-pixelated-bridges",
  "title": "Pixel Span",
  "style": "Pixelated",
  "category": "Bridges > Pixel Span"
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
