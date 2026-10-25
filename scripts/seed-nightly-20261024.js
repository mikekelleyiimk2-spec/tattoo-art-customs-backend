// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-24).
// Run via Render shell: node scripts/seed-nightly-20261024.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-topographic-love-hearts-couples",
  "title": "The Contour Lines That Met at One Heart",
  "style": "Topographic",
  "category": "Love / Hearts / Couples > The Contour Lines That Met at One Heart"
 },
 {
  "id": "nightly-minimalist-chess-and-games",
  "title": "Two Moves From Forever",
  "style": "Minimalist",
  "category": "Chess & Games > Two Moves From Forever"
 },
 {
  "id": "nightly-circuit-bloom-cartoon-pop-culture",
  "title": "The Little Robot Who Bloomed Wires Into Flowers",
  "style": "Circuit Bloom",
  "category": "Cartoon / Pop Culture > The Little Robot Who Bloomed Wires Into Flowers"
 },
 {
  "id": "nightly-bioluminescent-gaming-and-pixel-art",
  "title": "The Pixel Knight Who Glowed in the Deep",
  "style": "Bioluminescent",
  "category": "Gaming & Pixel Art > The Pixel Knight Who Glowed in the Deep"
 },
 {
  "id": "nightly-pop-culture-masks",
  "title": "The Mask That Smiled Back",
  "style": "Pop Culture",
  "category": "Masks > The Mask That Smiled Back"
 },
 {
  "id": "nightly-cross-stitch-cultural-heritage",
  "title": "The Sampler That Stitched a Village Home",
  "style": "Cross-Stitch",
  "category": "Cultural Heritage > The Sampler That Stitched a Village Home"
 },
 {
  "id": "nightly-traditional-hands-and-gestures",
  "title": "The Pinky Promise the Swallow Carried",
  "style": "Traditional",
  "category": "Hands & Gestures > The Pinky Promise the Swallow Carried"
 },
 {
  "id": "nightly-black-and-grey-realism-time-clocks",
  "title": "The Pocket Watch That Counted a Lifetime",
  "style": "Black & Grey Realism",
  "category": "Time / Clocks > The Pocket Watch That Counted a Lifetime"
 },
 {
  "id": "nightly-geometric-feathers",
  "title": "The Feather Built From Golden Angles",
  "style": "Geometric",
  "category": "Feathers > The Feather Built From Golden Angles"
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
