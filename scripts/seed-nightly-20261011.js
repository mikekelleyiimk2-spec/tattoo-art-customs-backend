// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-11).
// Run via Render shell: node scripts/seed-nightly-20261011.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-pixelated-mushrooms",
  "title": "Pixelcap Grove",
  "style": "Pixelated",
  "category": "Mushrooms / Discworld > Pixelcap Grove"
 },
 {
  "id": "nightly-minimalist-food",
  "title": "Single Line Ramen",
  "style": "Minimalist",
  "category": "Food & Drink > Single Line Ramen"
 },
 {
  "id": "nightly-pixelated-showcase",
  "title": "Pixel Dragon Coil",
  "style": "Pixelated",
  "category": "Showcase pieces > Pixel Dragon Coil"
 },
 {
  "id": "nightly-minimalist-architecture",
  "title": "Skyline Contour",
  "style": "Minimalist",
  "category": "Architecture > Skyline Contour"
 },
 {
  "id": "nightly-geometric-masks",
  "title": "Polygon Masquerade",
  "style": "Geometric",
  "category": "Masks > Polygon Masquerade"
 },
 {
  "id": "nightly-bioluminescent-arctic",
  "title": "Glowtide Bear",
  "style": "Bioluminescent",
  "category": "Arctic & Polar > Glowtide Bear"
 },
 {
  "id": "nightly-aurora-food",
  "title": "Aurora Cocktail",
  "style": "Aurora Veil",
  "category": "Food & Drink > Aurora Cocktail"
 },
 {
  "id": "nightly-minimalist-treehouse",
  "title": "Minimalist Treehouse",
  "style": "Minimalist",
  "category": "Treehouses & Cabins > Minimalist Treehouse"
 },
 {
  "id": "nightly-pixelated-books",
  "title": "Pixel Library",
  "style": "Pixelated",
  "category": "Books & Literature > Pixel Library"
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
