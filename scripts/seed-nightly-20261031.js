// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-31).
// Run via Render shell: node scripts/seed-nightly-20261031.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-ignorant-style-hearts-anatomy",
  "title": "The Heart That Skipped Anatomy Class",
  "style": "Ignorant Style",
  "category": "Hearts & Anatomy > The Heart That Skipped Anatomy Class"
 },
 {
  "id": "nightly-frost-fractal-objects-mechanical",
  "title": "The Clockwork Snowflake That Froze the Gears",
  "style": "Frost Fractal",
  "category": "Objects & Mechanical > The Clockwork Snowflake That Froze the Gears"
 },
 {
  "id": "nightly-x-ray-dissection-clowns-jesters",
  "title": "The Jester Dissected Mid-Laugh",
  "style": "X-Ray / Dissection",
  "category": "Clowns & Jesters > The Jester Dissected Mid-Laugh"
 },
 {
  "id": "nightly-trash-polka-warriors",
  "title": "The Last Warrior Standing in the Red Ruin",
  "style": "Trash Polka",
  "category": "Warriors > The Last Warrior Standing in the Red Ruin"
 },
 {
  "id": "nightly-mycelium-mushrooms-discworld",
  "title": "The Mycelium Atlas Beneath the Flat World",
  "style": "Mycelium",
  "category": "Mushrooms / Discworld > The Mycelium Atlas Beneath the Flat World"
 },
 {
  "id": "nightly-black-grey-realism-angels-demons",
  "title": "The Angel Who Bargained With Her Shadow",
  "style": "Black & Grey Realism",
  "category": "Angels & Demons > The Angel Who Bargained With Her Shadow"
 },
 {
  "id": "nightly-postmodern-tattoo-styles",
  "title": "The Flash Sheet That Deconstructed Itself",
  "style": "Postmodern",
  "category": "Tattoo Styles > The Flash Sheet That Deconstructed Itself"
 },
 {
  "id": "nightly-aurora-veil-lighthouses-beacons",
  "title": "The Lighthouse Veiled in Northern Light",
  "style": "Aurora Veil",
  "category": "Lighthouses & Beacons > The Lighthouse Veiled in Northern Light"
 },
 {
  "id": "nightly-dark-anime-castles-fortresses",
  "title": "The Hollow Captain of the Midnight Fortress",
  "style": "Dark Anime",
  "category": "Castles & Fortresses > The Hollow Captain of the Midnight Fortress"
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
