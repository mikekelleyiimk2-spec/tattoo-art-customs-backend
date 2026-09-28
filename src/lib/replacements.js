// Sold custom-piece replacements: a custom (one-of-a-kind) design sells
// exactly once. On payment, the piece is delisted (status 'sold' —
// gallery/shop/app all filter on status = 'approved') and a replacement is
// queued for the ORIGINAL ARTIST to remake — never generated as a premade.
// Premade (predesign) pieces keep selling repeatedly and are never delisted.
const db = require('../db');

// Called whenever an order reaches 'paid' (PayPal capture + admin manual
// confirm). Idempotent: a piece already marked sold queues nothing.
async function onCustomPieceSold(order) {
  if (!order || order.order_type !== 'premade' || !order.design_id) return { sold: false };
  const design = await db.get(
    'SELECT id, title, style, categories, artist_id, status, listing_type FROM designs WHERE id = ?',
    [order.design_id]
  );
  if (!design || design.status === 'sold') return { sold: false };
  // Premade pieces stay in the shop (repeat sales) — only custom one-offs delist.
  if (design.listing_type !== 'custom') return { sold: false };
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

// Link an artist's new upload as the remake of a sold piece. Only the
// original artist can link, and only to their own pending request.
async function linkRemake(replacementId, designId, artistId) {
  const r = await db.get('SELECT * FROM design_replacements WHERE id = ?', [replacementId]);
  if (!r || r.status !== 'pending' || r.artist_id !== artistId) return null;
  await db.update('design_replacements', r.id, { remake_design_id: designId });
  return r.id;
}

// Called when a design is approved: if it was uploaded as a remake, the
// original sold piece's replacement request is fulfilled.
async function completeOnApproval(designId) {
  const r = await db.get(
    "SELECT id FROM design_replacements WHERE remake_design_id = ? AND status = 'pending'",
    [designId]
  );
  if (r) await markReplacementDone(r.id);
  return !!r;
}

module.exports = { onCustomPieceSold, pendingReplacements, markReplacementDone, linkRemake, completeOnApproval };
