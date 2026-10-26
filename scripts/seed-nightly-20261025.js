// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-25).
// Run via Render shell: node scripts/seed-nightly-20261025.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-postmodern-caves-caverns",
  "title": "The Museum Label That Guarded a Bottomless Cave",
  "style": "Postmodern",
  "category": "Caves & Caverns > The Museum Label That Guarded a Bottomless Cave"
 },
 {
  "id": "nightly-smoke-form-swamps-bayous",
  "title": "The Heron That Rose From Bayou Smoke",
  "style": "Smoke Form",
  "category": "Swamps & Bayous > The Heron That Rose From Bayou Smoke"
 },
 {
  "id": "nightly-ignorant-style-crowns-royalty",
  "title": "The King Who Crowned His Own Cat",
  "style": "Ignorant Style",
  "category": "Crowns & Royalty > The King Who Crowned His Own Cat"
 },
 {
  "id": "nightly-ignorant-style-filler-supporting-elements",
  "title": "The Doodle Parade That Filled Every Gap",
  "style": "Ignorant Style",
  "category": "Filler / Supporting Elements > The Doodle Parade That Filled Every Gap"
 },
 {
  "id": "nightly-mycelium-objects-mechanical",
  "title": "The Clockwork Engine the Mushrooms Rewired",
  "style": "Mycelium",
  "category": "Objects & Mechanical > The Clockwork Engine the Mushrooms Rewired"
 },
 {
  "id": "nightly-topographic-retro-vintage",
  "title": "The Contour Map of the '57 Road Trip",
  "style": "Topographic",
  "category": "Retro & Vintage > The Contour Map of the '57 Road Trip"
 },
 {
  "id": "nightly-neo-japanese-keys-locks",
  "title": "The Koi That Carried the Temple Key",
  "style": "Neo-Japanese",
  "category": "Keys & Locks > The Koi That Carried the Temple Key"
 },
 {
  "id": "nightly-showcase-clowns-jesters",
  "title": "The Jester Who Balanced the Moon on One Finger",
  "style": "Showcase",
  "category": "Clowns & Jesters > The Jester Who Balanced the Moon on One Finger"
 },
 {
  "id": "nightly-stained-shard-love-hearts-couples",
  "title": "The Two Birds Mended From One Broken Heart",
  "style": "Stained Shard",
  "category": "Love / Hearts / Couples > The Two Birds Mended From One Broken Heart"
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
