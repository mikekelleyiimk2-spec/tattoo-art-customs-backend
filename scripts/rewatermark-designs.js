// Re-generate missing watermarked linework for stuck pending designs.
// Usage on the Render shell (or any host with the repo + uploadDir):
//   node scripts/rewatermark-designs.js <design-id> [<design-id> ...]
//   node scripts/rewatermark-designs.js --all-missing   (every pending design with empty linework_wm_path)
//
// For each id: loads the design, resolves the raw linework file, runs the
// repo's own applyWatermarkedLinework (site choice, density-aware black
// anti-trace marks), and writes designs.linework_wm_path. Idempotent —
// designs that already have a watermark are skipped unless --force.
//
// Context: 2026-10-11 the server-side watermark step failed silently for the
// 10-design Cosmos pilot batch (batch 328, Neo-Japanese) uploaded ~08:21 CDT.
// /api/muse/pending-designs/:id/approve hard-blocks with 400
// "blocked-no-watermark" until linework_wm_path is set, so approval alone
// could never unblock them. This script is the repair.
const path = require('path');
const db = require('../src/db');
const { applyWatermarkedLinework } = require('../src/lib/watermark');
const { resolveStoredPath } = require('../src/lib/storage');

const PILOT_BATCH_20261011 = [
  'a5dcc0ac61206ab06b804dac', // Windmill
  'ba5ac6f0ecfb0b1d3b010b3a', // Whale
  '7a70952d4a173ffeb6f130ab', // Peregrine Falcon
  '87da5ea010ef192948f77dec', // Peony
  'f3f9d6fae17324dbd9248982', // Moon Barge
  '9b383076b699da5c35992ec5', // Luna Moth
  '7449e944640b1198258e644a', // Ember Fox
  '0e07ae9bf5cd28d44644bcf0', // Carnotaurus
  'cc98ffa1ef266923068e3a59', // Border Collie
  '7df9bdf34fd382f1317d2ca2', // Arctic Fox
];

async function fixOne(id, force) {
  const d = await db.get('SELECT id, title, linework_path, linework_wm_path, status FROM designs WHERE id = ?', [id]);
  if (!d) { console.log(id, 'SKIP: not found'); return 'missing'; }
  if (d.linework_wm_path && !force) { console.log(id, d.title, 'SKIP: already has', d.linework_wm_path); return 'ok'; }
  const lwAbs = resolveStoredPath(d.linework_path);
  if (!lwAbs) { console.log(id, d.title, 'FAIL: raw linework not on disk:', d.linework_path); return 'no-file'; }
  try {
    const wmRel = await applyWatermarkedLinework({ designId: id, lineworkAbs: lwAbs, choice: 'site' });
    await db.update('designs', id, { linework_wm_path: wmRel });
    console.log(id, d.title, 'OK ->', wmRel);
    return 'ok';
  } catch (e) {
    console.log(id, d.title, 'FAIL:', e.message);
    return 'error';
  }
}

(async () => {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  let ids = args.filter(a => !a.startsWith('--'));
  if (args.includes('--all-missing')) {
    const rows = await db.all("SELECT id FROM designs WHERE status = 'pending' AND (linework_wm_path IS NULL OR linework_wm_path = '')");
    ids = rows.map(r => r.id);
  }
  if (args.includes('--pilot-20261011')) ids = PILOT_BATCH_20261011.slice();
  if (!ids.length) {
    console.log('Usage: node scripts/rewatermark-designs.js <design-id> [...] | --all-missing | --pilot-20261011 [--force]');
    process.exit(2);
  }
  console.log(`Re-watermarking ${ids.length} design(s)${force ? ' (force)' : ''}...`);
  const tally = {};
  for (const id of ids) {
    const r = await fixOne(id, force);
    tally[r] = (tally[r] || 0) + 1;
  }
  console.log('Done:', JSON.stringify(tally));
  process.exit(0);
})().catch(e => { console.error('fatal:', e.message); process.exit(1); });
