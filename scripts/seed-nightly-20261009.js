// Nightly batch 2026-10-09: 2 original designs for Travel + Showcase pieces gallery categories.
// Run via Render shell: node scripts/seed-nightly-20261009.js
// All original art — no copyrighted characters, no fan art.
const db = require('../src/db');
const DESIGNS = [
 { id: 'nightly-travel',    title: 'Wanderlust Compass',  style: 'Original', category: 'Travel',            description: 'Original tattoo design "Wanderlust Compass" — a vintage travel composition with an ornate compass rose, soaring paper airplane, and passport-stamp borders in warm sepia and teal. Full color with shading plus matching clean linework included.' },
 { id: 'nightly-showcase',  title: 'Rebirth in Flight',   style: 'Original', category: 'Showcase pieces',   description: 'Original tattoo design "Rebirth in Flight" — a large-scale showpiece phoenix rising with sweeping ornamental plumes, flame motifs and filigree in crimson, gold, teal and violet. Full color with shading plus matching clean linework included.' },
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
