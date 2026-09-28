// Sold-design replacements: a premade design sells exactly once. On payment,
// the design is delisted (status 'sold' — gallery/shop/app all filter on
// status = 'approved') and a replacement is queued so the catalog never
// shrinks. The weekly design pipeline makes replacements first.
const db = require('../db');

// Called whenever an order reaches 'paid' (PayPal capture + admin manual
// confirm). Idempotent: a design already marked sold queues nothing.
async function onPremadeSold(order) {
  if (!order || order.order_type !== 'premade' || !order.design_id) return { sold: false };
  const design = await db.get(
    'SELECT id, title, style, categories, artist_id, status FROM designs WHERE id = ?',
    [order.design_id]
  );
  if (!design || design.status === 'sold') return { sold: false };
  await db.update('designs', design.id, { status: 'sold', sold_at: db.now() });
  await db.insert('design_replacements', {
    design_id: design.id,
    title: design.title || '',
    style: design.style || '',
    categories: design.categories || '[]',
    artist_id: design.artist_id || null,
    status: 'pending',
    created_at: db.now(),
  });
  return { sold: true, designId: design.id };
}

// Oldest pending replacements first — the design pipeline works this queue
// before gap-fill.
async function pendingReplacements() {
  return db.all(
    "SELECT * FROM design_replacements WHERE status = 'pending' ORDER BY created_at ASC"
  );
}

async function markReplacementDone(id) {
  await db.update('design_replacements', id, { status: 'done' });
}

module.exports = { onPremadeSold, pendingReplacements, markReplacementDone };
