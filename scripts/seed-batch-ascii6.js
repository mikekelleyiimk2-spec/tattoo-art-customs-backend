// One-time seed: 15 ASCII Skin pair-filler designs (batch 6).
const db = require('../src/db');
const DESIGNS = [
 {
  "id": "batch-ascii-mandala",
  "title": "ASCII Mandala",
  "style": "ASCII Skin",
  "category": "Geometric / Abstract > ASCII Mandala"
 },
 {
  "id": "batch-ascii-iceberg",
  "title": "ASCII Iceberg",
  "style": "ASCII Skin",
  "category": "Glaciers & Icebergs > ASCII Iceberg"
 },
 {
  "id": "batch-ascii-tombstone",
  "title": "ASCII Tombstone",
  "style": "ASCII Skin",
  "category": "Graveyards & Tombs > ASCII Tombstone"
 },
 {
  "id": "batch-ascii-praying",
  "title": "ASCII Praying Hands",
  "style": "ASCII Skin",
  "category": "Hands & Gestures > ASCII Praying Hands"
 },
 {
  "id": "batch-ascii-heart",
  "title": "ASCII Heart",
  "style": "ASCII Skin",
  "category": "Hearts & Anatomy > ASCII Heart"
 },
 {
  "id": "batch-ascii-haunted",
  "title": "ASCII Haunted House",
  "style": "ASCII Skin",
  "category": "Horror > ASCII Haunted House"
 },
 {
  "id": "batch-ascii-beetle",
  "title": "ASCII Beetle",
  "style": "ASCII Skin",
  "category": "Insects & Bugs > ASCII Beetle"
 },
 {
  "id": "batch-ascii-palm",
  "title": "ASCII Palm",
  "style": "ASCII Skin",
  "category": "Jungle & Tropical > ASCII Palm"
 },
 {
  "id": "batch-ascii-key",
  "title": "ASCII Key",
  "style": "ASCII Skin",
  "category": "Keys & Locks > ASCII Key"
 },
 {
  "id": "batch-ascii-om",
  "title": "ASCII Om",
  "style": "ASCII Skin",
  "category": "Lettering / Symbols > ASCII Om"
 },
 {
  "id": "batch-ascii-lighthouse",
  "title": "ASCII Lighthouse",
  "style": "ASCII Skin",
  "category": "Lighthouses & Beacons > ASCII Lighthouse"
 },
 {
  "id": "batch-ascii-hearts",
  "title": "ASCII Hearts",
  "style": "ASCII Skin",
  "category": "Love / Hearts / Couples > ASCII Hearts"
 },
 {
  "id": "batch-ascii-venetian",
  "title": "ASCII Venetian Mask",
  "style": "ASCII Skin",
  "category": "Masks > ASCII Venetian Mask"
 },
 {
  "id": "batch-ascii-mermaid",
  "title": "ASCII Mermaid",
  "style": "ASCII Skin",
  "category": "Mermaids & Sirens > ASCII Mermaid"
 },
 {
  "id": "batch-ascii-dogtags",
  "title": "ASCII Dog Tags",
  "style": "ASCII Skin",
  "category": "Military / Patriotic > ASCII Dog Tags"
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
