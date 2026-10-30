// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-29).
// Run via Render shell: node scripts/seed-nightly-20261029.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-realism-objects-mechanical",
  "title": "The Brass Engine Heart That Still Beats",
  "style": "Realism",
  "category": "Objects & Mechanical > The Brass Engine Heart That Still Beats"
 },
 {
  "id": "nightly-original-insects-bugs",
  "title": "The Lantern Moth That Carried the Moon",
  "style": "Original",
  "category": "Insects & Bugs > The Lantern Moth That Carried the Moon"
 },
 {
  "id": "nightly-dark-anime-vineyards-orchards",
  "title": "The Shadow Sommelier of the Black Grape Rows",
  "style": "Dark Anime",
  "category": "Vineyards & Orchards > The Shadow Sommelier of the Black Grape Rows"
 },
 {
  "id": "nightly-surrealism-gambling-luck",
  "title": "The Dice That Melted Into Four-Leaf Rivers",
  "style": "Surrealism",
  "category": "Gambling / Luck > The Dice That Melted Into Four-Leaf Rivers"
 },
 {
  "id": "nightly-mosaic-floral-botanical",
  "title": "The Rose Built From a Thousand Tiles",
  "style": "Mosaic",
  "category": "Floral & Botanical > The Rose Built From a Thousand Tiles"
 },
 {
  "id": "nightly-pixelated-fitness-gym",
  "title": "The 8-Bit Barbell Champion",
  "style": "Pixelated",
  "category": "Fitness / Gym > The 8-Bit Barbell Champion"
 },
 {
  "id": "nightly-graffiti-graveyards-tombs",
  "title": "The Tombstone That Tagged Itself at Midnight",
  "style": "Graffiti",
  "category": "Graveyards & Tombs > The Tombstone That Tagged Itself at Midnight"
 },
 {
  "id": "nightly-circuit-bloom-vineyards-orchards",
  "title": "The Vine That Grew Circuit Blooms",
  "style": "Circuit Bloom",
  "category": "Vineyards & Orchards > The Vine That Grew Circuit Blooms"
 },
 {
  "id": "nightly-trash-polka-celestial-cosmic",
  "title": "The Comet That Tore the Star Chart in Red and Black",
  "style": "Trash Polka",
  "category": "Celestial / Cosmic > The Comet That Tore the Star Chart in Red and Black"
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
