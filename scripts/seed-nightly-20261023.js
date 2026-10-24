// One-time seed: 9 style x category pair-filler designs (nightly 2026-10-23).
// Run via Render shell: node scripts/seed-nightly-20261023.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-origami-music",
  "title": "The Paper Violin That Folded Its Own Song",
  "style": "Origami",
  "category": "Music > The Paper Violin That Folded Its Own Song"
 },
 {
  "id": "nightly-blueprint-coral-reefs",
  "title": "Blueprint of the Reef That Grew Its Own Cathedral",
  "style": "Blueprint",
  "category": "Coral Reefs > Blueprint of the Reef That Grew Its Own Cathedral"
 },
 {
  "id": "nightly-mycelium-pets-pet-memorial",
  "title": "The Dog Who Rests Where the Mycelium Remembers",
  "style": "Mycelium",
  "category": "Pets / Pet Memorial > The Dog Who Rests Where the Mycelium Remembers"
 },
 {
  "id": "nightly-pixelated-astronomy-tools",
  "title": "The Pixel Telescope That Found a Glitching Star",
  "style": "Pixelated",
  "category": "Astronomy Tools > The Pixel Telescope That Found a Glitching Star"
 },
 {
  "id": "nightly-traditional-vehicles",
  "title": "The Hot Rod That Carried the Eagle Banner",
  "style": "Traditional",
  "category": "Vehicles > The Hot Rod That Carried the Eagle Banner"
 },
 {
  "id": "nightly-ignorant-style-jungle-and-tropical",
  "title": "The Monkey Who Traded a Coconut for a Crown",
  "style": "Ignorant Style",
  "category": "Jungle & Tropical > The Monkey Who Traded a Coconut for a Crown"
 },
 {
  "id": "nightly-showcase-gambling-luck",
  "title": "The Slot Machine That Always Paid in Gold",
  "style": "Showcase",
  "category": "Gambling / Luck > The Slot Machine That Always Paid in Gold"
 },
 {
  "id": "nightly-dark-anime-lettering-symbols",
  "title": "The Cursed Sigil Only the Shadow Could Read",
  "style": "Dark Anime",
  "category": "Lettering / Symbols > The Cursed Sigil Only the Shadow Could Read"
 },
 {
  "id": "nightly-minimalist-aliens-ufos",
  "title": "Single Line to the Saucer",
  "style": "Minimalist",
  "category": "Aliens / UFOs > Single Line to the Saucer"
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
