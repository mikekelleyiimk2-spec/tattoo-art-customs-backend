// One-time seed: 2 public-domain character designs (original renditions).
// Tigger = A.A. Milne's 1928 book version (E.H. Shepard storybook style, NOT Disney).
// Peter Rabbit = Beatrix Potter's 1902 character, original tattoo-style rendition.
// Owner standing rule: PD versions -> main gallery as original art.
// Run via Render shell: node scripts/seed-pd-duo.js
const db = require('../src/db');
const DESIGNS = [
  {
    id: 'tigger-book',
    title: 'Tigger',
    style: 'Storybook',
    category: 'Classic Tales > Tigger',
    description: 'Original storybook-style tattoo design of Tigger (A.A. Milne\'s 1928 book version, public domain) bouncing on his springy tail. Full color with shading plus matching clean linework included.',
    colorFile: 'tigger-book-color.jpg',
    lineworkFile: 'tigger-book-linework.jpg',
    wmFile: 'tigger-book-linework-wm.jpg',
  },
  {
    id: 'peter-rabbit',
    title: 'Peter Rabbit',
    style: 'Storybook',
    category: 'Classic Tales > Peter Rabbit',
    description: 'Original tattoo-style rendition of Peter Rabbit (Beatrix Potter\'s 1902 character, public domain), the mischievous rabbit in his blue jacket. Full color with shading plus matching clean linework included.',
    colorFile: 'peter-rabbit-color.jpg',
    lineworkFile: 'peter-rabbit-linework.jpg',
    wmFile: 'peter-rabbit-linework-wm.jpg',
  },
];
(async () => {
  await db.init();
  const now = Date.now();
  for (const d of DESIGNS) {
    await db.upsert('designs', 'id', {
      id: d.id, title: d.title,
      description: d.description,
      categories: JSON.stringify([d.category]),
      color_path: `designs/color/${d.colorFile}`,
      linework_path: `designs/linework-clean/${d.lineworkFile}`,
      linework_wm_path: `/img/designs/${d.wmFile}`,
      style: d.style, price_cents: 7500, status: 'approved', listing_scope: 'gallery',
      created_at: now, sale_count: 0,
    });
    console.log(`upserted: ${d.id}`);
  }
  console.log('DONE');
  await db.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
