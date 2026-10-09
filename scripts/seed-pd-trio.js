// One-time seed: 3 public-domain original designs for the main gallery.
// Winnie the Pooh (A.A. Milne 1926 book version — classic storybook teddy bear,
// NOT Disney's red-shirt version), Thor (Norse god — Viking warrior, NOT Marvel),
// Loki (Norse trickster god — NOT Marvel's horned-helmet version).
// Owner standing rule 2026-10-08: public-domain versions go in the MAIN GALLERY
// as original art; copyrighted versions stay by-request only.
// Run via Render shell: node scripts/seed-pd-trio.js
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "pd-winnie-the-pooh",
  "title": "Winnie the Pooh",
  "style": "Original",
  "category": "Fairy Tale & Storybook > Winnie the Pooh",
  "slug": "winnie-the-pooh",
  "description": "Original public-domain storybook teddy bear tattoo design (1926 book version). Full color with shading plus matching clean linework included.",
  "hasColor": true
 },
 {
  "id": "pd-thor-norse",
  "title": "Thor, God of Thunder",
  "style": "Original",
  "category": "Mythology & Fantasy > Thor, God of Thunder",
  "slug": "thor-norse",
  "description": "Original Norse god of thunder tattoo design — Viking warrior with braided beard and war hammer Mjolnir. Full color with shading plus matching clean linework included.",
  "hasColor": true
 },
 {
  "id": "pd-loki-norse",
  "title": "Loki, Trickster God",
  "style": "Original",
  "category": "Mythology & Fantasy > Loki, Trickster God",
  "slug": "loki-norse",
  "description": "Original Norse trickster god tattoo design — slender cunning Viking figure. Clean linework edition (color version to follow).",
  "hasColor": false
 }
];
(async () => {
  await db.init();
  const now = Date.now();
  for (const d of DESIGNS) {
    await db.upsert('designs', 'id', {
      id: d.id, title: d.title,
      description: d.description,
      categories: JSON.stringify([d.category]),
      // Gallery preview: served from assets/designs/linework-wm via /img/designs.
      linework_wm_path: `/img/designs/${d.slug}.jpg`,
      // Buyer downloads: relative paths resolved via resolveStoredPath()
      // against the asset dir (assets/designs/<folder>/<slug>.jpg).
      linework_path: `designs/linework-clean/${d.slug}.jpg`,
      color_path: d.hasColor ? `designs/color-clean/${d.slug}.jpg` : '',
      style: d.style, price_cents: 7500, status: 'approved', listing_scope: 'gallery',
      created_at: now, sale_count: 0,
    });
    console.log(`upserted: ${d.id} (color: ${d.hasColor ? 'yes' : 'linework-only'})`);
  }
  console.log('DONE');
  await db.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
