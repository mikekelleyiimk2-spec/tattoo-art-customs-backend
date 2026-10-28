// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-27).
// Run via Render shell: node scripts/seed-nightly-20261027.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-minimalist-geometric-abstract",
  "title": "The Single Line That Became a Labyrinth",
  "style": "Minimalist",
  "category": "Geometric / Abstract > The Single Line That Became a Labyrinth"
 },
 {
  "id": "nightly-black-grey-realism-books-literature",
  "title": "The Reader Who Fell Asleep Inside the Story",
  "style": "Black & Grey Realism",
  "category": "Books & Literature > The Reader Who Fell Asleep Inside the Story"
 },
 {
  "id": "nightly-origami-anime-manga",
  "title": "The Paper Fox Girl Who Folded Her Own Tail",
  "style": "Origami",
  "category": "Anime / Manga > The Paper Fox Girl Who Folded Her Own Tail"
 },
 {
  "id": "nightly-showcase-pets-pet-memorial",
  "title": "The Old Dog Who Waited by the Golden Gate",
  "style": "Showcase",
  "category": "Pets / Pet Memorial > The Old Dog Who Waited by the Golden Gate"
 },
 {
  "id": "nightly-circuit-bloom-forests",
  "title": "The Oak That Grew Its Own Circuit Board",
  "style": "Circuit Bloom",
  "category": "Forests > The Oak That Grew Its Own Circuit Board"
 },
 {
  "id": "nightly-circuit-bloom-swamps-bayous",
  "title": "The Cypress That Lit the Bayou Circuit",
  "style": "Circuit Bloom",
  "category": "Swamps & Bayous > The Cypress That Lit the Bayou Circuit"
 },
 {
  "id": "nightly-origami-fire-smoke",
  "title": "The Crane That Folded Itself From Embers",
  "style": "Origami",
  "category": "Fire & Smoke > The Crane That Folded Itself From Embers"
 },
 {
  "id": "nightly-x-ray-dissection-nautical-ocean",
  "title": "The X-Ray Octopus That Guarded the Sunken Bell",
  "style": "X-Ray / Dissection",
  "category": "Nautical / Ocean > The X-Ray Octopus That Guarded the Sunken Bell"
 },
 {
  "id": "nightly-circuit-bloom-anime-manga",
  "title": "The Mecha Blossom Girl Wired With Vines",
  "style": "Circuit Bloom",
  "category": "Anime / Manga > The Mecha Blossom Girl Wired With Vines"
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
