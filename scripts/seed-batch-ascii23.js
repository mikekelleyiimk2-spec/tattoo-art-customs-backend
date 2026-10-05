// One-time seed: 16 ASCII Skin pair-filler designs.
// Run via Render shell: node scripts/seed-batch-ascii23.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "batch-ascii-alien",
  "title": "ASCII Alien",
  "style": "ASCII Skin",
  "category": "Aliens / UFOs > ASCII Alien"
 },
 {
  "id": "batch-ascii-eagle",
  "title": "ASCII Eagle",
  "style": "ASCII Skin",
  "category": "Americana / Traditional > ASCII Eagle"
 },
 {
  "id": "batch-ascii-pyramid",
  "title": "ASCII Pyramid",
  "style": "ASCII Skin",
  "category": "Ancient Civilizations > ASCII Pyramid"
 },
 {
  "id": "batch-ascii-angel",
  "title": "ASCII Angel",
  "style": "ASCII Skin",
  "category": "Angels & Demons > ASCII Angel"
 },
 {
  "id": "batch-ascii-wolf",
  "title": "ASCII Wolf",
  "style": "ASCII Skin",
  "category": "Animals & Wildlife > ASCII Wolf"
 },
 {
  "id": "batch-ascii-samurai",
  "title": "ASCII Samurai",
  "style": "ASCII Skin",
  "category": "Anime / Manga > ASCII Samurai"
 },
 {
  "id": "batch-ascii-castle",
  "title": "ASCII Castle",
  "style": "ASCII Skin",
  "category": "Architecture > ASCII Castle"
 },
 {
  "id": "batch-ascii-polarbear",
  "title": "ASCII Polar Bear",
  "style": "ASCII Skin",
  "category": "Arctic & Polar > ASCII Polar Bear"
 },
 {
  "id": "batch-ascii-bow",
  "title": "ASCII Bow",
  "style": "ASCII Skin",
  "category": "Arrows & Archery > ASCII Bow"
 },
 {
  "id": "batch-ascii-telescope",
  "title": "ASCII Telescope",
  "style": "ASCII Skin",
  "category": "Astronomy Tools > ASCII Telescope"
 },
 {
  "id": "batch-ascii-cyborg",
  "title": "ASCII Cyborg",
  "style": "ASCII Skin",
  "category": "Biomechanical > ASCII Cyborg"
 },
 {
  "id": "batch-ascii-owl",
  "title": "ASCII Owl",
  "style": "ASCII Skin",
  "category": "Birds > ASCII Owl"
 },
 {
  "id": "batch-ascii-book",
  "title": "ASCII Book",
  "style": "ASCII Skin",
  "category": "Books & Literature > ASCII Book"
 },
 {
  "id": "batch-ascii-bridge",
  "title": "ASCII Bridge",
  "style": "ASCII Skin",
  "category": "Bridges > ASCII Bridge"
 },
 {
  "id": "batch-ascii-lollipop",
  "title": "ASCII Lollipop",
  "style": "ASCII Skin",
  "category": "Candy / Sweets > ASCII Lollipop"
 },
 {
  "id": "batch-ascii-robot",
  "title": "ASCII Robot",
  "style": "ASCII Skin",
  "category": "Cartoon / Pop Culture > ASCII Robot"
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
