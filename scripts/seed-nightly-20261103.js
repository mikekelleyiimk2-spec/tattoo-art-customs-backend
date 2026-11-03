// One-time seed: 9 style x category pair-filler designs (nightly 2026-11-03).
// Run via Render shell: node scripts/seed-nightly-20261103.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-black-grey-realism-skeletons-bones",
  "title": "The Ribcage That Kept the Rose",
  "style": "Black & Grey Realism",
  "category": "Skeletons & Bones > The Ribcage That Kept the Rose"
 },
 {
  "id": "nightly-carved-wood-clowns-jesters",
  "title": "The Jester That Was Whittled From One Laugh",
  "style": "Carved Wood",
  "category": "Clowns & Jesters > The Jester That Was Whittled From One Laugh"
 },
 {
  "id": "nightly-circuit-bloom-angels-demons",
  "title": "The Halo That Grew Circuit Vines",
  "style": "Circuit Bloom",
  "category": "Angels & Demons > The Halo That Grew Circuit Vines"
 },
 {
  "id": "nightly-circuit-bloom-arctic-polar",
  "title": "The Bear That Walked Beneath a Circuit Aurora",
  "style": "Circuit Bloom",
  "category": "Arctic & Polar > The Bear That Walked Beneath a Circuit Aurora"
 },
 {
  "id": "nightly-cross-stitch-graveyards-tombs",
  "title": "The Headstone That Was Sewn One Stitch at a Time",
  "style": "Cross-Stitch",
  "category": "Graveyards & Tombs > The Headstone That Was Sewn One Stitch at a Time"
 },
 {
  "id": "nightly-stained-shard-floral-botanical",
  "title": "The Rose That Broke Into Colored Glass",
  "style": "Stained Shard",
  "category": "Floral & Botanical > The Rose That Broke Into Colored Glass"
 },
 {
  "id": "nightly-stained-shard-circus-carnival",
  "title": "The Ferris Wheel That Turned in Stained Glass",
  "style": "Stained Shard",
  "category": "Circus / Carnival > The Ferris Wheel That Turned in Stained Glass"
 },
 {
  "id": "nightly-blueprint-sports",
  "title": "The Stadium That Was Drafted Before the First Whistle",
  "style": "Blueprint",
  "category": "Sports > The Stadium That Was Drafted Before the First Whistle"
 },
 {
  "id": "nightly-bioluminescent-churches-temples",
  "title": "The Cathedral That Glowed From the Deep",
  "style": "Bioluminescent",
  "category": "Churches & Temples > The Cathedral That Glowed From the Deep"
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
