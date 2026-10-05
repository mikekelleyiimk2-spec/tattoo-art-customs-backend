// One-time seed: 15 ASCII Skin pair-filler designs (batch 4).
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "batch-ascii-fortress",
  "title": "ASCII Fortress",
  "style": "ASCII Skin",
  "category": "Castles & Fortresses > ASCII Fortress"
 },
 {
  "id": "batch-ascii-cave",
  "title": "ASCII Cave",
  "style": "ASCII Skin",
  "category": "Caves & Caverns > ASCII Cave"
 },
 {
  "id": "batch-ascii-galaxy",
  "title": "ASCII Galaxy",
  "style": "ASCII Skin",
  "category": "Celestial / Cosmic > ASCII Galaxy"
 },
 {
  "id": "batch-ascii-wizard",
  "title": "ASCII Wizard",
  "style": "ASCII Skin",
  "category": "Characters / People > ASCII Wizard"
 },
 {
  "id": "batch-ascii-knight",
  "title": "ASCII Knight",
  "style": "ASCII Skin",
  "category": "Chess & Games > ASCII Knight"
 },
 {
  "id": "batch-ascii-cathedral",
  "title": "ASCII Cathedral",
  "style": "ASCII Skin",
  "category": "Churches & Temples > ASCII Cathedral"
 },
 {
  "id": "batch-ascii-circus",
  "title": "ASCII Circus",
  "style": "ASCII Skin",
  "category": "Circus / Carnival > ASCII Circus"
 },
 {
  "id": "batch-ascii-jester",
  "title": "ASCII Jester",
  "style": "ASCII Skin",
  "category": "Clowns & Jesters > ASCII Jester"
 },
 {
  "id": "batch-ascii-reef",
  "title": "ASCII Reef",
  "style": "ASCII Skin",
  "category": "Coral Reefs > ASCII Reef"
 },
 {
  "id": "batch-ascii-crown",
  "title": "ASCII Crown",
  "style": "ASCII Skin",
  "category": "Crowns & Royalty > ASCII Crown"
 },
 {
  "id": "batch-ascii-diamond",
  "title": "ASCII Diamond",
  "style": "ASCII Skin",
  "category": "Crystals & Gems > ASCII Diamond"
 },
 {
  "id": "batch-ascii-tribalmask",
  "title": "ASCII Tribal Mask",
  "style": "ASCII Skin",
  "category": "Cultural Heritage > ASCII Tribal Mask"
 },
 {
  "id": "batch-ascii-anglerfish",
  "title": "ASCII Anglerfish",
  "style": "ASCII Skin",
  "category": "Deep Sea > ASCII Anglerfish"
 },
 {
  "id": "batch-ascii-cactus",
  "title": "ASCII Cactus",
  "style": "ASCII Skin",
  "category": "Desert > ASCII Cactus"
 },
 {
  "id": "batch-ascii-trexs",
  "title": "ASCII T-Rex Skull",
  "style": "ASCII Skin",
  "category": "Dinosaurs / Prehistoric > ASCII T-Rex Skull"
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
