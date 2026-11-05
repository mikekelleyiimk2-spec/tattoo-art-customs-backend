// One-time seed: 9 style x category pair-filler designs (nightly 2026-11-05).
// Run via Render shell: node scripts/seed-nightly-20261105.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-blueprint-retro-vintage",
  "title": "The Jukebox That Was Drafted in Blue Ink",
  "style": "Blueprint",
  "category": "Retro & Vintage > The Jukebox That Was Drafted in Blue Ink"
 },
 {
  "id": "nightly-traditional-ancient-civilizations",
  "title": "The Sun Disk That Sailed the First River",
  "style": "Traditional",
  "category": "Ancient Civilizations > The Sun Disk That Sailed the First River"
 },
 {
  "id": "nightly-carved-wood-portals-doors",
  "title": "The Door That Was Whittled From a Single Oak",
  "style": "Carved Wood",
  "category": "Portals & Doors > The Door That Was Whittled From a Single Oak"
 },
 {
  "id": "nightly-stained-shard-gambling-luck",
  "title": "The Dice That Broke Into Colored Glass",
  "style": "Stained Shard",
  "category": "Gambling / Luck > The Dice That Broke Into Colored Glass"
 },
 {
  "id": "nightly-blackwork-deep-sea",
  "title": "The Anglerfish That Carried Its Own Moon",
  "style": "Blackwork",
  "category": "Deep Sea > The Anglerfish That Carried Its Own Moon"
 },
 {
  "id": "nightly-origami-hands-gestures",
  "title": "The Hand That Folded Itself Into a Crane",
  "style": "Origami",
  "category": "Hands & Gestures > The Hand That Folded Itself Into a Crane"
 },
 {
  "id": "nightly-stained-shard-vehicles",
  "title": "The Locomotive That Ran on Stained Glass",
  "style": "Stained Shard",
  "category": "Vehicles > The Locomotive That Ran on Stained Glass"
 },
 {
  "id": "nightly-surrealism-seasons",
  "title": "The Tree That Wore All Four Seasons at Once",
  "style": "Surrealism",
  "category": "Seasons > The Tree That Wore All Four Seasons at Once"
 },
 {
  "id": "nightly-circuit-bloom-mushrooms-discworld",
  "title": "The Mushroom That Grew a Circuit Garden",
  "style": "Circuit Bloom",
  "category": "Mushrooms / Discworld > The Mushroom That Grew a Circuit Garden"
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
