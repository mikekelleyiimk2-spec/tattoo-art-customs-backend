// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-26).
// Run via Render shell: node scripts/seed-nightly-20261026.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-blackwork-religious-spiritual-occult",
  "title": "The Moth That Prayed at the Black Altar",
  "style": "Blackwork",
  "category": "Religious / Spiritual / Occult > The Moth That Prayed at the Black Altar"
 },
 {
  "id": "nightly-x-ray-dissection-warriors",
  "title": "The Oath Inside the Warrior's Bones",
  "style": "X-Ray / Dissection",
  "category": "Warriors > The Oath Inside the Warrior's Bones"
 },
 {
  "id": "nightly-dark-anime-skulls-death-gothic",
  "title": "The Reaper Girl With the Cathedral Skull Lantern",
  "style": "Dark Anime",
  "category": "Skulls / Death / Gothic > The Reaper Girl With the Cathedral Skull Lantern"
 },
 {
  "id": "nightly-thermal-forests",
  "title": "The Stag the Forest Hid in Heat",
  "style": "Thermal",
  "category": "Forests > The Stag the Forest Hid in Heat"
 },
 {
  "id": "nightly-blueprint-objects-mechanical",
  "title": "The Typewriter Drawn Before It Was Built",
  "style": "Blueprint",
  "category": "Objects & Mechanical > The Typewriter Drawn Before It Was Built"
 },
 {
  "id": "nightly-pop-culture-circus-carnival",
  "title": "The Ringmaster Who Sold Out the Big Top",
  "style": "Pop Culture",
  "category": "Circus / Carnival > The Ringmaster Who Sold Out the Big Top"
 },
 {
  "id": "nightly-neo-japanese-love-hearts-couples",
  "title": "The Two Cranes That Shared One Heart",
  "style": "Neo-Japanese",
  "category": "Love / Hearts / Couples > The Two Cranes That Shared One Heart"
 },
 {
  "id": "nightly-realism-nautical-ocean",
  "title": "The Tall Ship That Outran the Storm",
  "style": "Realism",
  "category": "Nautical / Ocean > The Tall Ship That Outran the Storm"
 },
 {
  "id": "nightly-black-grey-realism-peace-harmony",
  "title": "The Hands That Let the Dove Go",
  "style": "Black & Grey Realism",
  "category": "Peace & Harmony > The Hands That Let the Dove Go"
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
