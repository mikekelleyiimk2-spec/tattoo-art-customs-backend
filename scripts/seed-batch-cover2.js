// One-time seed: 8 category-coverage designs (batch cover2).
const db = require('../src/db');
const DESIGNS = [
 {
  "category": "Eyes > Realistic Eye",
  "id": "batch-cover-eye",
  "style": "Realism",
  "title": "Realistic Eye"
 },
 {
  "category": "Lighthouses & Beacons > Traditional Lighthouse",
  "id": "batch-cover-lighthouse",
  "style": "Traditional",
  "title": "Traditional Lighthouse"
 },
 {
  "category": "Pirates > Traditional Pirate Ship",
  "id": "batch-cover-ship",
  "style": "Traditional",
  "title": "Traditional Pirate Ship"
 },
 {
  "category": "Retro & Vintage > Vintage Car",
  "id": "batch-cover-car",
  "style": "Traditional",
  "title": "Vintage Car"
 },
 {
  "category": "Seasons > Watercolor Seasons",
  "id": "batch-cover-seasons",
  "style": "Watercolor",
  "title": "Watercolor Seasons"
 },
 {
  "category": "Skeletons & Bones > Blackwork Skull",
  "id": "batch-cover-skull",
  "style": "Blackwork",
  "title": "Blackwork Skull"
 },
 {
  "category": "Tea & Coffee > Minimalist Coffee",
  "id": "batch-cover-coffee",
  "style": "Minimalist",
  "title": "Minimalist Coffee"
 },
 {
  "category": "Technology & Cyber > Blackwork Robot",
  "id": "batch-cover-robot",
  "style": "Blackwork",
  "title": "Blackwork Robot"
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
