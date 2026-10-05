// One-time seed: 14 style top-up designs (batch top3).
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "batch-top3-graffiti1",
  "title": "Graffiti Boombox",
  "style": "Graffiti",
  "category": "Music > Graffiti Boombox"
 },
 {
  "id": "batch-top3-ignorant1",
  "title": "Ignorant Skull",
  "style": "Ignorant Style",
  "category": "Skulls / Death / Gothic > Ignorant Skull"
 },
 {
  "id": "batch-top3-ignorant3",
  "title": "Ignorant Pizza",
  "style": "Ignorant Style",
  "category": "Food & Drink > Ignorant Pizza"
 },
 {
  "id": "batch-top3-mosaic1",
  "title": "Mosaic Face",
  "style": "Mosaic",
  "category": "Portraits / Memorial > Mosaic Face"
 },
 {
  "id": "batch-top3-mycelium1",
  "title": "Mycelium Mushrooms",
  "style": "Mycelium",
  "category": "Forests > Mycelium Mushrooms"
 },
 {
  "id": "batch-top3-mycelium2",
  "title": "Mycelium Cave",
  "style": "Mycelium",
  "category": "Caves & Caverns > Mycelium Cave"
 },
 {
  "id": "batch-top3-mycelium3",
  "title": "Mycelium Swamp",
  "style": "Mycelium",
  "category": "Swamps & Bayous > Mycelium Swamp"
 },
 {
  "id": "batch-top3-mycelium4",
  "title": "Mycelium Jungle",
  "style": "Mycelium",
  "category": "Jungle & Tropical > Mycelium Jungle"
 },
 {
  "id": "batch-top3-neo1",
  "title": "Neo-Japanese Oni",
  "style": "Neo-Japanese",
  "category": "Horror > Neo-Japanese Oni"
 },
 {
  "id": "batch-top3-origami1",
  "title": "Origami Crane",
  "style": "Origami",
  "category": "Birds > Origami Crane"
 },
 {
  "id": "batch-top3-origami2",
  "title": "Origami Butterfly",
  "style": "Origami",
  "category": "Insects & Bugs > Origami Butterfly"
 },
 {
  "id": "batch-top3-origami3",
  "title": "Origami Boat",
  "style": "Origami",
  "category": "Nautical / Ocean > Origami Boat"
 },
 {
  "id": "batch-top3-pixel1",
  "title": "Pixelated Alien",
  "style": "Pixelated",
  "category": "Celestial / Cosmic > Pixelated Alien"
 },
 {
  "id": "batch-top3-pop1",
  "title": "Pop Culture Guitar",
  "style": "Pop Culture",
  "category": "Music > Pop Culture Guitar"
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
