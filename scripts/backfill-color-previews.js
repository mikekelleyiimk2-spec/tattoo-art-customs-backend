// Backfill watermarked finished-color previews (Approval Batch #1 item 16).
//
// For every approved design that has a finished color version
// (designs.color_path) but no public watermarked derivative yet
// (designs.color_wm_path), generate the derivative with the house
// watermark pipeline and record it. The clean color file is never
// touched and never becomes public — only the watermarked preview is
// served (gallery "Featured in color" row, /img/designs/color/).
//
// Usage: node scripts/backfill-color-previews.js [--force]
//   --force regenerates previews that already exist.
// Idempotent. The same job is available over the service API as
// POST /api/muse/color-previews-missing.
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { generateColorPreview } = require('../src/lib/colorPreview');

async function main() {
  const force = process.argv.includes('--force');
  await migrate();
  await db.init();
  const rows = await db.all(
    `SELECT id, title FROM designs
     WHERE status = 'approved' AND color_path IS NOT NULL AND color_path <> ''
     AND (? = 1 OR color_wm_path IS NULL OR color_wm_path = '')`, [force ? 1 : 0]);
  console.log(`=== Color preview backfill: ${rows.length} design(s) to process ===`);
  let ok = 0; let noSource = 0; let failed = 0;
  for (const d of rows) {
    try {
      const rel = await generateColorPreview(d.id);
      if (rel) { ok++; console.log(`  ok        ${d.id} "${d.title}" -> ${rel}`); }
      else { noSource++; console.log(`  no-source ${d.id} "${d.title}" (color file not reachable locally)`); }
    } catch (e) {
      failed++;
      console.log(`  FAILED    ${d.id} "${d.title}": ${e.message}`);
    }
  }
  console.log(`done: ${ok} generated, ${noSource} no-source, ${failed} failed`);
  await db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
