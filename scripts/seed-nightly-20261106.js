// One-time seed: 9 style x category pair-filler designs (nightly 2026-11-06).
// Run via Render shell: node scripts/seed-nightly-20261106.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-thermal-peace-harmony",
  "title": "The Dove That Glowed in Heat Instead of Light",
  "style": "Thermal",
  "category": "Peace & Harmony > The Dove That Glowed in Heat Instead of Light"
 },
 {
  "id": "nightly-aurora-veil-wings",
  "title": "The Wings That Caught the Northern Sky",
  "style": "Aurora Veil",
  "category": "Wings > The Wings That Caught the Northern Sky"
 },
 {
  "id": "nightly-black-grey-realism-travel",
  "title": "The Suitcase That Remembered Every Road",
  "style": "Black & Grey Realism",
  "category": "Travel > The Suitcase That Remembered Every Road"
 },
 {
  "id": "nightly-carved-wood-angels-demons",
  "title": "The Angel and Demon That Shared One Carved Halo",
  "style": "Carved Wood",
  "category": "Angels & Demons > The Angel and Demon That Shared One Carved Halo"
 },
 {
  "id": "nightly-frost-fractal-pirates",
  "title": "The Pirate Ship That Froze Into Fractals",
  "style": "Frost Fractal",
  "category": "Pirates > The Pirate Ship That Froze Into Fractals"
 },
 {
  "id": "nightly-absurdist-birds",
  "title": "The Bird That Wore a Teapot for a Crown",
  "style": "Absurdist",
  "category": "Birds > The Bird That Wore a Teapot for a Crown"
 },
 {
  "id": "nightly-surrealism-chess-games",
  "title": "The Chess King That Melted Into a Staircase",
  "style": "Surrealism",
  "category": "Chess & Games > The Chess King That Melted Into a Staircase"
 },
 {
  "id": "nightly-minimalist-showcase-pieces",
  "title": "The Single Line That Held the Whole Mountain",
  "style": "Minimalist",
  "category": "Showcase pieces > The Single Line That Held the Whole Mountain"
 },
 {
  "id": "nightly-origami-forests",
  "title": "The Forest That Folded Itself Into Paper",
  "style": "Origami",
  "category": "Forests > The Forest That Folded Itself Into Paper"
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
