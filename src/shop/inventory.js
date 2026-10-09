// Shop inventory alerts (shop toolset, 2026-10-09).
//
// Supply tracking per shop: name, category (ink/needles/disposables/...),
// qty on hand, low-stock threshold, unit. Anything at or below its
// threshold shows up on the dashboard as needing a reorder.
const db = require('../db');

const INVENTORY_CATEGORIES = ['ink', 'needles', 'disposables', 'equipment', 'aftercare', 'cleaning', 'office', 'other'];

// Load one item, scoped to the shop. Throws when it is not theirs.
async function getItem(shopUserId, id) {
  const item = await db.get(
    'SELECT * FROM shop_inventory_items WHERE id = ? AND shop_user_id = ?',
    [String(id), String(shopUserId)]);
  if (!item) throw new Error('Item not found.');
  return item;
}

async function upsertItem({ shopUserId, id = null, name, category = null, qtyOnHand = 0, lowStockThreshold = 5, unit = null }) {
  const cleanName = String(name || '').trim().slice(0, 120);
  if (!cleanName) throw new Error('Item name is required.');
  const cleanCat = String(category || '').trim().slice(0, 60).toLowerCase() || null;
  const cleanUnit = String(unit || '').trim().slice(0, 20) || null;
  const qty = Math.max(0, parseInt(qtyOnHand, 10) || 0);
  const threshold = Math.max(0, parseInt(lowStockThreshold, 10) || 0);
  if (id) {
    const item = await getItem(shopUserId, id);
    await db.update('shop_inventory_items', item.id, {
      name: cleanName, category: cleanCat, qty_on_hand: qty,
      low_stock_threshold: threshold, unit: cleanUnit, updated_at: Date.now(),
    });
    return db.get('SELECT * FROM shop_inventory_items WHERE id = ?', [item.id]);
  }
  const now = Date.now();
  return db.insert('shop_inventory_items', {
    shop_user_id: String(shopUserId), name: cleanName, category: cleanCat,
    qty_on_hand: qty, low_stock_threshold: threshold, unit: cleanUnit,
    updated_at: now,
  });
}

async function getItems(shopUserId) {
  return db.all(
    'SELECT * FROM shop_inventory_items WHERE shop_user_id = ? ORDER BY name ASC',
    [String(shopUserId)]);
}

// Quick +/- adjustment. Quantity never goes below zero.
async function adjustQty(shopUserId, id, delta) {
  const item = await getItem(shopUserId, id);
  const qty = Math.max(0, item.qty_on_hand + (parseInt(delta, 10) || 0));
  await db.update('shop_inventory_items', item.id, { qty_on_hand: qty, updated_at: Date.now() });
  return db.get('SELECT * FROM shop_inventory_items WHERE id = ?', [item.id]);
}

async function deleteItem(shopUserId, id) {
  const item = await getItem(shopUserId, id);
  await db.query('DELETE FROM shop_inventory_items WHERE id = ?', [item.id]);
  return true;
}

// Items at or below their low-stock threshold — the reorder list.
async function getLowStock(shopUserId) {
  return db.all(
    `SELECT * FROM shop_inventory_items
     WHERE shop_user_id = ? AND qty_on_hand <= low_stock_threshold
     ORDER BY qty_on_hand ASC, name ASC`,
    [String(shopUserId)]);
}

module.exports = {
  INVENTORY_CATEGORIES,
  getItem, upsertItem, getItems, adjustQty, deleteItem, getLowStock,
};
