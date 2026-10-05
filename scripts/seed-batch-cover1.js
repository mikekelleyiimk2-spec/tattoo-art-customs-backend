// One-time seed: 9 style-coverage designs (batch cover1).
const db = require('../src/db');
const DESIGNS = [
 {
  "category": "Volcanoes & Lava > Thermal Volcano",
  "id": "batch-cover-volcano",
  "style": "Thermal",
  "title": "Thermal Volcano"
 },
 {
  "category": "Treehouses & Cabins > Blueprint Cabin",
  "id": "batch-cover-cabin",
  "style": "Blueprint",
  "title": "Blueprint Cabin"
 },
 {
  "category": "Peace & Harmony > Cross-Stitch Dove",
  "id": "batch-cover-dove",
  "style": "Cross-Stitch",
  "title": "Cross-Stitch Dove"
 },
 {
  "category": "Portals & Doors > Stained Shard Door",
  "id": "batch-cover-door",
  "style": "Stained Shard",
  "title": "Stained Shard Door"
 },
 {
  "category": "Swamps & Bayous > Bioluminescent Swamp",
  "id": "batch-cover-swamp",
  "style": "Bioluminescent",
  "title": "Bioluminescent Swamp"
 },
 {
  "category": "Vineyards & Orchards > Mycelium Vineyard",
  "id": "batch-cover-vineyard",
  "style": "Mycelium",
  "title": "Mycelium Vineyard"
 },
 {
  "category": "Weather & Storms > Aurora Storm",
  "id": "batch-cover-storm",
  "style": "Aurora Veil",
  "title": "Aurora Storm"
 },
 {
  "category": "Waterfalls & Rivers > Frost Waterfall",
  "id": "batch-cover-falls",
  "style": "Frost Fractal",
  "title": "Frost Waterfall"
 },
 {
  "category": "Warriors > B&G Warrior",
  "id": "batch-cover-warrior",
  "style": "Black & Grey Realism",
  "title": "B&G Warrior"
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
