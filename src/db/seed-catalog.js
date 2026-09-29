// One-time import of the owner's pre-made design catalog into the gallery.
// Runs at container boot from seed.js. Idempotent: only imports when the
// designs table is completely empty, and skips ids that already exist.
// Images are baked into the Docker image under assets/designs/linework-wm/
// (the public gallery only ever displays the watermarked linework preview);
// clean color/linework files stay off-site and go to buyers via delivery.
const fs = require('fs');
const path = require('path');
const db = require('./index');

const MANIFEST = path.join(__dirname, '..', '..', 'assets', 'catalog', 'manifest.json');

async function seedCatalog() {
  if (process.env.NODE_ENV === 'test' || process.env.SKIP_CATALOG_SEED === '1') {
    return; // never bulk-import into the test database
  }
  if (!fs.existsSync(MANIFEST)) {
    console.log('[seed-catalog] no manifest — skipping');
    return;
  }
  const { n } = await db.get('SELECT COUNT(*) AS n FROM designs');
  if (n > 0) {
    console.log(`[seed-catalog] designs table already has ${n} rows — skipping`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const admin = await db.get(
    "SELECT id FROM users WHERE role = 'head_admin' ORDER BY created_at ASC LIMIT 1"
  );
  const artistId = admin ? admin.id : null;
  const now = db.now();
  let inserted = 0;
  for (const d of manifest) {
    const existing = await db.get('SELECT id FROM designs WHERE id = ?', [d.id]);
    if (existing) continue;
    await db.insert('designs', {
      id: d.id,
      title: d.title,
      description: '',
      categories: JSON.stringify(d.subjects || []),
      color_path: '',
      linework_path: '',
      linework_wm_path: `${d.id}.jpg`,
      price_cents: 7500,
      artist_id: artistId,
      status: 'approved',
      listing_scope: 'gallery',
      listing_type: 'predesign',
      style: (d.styles && d.styles[0]) || '',
      watermark_choice: 'site',
      created_at: now,
      sale_count: 0,
    });
    inserted++;
  }
  console.log(`[seed-catalog] imported ${inserted}/${manifest.length} catalog designs`);
}

module.exports = { seedCatalog };
