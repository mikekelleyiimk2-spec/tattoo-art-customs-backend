// One-time seed: 9 style x category pair-filler designs (nightly 2026-11-02).
// Run via Render shell: node scripts/seed-nightly-20261102.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "nightly-showcase-food-drink",
  "title": "The Banquet That Became a Masterpiece",
  "style": "Showcase",
  "category": "Food & Drink > The Banquet That Became a Masterpiece"
 },
 {
  "id": "nightly-bioluminescent-showcase-pieces",
  "title": "The Lantern Reef That Stole the Show",
  "style": "Bioluminescent",
  "category": "Showcase pieces > The Lantern Reef That Stole the Show"
 },
 {
  "id": "nightly-mycelium-sports",
  "title": "The Trophy That Grew From the Field",
  "style": "Mycelium",
  "category": "Sports > The Trophy That Grew From the Field"
 },
 {
  "id": "nightly-surrealism-farmland-barns",
  "title": "The Barn That Floated Over Its Own Fields",
  "style": "Surrealism",
  "category": "Farmland & Barns > The Barn That Floated Over Its Own Fields"
 },
 {
  "id": "nightly-surrealism-tea-coffee",
  "title": "The Teacup That Held a Tiny Ocean",
  "style": "Surrealism",
  "category": "Tea & Coffee > The Teacup That Held a Tiny Ocean"
 },
 {
  "id": "nightly-carved-wood-zodiac-astrology",
  "title": "The Wheel That Was Carved From a Single Oak",
  "style": "Carved Wood",
  "category": "Zodiac / Astrology > The Wheel That Was Carved From a Single Oak"
 },
 {
  "id": "nightly-blueprint-fairy-tale-storybook",
  "title": "The Cottage That Was Drawn Before It Was Built",
  "style": "Blueprint",
  "category": "Fairy Tale & Storybook > The Cottage That Was Drawn Before It Was Built"
 },
 {
  "id": "nightly-origami-hearts-anatomy",
  "title": "The Paper Heart That Folded Itself Open",
  "style": "Origami",
  "category": "Hearts & Anatomy > The Paper Heart That Folded Itself Open"
 },
 {
  "id": "nightly-aurora-veil-seasons",
  "title": "The Year That Turned Beneath One Sky",
  "style": "Aurora Veil",
  "category": "Seasons > The Year That Turned Beneath One Sky"
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
