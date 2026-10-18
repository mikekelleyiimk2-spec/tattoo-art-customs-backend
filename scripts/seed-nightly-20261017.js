// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-17).
// Run via Render shell: node scripts/seed-nightly-20261017.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-geometric-surreal",
  "title": "Impossible Staircase Eye",
  "style": "Geometric",
  "category": "Surreal / Bizarre > Impossible Staircase Eye"
 },
 {
  "id": "nightly-script-candy",
  "title": "Sweet Life in Candy Script",
  "style": "Script / Lettering",
  "category": "Candy / Sweets > Sweet Life in Candy Script"
 },
 {
  "id": "nightly-blackwork-treehouses",
  "title": "Canopy Cabin in Solid Black",
  "style": "Blackwork",
  "category": "Treehouses & Cabins > Canopy Cabin in Solid Black"
 },
 {
  "id": "nightly-realism-aliens",
  "title": "Grey Visitor Portrait",
  "style": "Realism",
  "category": "Aliens / UFOs > Grey Visitor Portrait"
 },
 {
  "id": "nightly-geometric-clowns",
  "title": "Sacred Geometry Jester",
  "style": "Geometric",
  "category": "Clowns & Jesters > Sacred Geometry Jester"
 },
 {
  "id": "nightly-trashpolka-feathers",
  "title": "Chaos Feather Rebellion",
  "style": "Trash Polka",
  "category": "Feathers > Chaos Feather Rebellion"
 },
 {
  "id": "nightly-circuitbloom-lighthouses",
  "title": "Electric Beacon Bloom",
  "style": "Circuit Bloom",
  "category": "Lighthouses & Beacons > Electric Beacon Bloom"
 },
 {
  "id": "nightly-smokeform-zodiac",
  "title": "Smoke Zodiac Wheel",
  "style": "Smoke Form",
  "category": "Zodiac / Astrology > Smoke Zodiac Wheel"
 },
 {
  "id": "nightly-aurora-time",
  "title": "Aurora Veil Pocket Watch",
  "style": "Aurora Veil",
  "category": "Time / Clocks > Aurora Veil Pocket Watch"
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
