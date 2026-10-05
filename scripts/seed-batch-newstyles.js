// One-time seed: insert 40 new-style designs (Circuit Bloom, ASCII Skin,
// Kintsugi, Topographic, Smoke Form) into the production DB.
// Run via Render shell: node scripts/seed-batch-newstyles.js
// Safe to re-run (uses upsert on id).
const db = require('../src/db');

const DESIGNS = [
  // Circuit Bloom (8)
  { id: 'batch-circuitbloom-rose', title: 'Circuit Rose', style: 'Circuit Bloom', cat: 'Floral & Botanical > Circuit Rose' },
  { id: 'batch-circuitbloom-butterfly', title: 'Circuit Butterfly', style: 'Circuit Bloom', cat: 'Insects & Bugs > Circuit Butterfly' },
  { id: 'batch-circuitbloom-owl', title: 'Circuit Owl', style: 'Circuit Bloom', cat: 'Birds > Circuit Owl' },
  { id: 'batch-circuitbloom-koi', title: 'Circuit Koi', style: 'Circuit Bloom', cat: 'Animals & Wildlife > Circuit Koi' },
  { id: 'batch-circuitbloom-lotus', title: 'Circuit Lotus', style: 'Circuit Bloom', cat: 'Floral & Botanical > Circuit Lotus' },
  { id: 'batch-circuitbloom-dragonfly', title: 'Circuit Dragonfly', style: 'Circuit Bloom', cat: 'Insects & Bugs > Circuit Dragonfly' },
  { id: 'batch-circuitbloom-hummingbird', title: 'Circuit Hummingbird', style: 'Circuit Bloom', cat: 'Birds > Circuit Hummingbird' },
  { id: 'batch-circuitbloom-orchid', title: 'Circuit Orchid', style: 'Circuit Bloom', cat: 'Floral & Botanical > Circuit Orchid' },
  // ASCII Skin (8)
  { id: 'batch-ascii-skull', title: 'ASCII Skull', style: 'ASCII Skin', cat: 'Skulls / Death / Gothic > ASCII Skull' },
  { id: 'batch-ascii-eye', title: 'ASCII Eye', style: 'ASCII Skin', cat: 'Surreal / Bizarre > ASCII Eye' },
  { id: 'batch-ascii-cat', title: 'ASCII Cat', style: 'ASCII Skin', cat: 'Animals & Wildlife > ASCII Cat' },
  { id: 'batch-ascii-mountain', title: 'ASCII Mountain', style: 'ASCII Skin', cat: 'Nature / Scene Concepts > ASCII Mountain' },
  { id: 'batch-ascii-wave', title: 'ASCII Wave', style: 'ASCII Skin', cat: 'Nautical / Ocean > ASCII Wave' },
  { id: 'batch-ascii-raven', title: 'ASCII Raven', style: 'ASCII Skin', cat: 'Birds > ASCII Raven' },
  { id: 'batch-ascii-lighthouse', title: 'ASCII Lighthouse', style: 'ASCII Skin', cat: 'Architecture > ASCII Lighthouse' },
  { id: 'batch-ascii-mushroom', title: 'ASCII Mushroom', style: 'ASCII Skin', cat: 'Mushrooms / Discworld > ASCII Mushroom' },
  // Kintsugi (8)
  { id: 'batch-kintsugi-vase', title: 'Kintsugi Vase', style: 'Kintsugi', cat: 'Objects & Mechanical > Kintsugi Vase' },
  { id: 'batch-kintsugi-mask', title: 'Kintsugi Samurai Mask', style: 'Kintsugi', cat: 'Cultural Heritage > Kintsugi Mask' },
  { id: 'batch-kintsugi-heart', title: 'Kintsugi Heart', style: 'Kintsugi', cat: 'Love / Hearts / Couples > Kintsugi Heart' },
  { id: 'batch-kintsugi-teacup', title: 'Kintsugi Teacup', style: 'Kintsugi', cat: 'Cultural Heritage > Kintsugi Teacup' },
  { id: 'batch-kintsugi-moon', title: 'Kintsugi Moon', style: 'Kintsugi', cat: 'Celestial / Cosmic > Kintsugi Moon' },
  { id: 'batch-kintsugi-turtle', title: 'Kintsugi Sea Turtle', style: 'Kintsugi', cat: 'Animals & Wildlife > Kintsugi Turtle' },
  { id: 'batch-kintsugi-geisha', title: 'Kintsugi Geisha', style: 'Kintsugi', cat: 'Cultural Heritage > Kintsugi Geisha' },
  { id: 'batch-kintsugi-temple', title: 'Kintsugi Temple', style: 'Kintsugi', cat: 'Architecture > Kintsugi Temple' },
  // Topographic (8)
  { id: 'batch-topo-bear', title: 'Topo Bear', style: 'Topographic', cat: 'Animals & Wildlife > Topo Bear' },
  { id: 'batch-topo-island', title: 'Topo Island', style: 'Topographic', cat: 'Nature / Scene Concepts > Topo Island' },
  { id: 'batch-topo-volcano', title: 'Topo Volcano', style: 'Topographic', cat: 'Nature / Scene Concepts > Topo Volcano' },
  { id: 'batch-topo-pine', title: 'Topo Pine', style: 'Topographic', cat: 'Nature / Scene Concepts > Topo Pine' },
  { id: 'batch-topo-deer', title: 'Topo Deer', style: 'Topographic', cat: 'Animals & Wildlife > Topo Deer' },
  { id: 'batch-topo-waterfall', title: 'Topo Waterfall', style: 'Topographic', cat: 'Nature / Scene Concepts > Topo Waterfall' },
  { id: 'batch-topo-fox', title: 'Topo Fox', style: 'Topographic', cat: 'Animals & Wildlife > Topo Fox' },
  { id: 'batch-topo-compass', title: 'Topo Compass', style: 'Topographic', cat: 'Objects & Mechanical > Topo Compass' },
  // Smoke Form (8)
  { id: 'batch-smoke-dragon', title: 'Smoke Dragon', style: 'Smoke Form', cat: 'Mythology & Fantasy > Smoke Dragon' },
  { id: 'batch-smoke-phoenix', title: 'Smoke Phoenix', style: 'Smoke Form', cat: 'Mythology & Fantasy > Smoke Phoenix' },
  { id: 'batch-smoke-wolf', title: 'Smoke Wolf', style: 'Smoke Form', cat: 'Animals & Wildlife > Smoke Wolf' },
  { id: 'batch-smoke-horse', title: 'Smoke Horse', style: 'Smoke Form', cat: 'Animals & Wildlife > Smoke Horse' },
  { id: 'batch-smoke-lion', title: 'Smoke Lion', style: 'Smoke Form', cat: 'Animals & Wildlife > Smoke Lion' },
  { id: 'batch-smoke-wings', title: 'Smoke Angel Wings', style: 'Smoke Form', cat: 'Wings > Smoke Angel Wings' },
  { id: 'batch-smoke-scorpion', title: 'Smoke Scorpion', style: 'Smoke Form', cat: 'Insects & Bugs > Smoke Scorpion' },
  { id: 'batch-smoke-tiger', title: 'Smoke Tiger', style: 'Smoke Form', cat: 'Animals & Wildlife > Smoke Tiger' },
];

(async () => {
  await db.init();
  const now = Date.now();
  for (const d of DESIGNS) {
    const file = `${d.id}.jpg`;
    await db.upsert('designs', 'id', {
      id: d.id,
      title: d.title,
      description: `Original ${d.style} tattoo design "${d.title}" — a never-before-seen style. Full color with shading and background plus matching clean linework included.`,
      categories: JSON.stringify([d.cat]),
      color_path: `/img/designs/${file}`,
      linework_path: `/img/designs/${file}`,
      linework_wm_path: `/img/designs/${file}`,
      style: d.style,
      price_cents: 7500,
      status: 'approved',
      listing_scope: 'gallery',
      created_at: now,
      sale_count: 0,
    });
    console.log(`upserted: ${d.id}`);
  }
  const rows = await db.all(`SELECT id FROM designs WHERE id LIKE 'batch-circuitbloom-%' OR id LIKE 'batch-ascii-%' OR id LIKE 'batch-kintsugi-%' OR id LIKE 'batch-topo-%' OR id LIKE 'batch-smoke-%'`);
  console.log(`DONE: ${rows.length}/${DESIGNS.length} new-style designs in DB`);
  await db.close();
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
