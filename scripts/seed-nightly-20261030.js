// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-30).
// Run via Render shell: node scripts/seed-nightly-20261030.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-script-lettering-crowns-royalty",
  "title": "The Crown That Learned to Write Its Own Name",
  "style": "Script / Lettering",
  "category": "Crowns & Royalty > The Crown That Learned to Write Its Own Name"
 },
 {
  "id": "nightly-dark-anime-objects-mechanical",
  "title": "The Gear-Eyed Sentinel of the Midnight Workshop",
  "style": "Dark Anime",
  "category": "Objects & Mechanical > The Gear-Eyed Sentinel of the Midnight Workshop"
 },
 {
  "id": "nightly-script-lettering-vehicles",
  "title": "The Lowrider Script That Rolled Through Neon Streets",
  "style": "Script / Lettering",
  "category": "Vehicles > The Lowrider Script That Rolled Through Neon Streets"
 },
 {
  "id": "nightly-minimalist-retro-vintage",
  "title": "The Single-Line Sunset Radio",
  "style": "Minimalist",
  "category": "Retro & Vintage > The Single-Line Sunset Radio"
 },
 {
  "id": "nightly-origami-churches-temples",
  "title": "The Paper Chapel Folded From One Prayer",
  "style": "Origami",
  "category": "Churches & Temples > The Paper Chapel Folded From One Prayer"
 },
 {
  "id": "nightly-aurora-veil-filler-supporting-elements",
  "title": "The Aurora Veil Ribbon That Fills the Silence",
  "style": "Aurora Veil",
  "category": "Filler / Supporting Elements > The Aurora Veil Ribbon That Fills the Silence"
 },
 {
  "id": "nightly-trash-polka-tattoo-styles",
  "title": "The Needle Manifesto Torn in Red and Black",
  "style": "Trash Polka",
  "category": "Tattoo Styles > The Needle Manifesto Torn in Red and Black"
 },
 {
  "id": "nightly-postmodern-zodiac-astrology",
  "title": "The Zodiac Wheel Glitched Into Tomorrow",
  "style": "Postmodern",
  "category": "Zodiac / Astrology > The Zodiac Wheel Glitched Into Tomorrow"
 },
 {
  "id": "nightly-smoke-form-dreams-sleep",
  "title": "The Dream That Exhaled Smoke Stars",
  "style": "Smoke Form",
  "category": "Dreams & Sleep > The Dream That Exhaled Smoke Stars"
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
