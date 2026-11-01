// One-time seed: 9 style x category pair-filler designs (nightly 2026-11-01).
// Run via Render shell: node scripts/seed-nightly-20261101.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-watercolor-candy-sweets",
  "title": "The Lollipop That Melted Into a Galaxy",
  "style": "Watercolor",
  "category": "Candy / Sweets > The Lollipop That Melted Into a Galaxy"
 },
 {
  "id": "nightly-black-grey-realism-technology-cyber",
  "title": "The Circuit Heart That Learned to Beat",
  "style": "Black & Grey Realism",
  "category": "Technology & Cyber > The Circuit Heart That Learned to Beat"
 },
 {
  "id": "nightly-blackwork-zodiac-astrology",
  "title": "The Constellation That Drew Its Own Fate",
  "style": "Blackwork",
  "category": "Zodiac / Astrology > The Constellation That Drew Its Own Fate"
 },
 {
  "id": "nightly-neo-japanese-hearts-anatomy",
  "title": "The Heart That Bloomed Beneath the Waves",
  "style": "Neo-Japanese",
  "category": "Hearts & Anatomy > The Heart That Bloomed Beneath the Waves"
 },
 {
  "id": "nightly-bioluminescent-glaciers-icebergs",
  "title": "The Iceberg That Glowed From Within",
  "style": "Bioluminescent",
  "category": "Glaciers & Icebergs > The Iceberg That Glowed From Within"
 },
 {
  "id": "nightly-traditional-crystals-gems",
  "title": "The Ruby That Held the Anchor",
  "style": "Traditional",
  "category": "Crystals & Gems > The Ruby That Held the Anchor"
 },
 {
  "id": "nightly-aurora-veil-pets-pet-memorial",
  "title": "The Dog That Slept Under Northern Lights",
  "style": "Aurora Veil",
  "category": "Pets / Pet Memorial > The Dog That Slept Under Northern Lights"
 },
 {
  "id": "nightly-bioluminescent-ancient-civilizations",
  "title": "The Pyramid That Lit the Deep",
  "style": "Bioluminescent",
  "category": "Ancient Civilizations > The Pyramid That Lit the Deep"
 },
 {
  "id": "nightly-thermal-crystals-gems",
  "title": "The Emerald That Changed With the Heat",
  "style": "Thermal",
  "category": "Crystals & Gems > The Emerald That Changed With the Heat"
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
