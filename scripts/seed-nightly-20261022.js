// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-22).
// Run via Render shell: node scripts/seed-nightly-20261022.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-black-grey-realism-caves-caverns",
  "title": "The Lantern Bearer in the Stone Cathedral",
  "style": "Black & Grey Realism",
  "category": "Caves & Caverns > The Lantern Bearer in the Stone Cathedral"
 },
 {
  "id": "nightly-pop-culture-portals-doors",
  "title": "The Door at the End of the Arcade",
  "style": "Pop Culture",
  "category": "Portals & Doors > The Door at the End of the Arcade"
 },
 {
  "id": "nightly-x-ray-dissection-chess-games",
  "title": "Anatomy of the Queen's Gambit",
  "style": "X-Ray / Dissection",
  "category": "Chess & Games > Anatomy of the Queen's Gambit"
 },
 {
  "id": "nightly-absurdist-animals-wildlife",
  "title": "The Elephant Who Balanced the Moon on His Trunk",
  "style": "Absurdist",
  "category": "Animals & Wildlife > The Elephant Who Balanced the Moon on His Trunk"
 },
 {
  "id": "nightly-mosaic-lighthouses-beacons",
  "title": "The Lighthouse Pieced From a Thousand Storms",
  "style": "Mosaic",
  "category": "Lighthouses & Beacons > The Lighthouse Pieced From a Thousand Storms"
 },
 {
  "id": "nightly-origami-chess-games",
  "title": "The Paper Knight's Last Fold",
  "style": "Origami",
  "category": "Chess & Games > The Paper Knight's Last Fold"
 },
 {
  "id": "nightly-origami-bridges",
  "title": "The Bridge Folded From a Single Sheet",
  "style": "Origami",
  "category": "Bridges > The Bridge Folded From a Single Sheet"
 },
 {
  "id": "nightly-traditional-fairy-tale-storybook",
  "title": "The Wolf Who Guarded the Storybook Door",
  "style": "Traditional",
  "category": "Fairy Tale & Storybook > The Wolf Who Guarded the Storybook Door"
 },
 {
  "id": "nightly-smoke-form-floral-botanical",
  "title": "The Rose That Bloomed From Smoke",
  "style": "Smoke Form",
  "category": "Floral & Botanical > The Rose That Bloomed From Smoke"
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
