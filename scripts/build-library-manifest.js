// build-library-manifest.js — scan assets/library/*.zip and write
// assets/library/manifest.json with per-collection design counts and
// artist attribution for compensation tracking.
// Usage: node scripts/build-library-manifest.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'assets', 'library');

// Default attribution: all current collections were published by the owner.
// Override per-collection below as designers contribute pieces.
const ARTIST_OVERRIDES = {
  // "Some-Collection.zip": { artist_name: "Designer Name", artist_user_id: 123 },
};

const files = fs.readdirSync(LIB).filter((f) => f.toLowerCase().endsWith('.zip'));
const collections = [];
for (const file of files) {
  const full = path.join(LIB, file);
  let designs = [];
  try {
    const out = execSync(`unzip -l ${JSON.stringify(full)}`, { encoding: 'utf8' });
    designs = out.split('\n')
      .map((l) => l.trim())
      .filter((l) => /\.(jpg|jpeg|png|webp)$/i.test(l))
      .map((l) => l.split(/\s+/).pop())
      .filter((n) => n && !n.includes('__MACOSX'));
  } catch (e) {
    console.error('unzip failed for', file, e.message);
  }
  const seen = new Set();
  const uniqueDesigns = designs.filter((d) => {
    const base = path.basename(d, path.extname(d)).replace(/-(linework|color)$/i, '');
    if (seen.has(base)) return false;
    seen.add(base);
    return true;
  });
  const override = ARTIST_OVERRIDES[file] || {};
  collections.push({
    file,
    size_bytes: fs.statSync(full).size,
    design_count: uniqueDesigns.length,
    designs: uniqueDesigns.map((d) => path.basename(d)),
    artist_name: override.artist_name || 'Mike Kelley (owner)',
    artist_user_id: override.artist_user_id || null, // null = owner; no commission split needed
  });
}
collections.sort((a, b) => a.file.localeCompare(b.file));
const manifest = { updated: new Date().toISOString(), collections };
fs.writeFileSync(path.join(LIB, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
const total = collections.reduce((s, c) => s + c.design_count, 0);
console.log(`library manifest: ${collections.length} collections, ${total} designs`);
