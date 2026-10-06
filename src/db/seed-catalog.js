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
  // Incremental: import any manifest entries missing from the designs table.
  // Idempotent — existing ids are skipped, so this is safe to run on every boot.
  const { n } = await db.get('SELECT COUNT(*) AS n FROM designs');
  if (n > 0) {
    console.log(`[seed-catalog] designs table has ${n} rows — importing missing entries only`);
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
  await markRequestOnly();
}

// Trademarked/pop-culture character designs: customers must request them —
// they are fulfilled as custom orders, never instant-buy. Runs every boot so
// the flag stays correct even for rows imported before the column existed.
const REQUEST_ONLY_IDS = [
  'batch5-joker-card-milenko', 'batch5-joker-card-riddlebox', 'batch5-joker-card-ringmaster',
  'mixed-batch-kratos', 'mixed-batch-link-zelda', 'mixed-batch-mario', 'mixed-batch-master-chief',
  'mixed-batch-rem-death-note', 'mixed-batch-ryuk', 'mixed-batch-stitch',
  'pop-culture-decim', 'pop-culture-eva-unit-01', 'pop-culture-evangelion-angel',
  'pop-culture-finn-and-jake', 'pop-culture-gojo', 'pop-culture-goku', 'pop-culture-guts',
  'pop-culture-inuyasha', 'pop-culture-kirito', 'pop-culture-l-death-note', 'pop-culture-levi',
  'pop-culture-light-yagami', 'pop-culture-lucy-with-vectors', 'pop-culture-lucy-without-vectors',
  'pop-culture-luffy', 'pop-culture-makishima', 'pop-culture-motoko', 'pop-culture-naruto',
  'pop-culture-pikachu', 'pop-culture-spike-spiegel', 'pop-culture-tanjiro',
];

async function markRequestOnly() {
  try {
    const placeholders = REQUEST_ONLY_IDS.map(() => '?').join(',');
    const r = await db.run(
      `UPDATE designs SET request_only = 1 WHERE id IN (${placeholders}) AND (request_only IS NULL OR request_only = 0)`,
      REQUEST_ONLY_IDS
    );
    const n = r && r.changes ? r.changes : 0;
    if (n > 0) console.log(`[seed-catalog] marked ${n} request-only designs`);
  } catch (e) {
    // Column may not exist yet if migrations haven't run — the migration
    // adds it, and this retry runs on every boot.
    console.log('[seed-catalog] request-only marking skipped:', e.message);
  }
}

module.exports = { seedCatalog, REQUEST_ONLY_IDS };
