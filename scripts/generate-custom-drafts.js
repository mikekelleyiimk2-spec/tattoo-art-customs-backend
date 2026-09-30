// Custom 48h fulfillment — draft worker helper.
// The draft cron (or an admin running this by hand) generates 3-5 first-draft
// designs for a custom order with the media pipeline, proofs each one, saves
// them into the order's draft dir, then records them with --record.
//
// Usage:
//   node scripts/generate-custom-drafts.js                 # list orders needing drafts
//   node scripts/generate-custom-drafts.js <orderId>       # show brief + prep the draft dir
//   node scripts/generate-custom-drafts.js <orderId> --record draft-1.png,draft-2.png [--note="..."]
//                                                          # validate + record drafts, set drafts_ready
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { draftsDir, parseDrafts } = require('../src/lib/customFulfillment');

const DRAFT_COUNT_MIN = 3;
const DRAFT_COUNT_MAX = 5;

function arg(name) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return '';
}

async function listNeedingDrafts() {
  const rows = await db.all(
    `SELECT o.id, o.custom_brief, o.delivery_due, o.rush_fee_cents, u.email AS buyer_email
     FROM orders o JOIN users u ON u.id = o.buyer_id
     WHERE o.order_type = 'custom' AND o.status = 'paid' AND o.custom_status = 'needs_drafts'
     ORDER BY (o.rush_fee_cents > 0) DESC, o.delivery_due ASC`);
  if (!rows.length) { console.log('No custom orders need drafts.'); return; }
  for (const r of rows) {
    const leftH = r.delivery_due ? Math.round((r.delivery_due - Date.now()) / 3600000) : '?';
    const rushTag = (r.rush_fee_cents || 0) > 0 ? '  ⚡RUSH' : '';
    console.log(`${r.id}  SLA ${leftH}h left${rushTag}  buyer ${r.buyer_email}`);
    console.log(`  brief: ${(r.custom_brief || '').slice(0, 160)}`);
  }
}

async function showOrder(orderId) {
  const order = await db.get(
    `SELECT o.*, u.email AS buyer_email, u.display_name AS buyer_name
     FROM orders o JOIN users u ON u.id = o.buyer_id
     WHERE o.id = ? AND o.order_type = 'custom'`, [orderId]);
  if (!order) { console.error('Custom order not found: ' + orderId); process.exit(1); }
  const dir = draftsDir(order.id);
  fs.mkdirSync(dir, { recursive: true });
  const leftH = order.delivery_due ? Math.round((order.delivery_due - Date.now()) / 3600000) : '?';
  console.log('Order:  ' + order.id);
  console.log('Buyer:  ' + (order.buyer_name || order.buyer_email));
  console.log('SLA:    ' + leftH + 'h left (due ' + (order.delivery_due ? new Date(order.delivery_due).toLocaleString() : '?') + ')');
  console.log('Status: ' + order.custom_status);
  console.log('Brief:\n' + (order.custom_brief || '(no brief)'));
  console.log('\nDraft dir: ' + dir);
  console.log(`\nWorkflow: generate ${DRAFT_COUNT_MIN}-${DRAFT_COUNT_MAX} full-color first drafts with the media pipeline,`);
  console.log('following the brief exactly. PROOF each draft before accepting it:');
  console.log('  1. any lettering/text spelled correctly (regenerate if wrong)');
  console.log('  2. every brief requirement present (subject, style, colors, placement cues)');
  console.log('  3. no obvious anatomical/structural errors');
  console.log('Up to 2 regeneration retries per failed draft. Save accepted drafts as');
  console.log('draft-1.png … draft-N.png in the draft dir, then record them:');
  console.log(`  node scripts/generate-custom-drafts.js ${order.id} --record draft-1.png,draft-2.png,draft-3.png`);
}

async function recordDrafts(orderId, files, note) {
  const order = await db.get("SELECT * FROM orders WHERE id = ? AND order_type = 'custom'", [orderId]);
  if (!order) { console.error('Custom order not found: ' + orderId); process.exit(1); }
  const dir = draftsDir(order.id);
  const drafts = [];
  for (const f of files) {
    const base = path.basename(f);
    const full = path.join(dir, base);
    if (!fs.existsSync(full)) { console.error('Draft file missing: ' + full); process.exit(1); }
    if (!/\.(png|jpg|jpeg|webp)$/i.test(base)) { console.error('Draft must be an image: ' + base); process.exit(1); }
    drafts.push({ file: base, note: note || '' });
  }
  if (drafts.length < DRAFT_COUNT_MIN || drafts.length > DRAFT_COUNT_MAX) {
    console.error(`Expected ${DRAFT_COUNT_MIN}-${DRAFT_COUNT_MAX} drafts, got ${drafts.length}.`);
    process.exit(1);
  }
  await db.update('orders', order.id, {
    drafts_json: JSON.stringify(drafts), custom_status: 'drafts_ready',
  });
  console.log(`Recorded ${drafts.length} drafts for order ${order.id} — status -> drafts_ready.`);
}

async function main() {
  await migrate();
  const orderId = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
  const record = arg('record');
  const note = arg('note');
  try {
    if (!orderId) await listNeedingDrafts();
    else if (record) await recordDrafts(orderId, record.split(',').map((s) => s.trim()).filter(Boolean), note);
    else await showOrder(orderId);
  } finally {
    await db.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
