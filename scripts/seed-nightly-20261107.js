// One-time seed: 9 style x category pair-filler designs (nightly 2026-11-07).
// Run via Render shell: node scripts/seed-nightly-20261107.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-showcase-peace-harmony",
  "title": "The Peacock That Opened Its Tail Into a Quiet Garden",
  "style": "Showcase",
  "category": "Peace & Harmony > The Peacock That Opened Its Tail Into a Quiet Garden"
 },
 {
  "id": "nightly-topographic-clowns-jesters",
  "title": "The Jester Whose Smile Followed the Contour Lines",
  "style": "Topographic",
  "category": "Clowns & Jesters > The Jester Whose Smile Followed the Contour Lines"
 },
 {
  "id": "nightly-neo-japanese-coral-reefs",
  "title": "The Koi That Guarded the Coral Shrine",
  "style": "Neo-Japanese",
  "category": "Coral Reefs > The Koi That Guarded the Coral Shrine"
 },
 {
  "id": "nightly-pixelated-birds",
  "title": "The Pixel Sparrow That Escaped the Grid at Dawn",
  "style": "Pixelated",
  "category": "Birds > The Pixel Sparrow That Escaped the Grid at Dawn"
 },
 {
  "id": "nightly-aurora-veil-crystals-gems",
  "title": "The Amethyst That Dreamed in Northern Lights",
  "style": "Aurora Veil",
  "category": "Crystals & Gems > The Amethyst That Dreamed in Northern Lights"
 },
 {
  "id": "nightly-carved-wood-retro-vintage",
  "title": "The Jukebox Carved From One Block of Oak",
  "style": "Carved Wood",
  "category": "Retro & Vintage > The Jukebox Carved From One Block of Oak"
 },
 {
  "id": "nightly-watercolor-graveyards-tombs",
  "title": "The Tombstone Where Wildflowers Learned to Bloom",
  "style": "Watercolor",
  "category": "Graveyards & Tombs > The Tombstone Where Wildflowers Learned to Bloom"
 },
 {
  "id": "nightly-stained-shard-retro-vintage",
  "title": "The Rotary Telephone Pieced From Stained Shards",
  "style": "Stained Shard",
  "category": "Retro & Vintage > The Rotary Telephone Pieced From Stained Shards"
 },
 {
  "id": "nightly-minimalist-castles-fortresses",
  "title": "The Castle Drawn With Seven Lines and a Door",
  "style": "Minimalist",
  "category": "Castles & Fortresses > The Castle Drawn With Seven Lines and a Door"
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
