// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-19).
// Run via Render shell: node scripts/seed-nightly-20261019.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-trash-polka-birds",
  "title": "Chaos Raven in Red and Black",
  "style": "Trash Polka",
  "category": "Birds > Chaos Raven in Red and Black"
 },
 {
  "id": "nightly-mosaic-birds",
  "title": "Tessellated Hummingbird at Bloom",
  "style": "Mosaic",
  "category": "Birds > Tessellated Hummingbird at Bloom"
 },
 {
  "id": "nightly-dark-anime-masks",
  "title": "Girl With the Fox Mask",
  "style": "Dark Anime",
  "category": "Masks > Girl With the Fox Mask"
 },
 {
  "id": "nightly-smoke-form-mushrooms-discworld",
  "title": "Smoke Over the Floating Mushroom Isle",
  "style": "Smoke Form",
  "category": "Mushrooms / Discworld > Smoke Over the Floating Mushroom Isle"
 },
 {
  "id": "nightly-minimalist-sci-fi-futuristic",
  "title": "One-Line Orbit Ship",
  "style": "Minimalist",
  "category": "Sci-Fi / Futuristic > One-Line Orbit Ship"
 },
 {
  "id": "nightly-blackwork-nautical-ocean",
  "title": "Kraken Grip on the Anchor",
  "style": "Blackwork",
  "category": "Nautical / Ocean > Kraken Grip on the Anchor"
 },
 {
  "id": "nightly-blackwork-glaciers-and-icebergs",
  "title": "Bear on the Black Iceberg",
  "style": "Blackwork",
  "category": "Glaciers & Icebergs > Bear on the Black Iceberg"
 },
 {
  "id": "nightly-graffiti-fire-and-smoke",
  "title": "Wildstyle Fire Storm",
  "style": "Graffiti",
  "category": "Fire & Smoke > Wildstyle Fire Storm"
 },
 {
  "id": "nightly-blueprint-insects-and-bugs",
  "title": "Stag Beetle Wing Schematic",
  "style": "Blueprint",
  "category": "Insects & Bugs > Stag Beetle Wing Schematic"
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
