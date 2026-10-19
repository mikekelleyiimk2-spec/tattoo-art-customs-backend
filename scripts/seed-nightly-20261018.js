// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-18).
// Run via Render shell: node scripts/seed-nightly-20261018.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-script-lettering-technology-cyber",
  "title": "Stay Connected in Circuit Script",
  "style": "Script / Lettering",
  "category": "Technology & Cyber > Stay Connected in Circuit Script"
 },
 {
  "id": "nightly-postmodern-dreams-sleep",
  "title": "Fragmented Moon Reverie",
  "style": "Postmodern",
  "category": "Dreams & Sleep > Fragmented Moon Reverie"
 },
 {
  "id": "nightly-mycelium-architecture",
  "title": "Fungal Cathedral Spires",
  "style": "Mycelium",
  "category": "Architecture > Fungal Cathedral Spires"
 },
 {
  "id": "nightly-smoke-form-books-literature",
  "title": "Smoke Rising From Open Pages",
  "style": "Smoke Form",
  "category": "Books & Literature > Smoke Rising From Open Pages"
 },
 {
  "id": "nightly-blackwork-insects-bugs",
  "title": "Solid Black Moth and Beetle",
  "style": "Blackwork",
  "category": "Insects & Bugs > Solid Black Moth and Beetle"
 },
 {
  "id": "nightly-black-grey-realism-astronomy-tools",
  "title": "Antique Telescope and Star Chart",
  "style": "Black & Grey Realism",
  "category": "Astronomy Tools > Antique Telescope and Star Chart"
 },
 {
  "id": "nightly-absurdist-objects-mechanical",
  "title": "Teapot Engine on Bicycle Wheels",
  "style": "Absurdist",
  "category": "Objects & Mechanical > Teapot Engine on Bicycle Wheels"
 },
 {
  "id": "nightly-neo-japanese-skeletons-bones",
  "title": "Bone Dragon Among Blossoms",
  "style": "Neo-Japanese",
  "category": "Skeletons & Bones > Bone Dragon Among Blossoms"
 },
 {
  "id": "nightly-graffiti-birds",
  "title": "Wildstyle Spray Paint Songbird",
  "style": "Graffiti",
  "category": "Birds > Wildstyle Spray Paint Songbird"
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
