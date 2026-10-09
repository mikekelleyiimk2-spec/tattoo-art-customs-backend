// Nightly batch 2026-10-08: 9 original designs for 9 empty gallery categories.
// Run via Render shell: node scripts/seed-nightly-20261008.js
// All original art — no copyrighted characters, no fan art.
const db = require('../src/db');
const DESIGNS = [
 { id: 'nightly-time-clocks',   title: 'Clockwork Heart',   style: 'Original', category: 'Time / Clocks',        description: 'Original tattoo design "Clockwork Heart" — a heart-shaped vintage pocket watch with exposed gears. Full color with shading plus matching clean linework included.' },
 { id: 'nightly-sci-fi',        title: 'Neon Drifter',       style: 'Original', category: 'Sci-Fi / Futuristic',  description: 'Original tattoo design "Neon Drifter" — a futuristic astronaut floating among the stars. Full color with shading plus matching clean linework included.' },
 { id: 'nightly-surreal',       title: 'The Watcher',       style: 'Original', category: 'Surreal / Bizarre',    description: 'Original tattoo design "The Watcher" — a giant eye over a surreal floating dreamscape. Full color with shading plus matching clean linework included.' },
 { id: 'nightly-zodiac',        title: 'Celestial Wheel',   style: 'Original', category: 'Zodiac / Astrology',   description: 'Original tattoo design "Celestial Wheel" — an ornate zodiac wheel with constellations, sun and moon. Full color with shading plus matching clean linework included.' },
 { id: 'nightly-tattoo-styles', title: 'Heritage Flash',    style: 'Original', category: 'Tattoo Styles',        description: 'Original tattoo design "Heritage Flash" — classic American traditional rose, dagger and swallow composition. Full color with shading plus matching clean linework included.' },
 { id: 'nightly-western',       title: 'Desert Outlaw',     style: 'Original', category: 'Western',              description: 'Original tattoo design "Desert Outlaw" — a cowboy skull with desert frontier scene. Full color with shading plus matching clean linework included.' },
 { id: 'nightly-vehicles',      title: 'Iron Stallion',     style: 'Original', category: 'Vehicles',             description: 'Original tattoo design "Iron Stallion" — a vintage chopper motorcycle with flame details. Full color with shading plus matching clean linework included.' },
 { id: 'nightly-wings',         title: 'Ascension',         style: 'Original', category: 'Wings',                description: 'Original tattoo design "Ascension" — majestic angel wings spread wide with detailed feathers. Full color with shading plus matching clean linework included.' },
 { id: 'nightly-steampunk',     title: 'Brass Aviator',     style: 'Original', category: 'Steampunk',            description: 'Original tattoo design "Brass Aviator" — a Victorian steampunk airship with gears and brass fittings. Full color with shading plus matching clean linework included.' },
];
(async () => {
  await db.init();
  const now = Date.now();
  for (const d of DESIGNS) {
    await db.upsert('designs', 'id', {
      id: d.id, title: d.title,
      description: d.description,
      categories: JSON.stringify([d.category]),
      color_path: `designs/color/${d.id}.jpg`,
      linework_path: `designs/linework-clean/${d.id}.jpg`,
      linework_wm_path: `/img/designs/${d.id}.jpg`,
      style: d.style, price_cents: 7500, status: 'approved', listing_scope: 'gallery',
      created_at: now, sale_count: 0,
    });
    console.log(`upserted: ${d.id}`);
  }
  console.log('DONE');
  await db.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
