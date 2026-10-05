// One-time seed: 15 ASCII Skin pair-filler designs (batch 7).
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "batch-ascii-yinyang",
  "title": "ASCII Yin Yang",
  "style": "ASCII Skin",
  "category": "Mixed / Combination Concepts > ASCII Yin Yang"
 },
 {
  "id": "batch-ascii-mushroom",
  "title": "ASCII Mushroom",
  "style": "ASCII Skin",
  "category": "Mushrooms / Discworld > ASCII Mushroom"
 },
 {
  "id": "batch-ascii-treble",
  "title": "ASCII Treble Clef",
  "style": "ASCII Skin",
  "category": "Music > ASCII Treble Clef"
 },
 {
  "id": "batch-ascii-dragon",
  "title": "ASCII Dragon",
  "style": "ASCII Skin",
  "category": "Mythology & Fantasy > ASCII Dragon"
 },
 {
  "id": "batch-ascii-mountain",
  "title": "ASCII Mountain",
  "style": "ASCII Skin",
  "category": "Nature / Scene Concepts > ASCII Mountain"
 },
 {
  "id": "batch-ascii-anchor",
  "title": "ASCII Anchor",
  "style": "ASCII Skin",
  "category": "Nautical / Ocean > ASCII Anchor"
 },
 {
  "id": "batch-ascii-watch",
  "title": "ASCII Pocket Watch",
  "style": "ASCII Skin",
  "category": "Objects & Mechanical > ASCII Pocket Watch"
 },
 {
  "id": "batch-ascii-dove",
  "title": "ASCII Dove",
  "style": "ASCII Skin",
  "category": "Peace & Harmony > ASCII Dove"
 },
 {
  "id": "batch-ascii-cat",
  "title": "ASCII Cat",
  "style": "ASCII Skin",
  "category": "Pets / Pet Memorial > ASCII Cat"
 },
 {
  "id": "batch-ascii-pinup",
  "title": "ASCII Pinup",
  "style": "ASCII Skin",
  "category": "Pinup > ASCII Pinup"
 },
 {
  "id": "batch-ascii-pirate",
  "title": "ASCII Pirate",
  "style": "ASCII Skin",
  "category": "Pirates > ASCII Pirate"
 },
 {
  "id": "batch-ascii-door",
  "title": "ASCII Door",
  "style": "ASCII Skin",
  "category": "Portals & Doors > ASCII Door"
 },
 {
  "id": "batch-ascii-portrait",
  "title": "ASCII Portrait",
  "style": "ASCII Skin",
  "category": "Portraits / Memorial > ASCII Portrait"
 },
 {
  "id": "batch-ascii-cross",
  "title": "ASCII Cross",
  "style": "ASCII Skin",
  "category": "Religious / Spiritual / Occult > ASCII Cross"
 },
 {
  "id": "batch-ascii-camera",
  "title": "ASCII Camera",
  "style": "ASCII Skin",
  "category": "Retro & Vintage > ASCII Camera"
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
