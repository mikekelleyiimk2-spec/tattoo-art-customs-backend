// Sold-design replacement tests (DB phase — runs before db.close()).
const db = require('../src/db');
const { onPremadeSold, pendingReplacements, markReplacementDone } = require('../src/lib/replacements');

async function runDbTests(ok) {
  console.log('sold-design replacements:');
  const now = db.now();
  const buyer = await db.insert('users', {
    email: 'replbuyer@test.local', password_hash: 'x', role: 'customer', display_name: 'replbuyer',
  });
  const designId = await db.insert('designs', {
    title: 'Repl Design', status: 'approved', style: 'blackwork',
    categories: JSON.stringify(['skull']), price_cents: 7500, created_at: now,
  });

  // Premade sale delists the design and queues exactly one replacement.
  const orderId = await db.insert('orders', {
    buyer_id: buyer, order_type: 'premade', amount_cents: 7500,
    amount_paid_cents: 7500, status: 'paid', design_id: designId, paid_at: now,
  });
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  const r1 = await onPremadeSold(order);
  ok(r1.sold === true, 'premade sale marks design sold');
  const d1 = await db.get('SELECT status, sold_at FROM designs WHERE id = ?', [designId]);
  ok(d1.status === 'sold' && d1.sold_at > 0, 'sold design delisted with sold_at set');
  const q1 = await pendingReplacements();
  ok(q1.length === 1 && q1[0].design_id === designId && q1[0].style === 'blackwork',
    'one pending replacement queued with style/category');

  // Idempotent: second call queues nothing.
  const r2 = await onPremadeSold(order);
  ok(r2.sold === false, 'repeat call does not re-queue');
  ok((await pendingReplacements()).length === 1, 'still exactly one pending replacement');

  // Custom orders never touch the design catalog.
  const customId = await db.insert('orders', {
    buyer_id: buyer, order_type: 'custom', amount_cents: 12500,
    amount_paid_cents: 6250, status: 'paid', paid_at: now,
  });
  const custom = await db.get('SELECT * FROM orders WHERE id = ?', [customId]);
  const r3 = await onPremadeSold(custom);
  ok(r3.sold === false && (await pendingReplacements()).length === 1,
    'custom order queues no replacement');

  // Marking done removes it from the pending queue.
  await markReplacementDone(q1[0].id);
  ok((await pendingReplacements()).length === 0, 'done replacement leaves the queue');
}

module.exports = { runDbTests };
