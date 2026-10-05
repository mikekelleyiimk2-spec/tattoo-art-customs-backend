// One-time seed: 10 style top-up designs (batch top5, final).
const db = require('../src/db');
const DESIGNS = [
 {
  "category": "Music > Surreal Piano",
  "id": "batch-top5-surreal1",
  "style": "Surrealism",
  "title": "Surreal Piano"
 },
 {
  "category": "Food & Drink > Thermal Chili",
  "id": "batch-top5-thermal1",
  "style": "Thermal",
  "title": "Thermal Chili"
 },
 {
  "category": "Animals & Wildlife > Thermal Phoenix",
  "id": "batch-top5-thermal2",
  "style": "Thermal",
  "title": "Thermal Phoenix"
 },
 {
  "category": "Sports > Thermal Runner",
  "id": "batch-top5-thermal3",
  "style": "Thermal",
  "title": "Thermal Runner"
 },
 {
  "category": "Music > Thermal Guitar",
  "id": "batch-top5-thermal4",
  "style": "Thermal",
  "title": "Thermal Guitar"
 },
 {
  "category": "Celestial / Cosmic > Topographic Planet",
  "id": "batch-top5-topo1",
  "style": "Topographic",
  "title": "Topographic Planet"
 },
 {
  "category": "Architecture > Topographic City",
  "id": "batch-top5-topo2",
  "style": "Topographic",
  "title": "Topographic City"
 },
 {
  "category": "Music > Trash Polka Skull",
  "id": "batch-top5-trash1",
  "style": "Trash Polka",
  "title": "Trash Polka Skull"
 },
 {
  "category": "Horror > Trash Polka Haunted House",
  "id": "batch-top5-trash2",
  "style": "Trash Polka",
  "title": "Trash Polka Haunted House"
 },
 {
  "category": "Hearts & Anatomy > X-Ray Ribcage",
  "id": "batch-top5-xray1",
  "style": "X-Ray / Dissection",
  "title": "X-Ray Ribcage"
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
