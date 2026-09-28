// Sold custom-piece replacement tests (DB phase — runs before db.close()).
// Owner rule 2026-09-28: only custom (one-of-a-kind) pieces delist on sale;
// premade pieces keep selling repeatedly.
const db = require('../src/db');
const { onCustomPieceSold, pendingReplacements, markReplacementDone } = require('../src/lib/replacements');

async function runDbTests(ok) {
  console.log('sold custom-piece replacements:');
  const now = db.now();
  const buyer = await db.insert('users', {
    email: 'replbuyer@test.local', password_hash: 'x', role: 'customer', display_name: 'replbuyer',
  });
  async function mkOrder(designId, orderType = 'premade') {
    const id = await db.insert('orders', {
      buyer_id: buyer, order_type: orderType, amount_cents: 7500,
      amount_paid_cents: 7500, status: 'paid', design_id: designId, paid_at: now,
    });
    return db.get('SELECT * FROM orders WHERE id = ?', [id]);
  }

  // Custom piece sale delists it and queues exactly one replacement.
  const customId = await db.insert('designs', {
    title: 'Repl Custom', status: 'approved', style: 'blackwork', listing_type: 'custom',
    categories: JSON.stringify(['skull']), price_cents: 7500, created_at: now,
  });
  const r1 = await onCustomPieceSold(await mkOrder(customId));
  ok(r1.sold === true, 'custom piece sale marks it sold');
  const d1 = await db.get('SELECT status, sold_at FROM designs WHERE id = ?', [customId]);
  ok(d1.status === 'sold' && d1.sold_at > 0, 'sold custom piece delisted with sold_at set');
  const q1 = await pendingReplacements();
  ok(q1.length === 1 && q1[0].design_id === customId && q1[0].style === 'blackwork',
    'one pending replacement queued with style/category');

  // Idempotent: second call queues nothing.
  const r2 = await onCustomPieceSold(await mkOrder(customId));
  ok(r2.sold === false, 'repeat call does not re-queue');
  ok((await pendingReplacements()).length === 1, 'still exactly one pending replacement');

  // Premade sale: the piece stays listed, no replacement queued.
  const preId = await db.insert('designs', {
    title: 'Repl Premade', status: 'approved', style: 'japanese', listing_type: 'predesign',
    categories: JSON.stringify(['koi']), price_cents: 7500, created_at: now,
  });
  const r3 = await onCustomPieceSold(await mkOrder(preId));
  ok(r3.sold === false, 'premade sale does not delist');
  const d3 = await db.get('SELECT status FROM designs WHERE id = ?', [preId]);
  ok(d3.status === 'approved', 'premade piece stays approved after sale');
  ok((await pendingReplacements()).length === 1, 'premade sale queues no replacement');

  // Made-to-order custom orders (no design) never touch the catalog.
  const customOrderId = await db.insert('orders', {
    buyer_id: buyer, order_type: 'custom', amount_cents: 12500,
    amount_paid_cents: 6250, status: 'paid', paid_at: now,
  });
  const customOrder = await db.get('SELECT * FROM orders WHERE id = ?', [customOrderId]);
  const r4 = await onCustomPieceSold(customOrder);
  ok(r4.sold === false && (await pendingReplacements()).length === 1,
    'made-to-order custom order queues no replacement');

  // Marking done removes it from the pending queue.
  await markReplacementDone(q1[0].id);
  ok((await pendingReplacements()).length === 0, 'done replacement leaves the queue');
}

module.exports = { runDbTests };
