// One-time seed: insert the 8 batch-pixelated designs into the production DB.
// Run via Render shell: node scripts/seed-batch-pixelated.js
// Safe to re-run (uses upsert on id).
const db = require('../src/db');

const DESIGNS = [
  { id: 'batch-pixelated-skull', title: 'Pixelated Skull', cat: 'Skulls / Death / Gothic > Pixel Skull' },
  { id: 'batch-pixelated-heart', title: 'Pixelated Heart', cat: 'Gaming & Pixel Art > Pixel Heart' },
  { id: 'batch-pixelated-mushroom', title: 'Pixelated Mushroom', cat: 'Gaming & Pixel Art > Pixel Mushroom' },
  { id: 'batch-pixelated-ghost', title: 'Pixelated Ghost', cat: 'Gaming & Pixel Art > Pixel Ghost' },
  { id: 'batch-pixelated-sword', title: 'Pixelated Sword', cat: 'Gaming & Pixel Art > Pixel Sword' },
  { id: 'batch-pixelated-invader', title: 'Pixelated Invader', cat: 'Gaming & Pixel Art > Pixel Alien Invader' },
  { id: 'batch-pixelated-rose', title: 'Pixelated Rose', cat: 'Floral & Botanical > Pixel Rose' },
  { id: 'batch-pixelated-dragon', title: 'Pixelated Dragon', cat: 'Mythology & Fantasy > Pixel Dragon' },
];

(async () => {
  await db.init();
  const now = Date.now();
  for (const d of DESIGNS) {
    const file = `${d.id}.jpg`;
    await db.upsert('designs', 'id', {
      id: d.id,
      title: d.title,
      description: `Original 8-bit pixel art tattoo design "${d.title}" — chunky retro pixels, bold and readable. Full color with shading and background plus matching clean linework included.`,
      categories: JSON.stringify([d.cat]),
      color_path: `/img/designs/${file}`,
      linework_path: `/img/designs/${file}`,
      linework_wm_path: `/img/designs/${file}`,
      style: 'Pixelated',
      price_cents: 7500,
      status: 'approved',
      listing_scope: 'gallery',
      created_at: now,
      sale_count: 0,
    });
    console.log(`upserted: ${d.id}`);
  }
  const rows = await db.all(`SELECT id FROM designs WHERE id LIKE 'batch-pixelated-%'`);
  console.log(`DONE: ${rows.length}/${DESIGNS.length} pixelated designs in DB`);
  await db.close();
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
