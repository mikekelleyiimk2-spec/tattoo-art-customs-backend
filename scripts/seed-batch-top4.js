// One-time seed: 15 style top-up designs (batch top4).
const db = require('../src/db');
const DESIGNS = [
 {
  "category": "Food & Drink > Pop Culture Soda",
  "id": "batch-top4-pop1",
  "style": "Pop Culture",
  "title": "Pop Culture Soda"
 },
 {
  "category": "Technology & Cyber > Pop Culture Phone",
  "id": "batch-top4-pop2",
  "style": "Pop Culture",
  "title": "Pop Culture Phone"
 },
 {
  "category": "Food & Drink > Postmodern Coffee",
  "id": "batch-top4-post1",
  "style": "Postmodern",
  "title": "Postmodern Coffee"
 },
 {
  "category": "Music > Postmodern Vinyl",
  "id": "batch-top4-post2",
  "style": "Postmodern",
  "title": "Postmodern Vinyl"
 },
 {
  "category": "Love / Hearts / Couples > Script Love",
  "id": "batch-top4-script1",
  "style": "Script / Lettering",
  "title": "Script Love"
 },
 {
  "category": "Religious / Spiritual / Occult > Script Faith",
  "id": "batch-top4-script2",
  "style": "Script / Lettering",
  "title": "Script Faith"
 },
 {
  "category": "Family > Script Family",
  "id": "batch-top4-script3",
  "style": "Script / Lettering",
  "title": "Script Family"
 },
 {
  "category": "Animals & Wildlife > Showcase Tiger",
  "id": "batch-top4-show1",
  "style": "Showcase",
  "title": "Showcase Tiger"
 },
 {
  "category": "Portraits / Memorial > Showcase Portrait",
  "id": "batch-top4-show2",
  "style": "Showcase",
  "title": "Showcase Portrait"
 },
 {
  "category": "Horror > Smoke Ghost",
  "id": "batch-top4-smoke1",
  "style": "Smoke Form",
  "title": "Smoke Ghost"
 },
 {
  "category": "Religious / Spiritual / Occult > Stained Angel",
  "id": "batch-top4-stained1",
  "style": "Stained Shard",
  "title": "Stained Angel"
 },
 {
  "category": "Floral & Botanical > Stained Rose",
  "id": "batch-top4-stained2",
  "style": "Stained Shard",
  "title": "Stained Rose"
 },
 {
  "category": "Celestial / Cosmic > Stained Sun",
  "id": "batch-top4-stained3",
  "style": "Stained Shard",
  "title": "Stained Sun"
 },
 {
  "category": "Animals & Wildlife > Stained Butterfly",
  "id": "batch-top4-stained4",
  "style": "Stained Shard",
  "title": "Stained Butterfly"
 },
 {
  "category": "Portraits / Memorial > Surreal Face",
  "id": "batch-top4-surreal1",
  "style": "Surrealism",
  "title": "Surreal Face"
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
