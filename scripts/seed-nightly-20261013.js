// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-13).
// Run via Render shell: node scripts/seed-nightly-20261013.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-carvedwood-nautical",
  "title": "Timberwave Kraken",
  "style": "Carved Wood",
  "category": "Nautical / Ocean > Timberwave Kraken"
 },
 {
  "id": "nightly-blueprint-dreams",
  "title": "Slumber Schematic",
  "style": "Blueprint",
  "category": "Dreams & Sleep > Slumber Schematic"
 },
 {
  "id": "nightly-original-circus",
  "title": "Ringmaster's Menagerie",
  "style": "Original",
  "category": "Circus / Carnival > Ringmaster's Menagerie"
 },
 {
  "id": "nightly-script-glaciers",
  "title": "Frozen Verse",
  "style": "Script / Lettering",
  "category": "Glaciers & Icebergs > Frozen Verse"
 },
 {
  "id": "nightly-minimalist-graveyards",
  "title": "Quiet Row of Stones",
  "style": "Minimalist",
  "category": "Graveyards & Tombs > Quiet Row of Stones"
 },
 {
  "id": "nightly-script-waterfalls",
  "title": "Flowing Verse Falls",
  "style": "Script / Lettering",
  "category": "Waterfalls & Rivers > Flowing Verse Falls"
 },
 {
  "id": "nightly-bioluminescent-characters",
  "title": "The Glowkeeper",
  "style": "Bioluminescent",
  "category": "Characters / People > The Glowkeeper"
 },
 {
  "id": "nightly-surrealism-pirates",
  "title": "Melting Compass Cove",
  "style": "Surrealism",
  "category": "Pirates > Melting Compass Cove"
 },
 {
  "id": "nightly-xray-lighthouses",
  "title": "Beacon Bones",
  "style": "X-Ray / Dissection",
  "category": "Lighthouses & Beacons > Beacon Bones"
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
