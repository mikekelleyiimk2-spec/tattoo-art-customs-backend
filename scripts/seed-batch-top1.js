// One-time seed: 15 style top-up designs (batch top1).
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "batch-top1-absurdist",
  "title": "Absurdist Burger",
  "style": "Absurdist",
  "category": "Food & Drink > Absurdist Burger"
 },
 {
  "id": "batch-top1-aurora1",
  "title": "Aurora Galaxy",
  "style": "Aurora Veil",
  "category": "Celestial / Cosmic > Aurora Galaxy"
 },
 {
  "id": "batch-top1-aurora2",
  "title": "Aurora Ocean",
  "style": "Aurora Veil",
  "category": "Nautical / Ocean > Aurora Ocean"
 },
 {
  "id": "batch-top1-aurora3",
  "title": "Aurora Mountain",
  "style": "Aurora Veil",
  "category": "Nature / Scene Concepts > Aurora Mountain"
 },
 {
  "id": "batch-top1-aurora4",
  "title": "Aurora Forest",
  "style": "Aurora Veil",
  "category": "Forests > Aurora Forest"
 },
 {
  "id": "batch-top1-bio1",
  "title": "Bioluminescent Jellyfish",
  "style": "Bioluminescent",
  "category": "Deep Sea > Bioluminescent Jellyfish"
 },
 {
  "id": "batch-top1-bio2",
  "title": "Bioluminescent Coral",
  "style": "Bioluminescent",
  "category": "Coral Reefs > Bioluminescent Coral"
 },
 {
  "id": "batch-top1-bio3",
  "title": "Bioluminescent Firefly",
  "style": "Bioluminescent",
  "category": "Jungle & Tropical > Bioluminescent Firefly"
 },
 {
  "id": "batch-top1-bio4",
  "title": "Bioluminescent Cave",
  "style": "Bioluminescent",
  "category": "Caves & Caverns > Bioluminescent Cave"
 },
 {
  "id": "batch-top1-bg1",
  "title": "B&G Portrait",
  "style": "Black & Grey Realism",
  "category": "Portraits / Memorial > B&G Portrait"
 },
 {
  "id": "batch-top1-bg2",
  "title": "B&G Lion",
  "style": "Black & Grey Realism",
  "category": "Animals & Wildlife > B&G Lion"
 },
 {
  "id": "batch-top1-bg3",
  "title": "B&G Skull",
  "style": "Black & Grey Realism",
  "category": "Skulls / Death / Gothic > B&G Skull"
 },
 {
  "id": "batch-top1-bg4",
  "title": "B&G Praying Hands",
  "style": "Black & Grey Realism",
  "category": "Religious / Spiritual / Occult > B&G Praying Hands"
 },
 {
  "id": "batch-top1-blue1",
  "title": "Blueprint Building",
  "style": "Blueprint",
  "category": "Architecture > Blueprint Building"
 },
 {
  "id": "batch-top1-blue2",
  "title": "Blueprint Bridge",
  "style": "Blueprint",
  "category": "Bridges > Blueprint Bridge"
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
