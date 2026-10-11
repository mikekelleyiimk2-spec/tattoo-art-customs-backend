// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-10).
// Run via Render shell: node scripts/seed-nightly-20261010.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-minimalist-insects",
  "title": "Minimalist Beetle",
  "style": "Minimalist",
  "category": "Insects & Bugs > Minimalist Beetle"
 },
 {
  "id": "nightly-darkanime-mushrooms",
  "title": "Gloomspore Cluster",
  "style": "Dark Anime",
  "category": "Mushrooms / Discworld > Gloomspore Cluster"
 },
 {
  "id": "nightly-stainedshard-peace",
  "title": "Dove of Harmony",
  "style": "Stained Shard",
  "category": "Peace & Harmony > Dove of Harmony"
 },
 {
  "id": "nightly-topographic-religious",
  "title": "Summit of Serenity",
  "style": "Topographic",
  "category": "Religious / Spiritual / Occult > Summit of Serenity"
 },
 {
  "id": "nightly-watercolor-keys",
  "title": "Key and Lock Reverie",
  "style": "Watercolor",
  "category": "Keys & Locks > Key and Lock Reverie"
 },
 {
  "id": "nightly-aurora-horror",
  "title": "Deadwater Aurora",
  "style": "Aurora Veil",
  "category": "Horror > Deadwater Aurora"
 },
 {
  "id": "nightly-xray-sports",
  "title": "Inside the Game",
  "style": "X-Ray / Dissection",
  "category": "Sports > Inside the Game"
 },
 {
  "id": "nightly-frostfractal-music",
  "title": "Frozen Treble",
  "style": "Frost Fractal",
  "category": "Music > Frozen Treble"
 },
 {
  "id": "nightly-ignorant-nautical",
  "title": "Silly Sailor Anchor",
  "style": "Ignorant Style",
  "category": "Nautical / Ocean > Silly Sailor Anchor"
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
