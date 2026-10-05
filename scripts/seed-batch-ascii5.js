// One-time seed: 15 ASCII Skin pair-filler designs (batch 5).
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "batch-ascii-teddy",
  "title": "ASCII Teddy",
  "style": "ASCII Skin",
  "category": "Dolls & Toys > ASCII Teddy"
 },
 {
  "id": "batch-ascii-moon",
  "title": "ASCII Moon",
  "style": "ASCII Skin",
  "category": "Dreams & Sleep > ASCII Moon"
 },
 {
  "id": "batch-ascii-eye",
  "title": "ASCII Eye",
  "style": "ASCII Skin",
  "category": "Eyes > ASCII Eye"
 },
 {
  "id": "batch-ascii-fairy",
  "title": "ASCII Fairy",
  "style": "ASCII Skin",
  "category": "Fairy Tale & Storybook > ASCII Fairy"
 },
 {
  "id": "batch-ascii-barn",
  "title": "ASCII Barn",
  "style": "ASCII Skin",
  "category": "Farmland & Barns > ASCII Barn"
 },
 {
  "id": "batch-ascii-feather",
  "title": "ASCII Feather",
  "style": "ASCII Skin",
  "category": "Feathers > ASCII Feather"
 },
 {
  "id": "batch-ascii-stars",
  "title": "ASCII Stars",
  "style": "ASCII Skin",
  "category": "Filler / Supporting Elements > ASCII Stars"
 },
 {
  "id": "batch-ascii-flame",
  "title": "ASCII Flame",
  "style": "ASCII Skin",
  "category": "Fire & Smoke > ASCII Flame"
 },
 {
  "id": "batch-ascii-dumbbell",
  "title": "ASCII Dumbbell",
  "style": "ASCII Skin",
  "category": "Fitness / Gym > ASCII Dumbbell"
 },
 {
  "id": "batch-ascii-rose",
  "title": "ASCII Rose",
  "style": "ASCII Skin",
  "category": "Floral & Botanical > ASCII Rose"
 },
 {
  "id": "batch-ascii-burger",
  "title": "ASCII Burger",
  "style": "ASCII Skin",
  "category": "Food & Drink > ASCII Burger"
 },
 {
  "id": "batch-ascii-pines",
  "title": "ASCII Pines",
  "style": "ASCII Skin",
  "category": "Forests > ASCII Pines"
 },
 {
  "id": "batch-ascii-dice",
  "title": "ASCII Dice",
  "style": "ASCII Skin",
  "category": "Gambling / Luck > ASCII Dice"
 },
 {
  "id": "batch-ascii-controller",
  "title": "ASCII Controller",
  "style": "ASCII Skin",
  "category": "Gaming & Pixel Art > ASCII Controller"
 },
 {
  "id": "batch-ascii-maze",
  "title": "ASCII Maze",
  "style": "ASCII Skin",
  "category": "Gardens & Mazes > ASCII Maze"
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
