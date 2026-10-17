// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-16).
// Run via Render shell: node scripts/seed-nightly-20261016.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-blueprint-love",
  "title": "Blueprint of Two Hearts",
  "style": "Blueprint",
  "category": "Love / Hearts / Couples > Blueprint of Two Hearts"
 },
 {
  "id": "nightly-traditional-dolls",
  "title": "Sailor's Rag Doll Sweetheart",
  "style": "Traditional",
  "category": "Dolls & Toys > Sailor's Rag Doll Sweetheart"
 },
 {
  "id": "nightly-script-aliens",
  "title": "Take Me With You",
  "style": "Script / Lettering",
  "category": "Aliens / UFOs > Take Me With You"
 },
 {
  "id": "nightly-postmodern-architecture",
  "title": "Deconstructed Cathedral",
  "style": "Postmodern",
  "category": "Architecture > Deconstructed Cathedral"
 },
 {
  "id": "nightly-surrealism-hands",
  "title": "Hands Counting Moons",
  "style": "Surrealism",
  "category": "Hands & Gestures > Hands Counting Moons"
 },
 {
  "id": "nightly-thermal-crowns",
  "title": "Heat-Signature Crown",
  "style": "Thermal",
  "category": "Crowns & Royalty > Heat-Signature Crown"
 },
 {
  "id": "nightly-neojapanese-gardens",
  "title": "Koi Garden Labyrinth",
  "style": "Neo-Japanese",
  "category": "Gardens & Mazes > Koi Garden Labyrinth"
 },
 {
  "id": "nightly-realism-geometric",
  "title": "Eye Within the Golden Geometry",
  "style": "Realism",
  "category": "Geometric / Abstract > Eye Within the Golden Geometry"
 },
 {
  "id": "nightly-graffiti-masks",
  "title": "Spray-Can Masquerade",
  "style": "Graffiti",
  "category": "Masks > Spray-Can Masquerade"
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
