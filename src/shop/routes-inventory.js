// Shop inventory routes (mounted at /shop/inventory by the coordinator).
const express = require('express');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const {
  INVENTORY_CATEGORIES,
  upsertItem, getItems, adjustQty, deleteItem, getLowStock,
} = require('./inventory');

const router = express.Router();
const gate = [requireLogin, requireSubscription('tattoo_shop')];

// Dashboard: full list with low-stock items highlighted.
router.get('/', ...gate, async (req, res) => {
  const items = await getItems(req.user.id);
  const lowIds = new Set((await getLowStock(req.user.id)).map((i) => i.id));
  res.render('shop/inventory/list', {
    title: 'Inventory — Tattoo Art Customs',
    items, lowIds, categories: INVENTORY_CATEGORIES,
  });
});

// Add or update an item (upsert: id present = update).
router.post('/', ...gate, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await upsertItem({
      shopUserId: req.user.id,
      id: req.body.id || null,
      name: req.body.name,
      category: req.body.category,
      qtyOnHand: req.body.qty_on_hand,
      lowStockThreshold: req.body.low_stock_threshold,
      unit: req.body.unit,
    });
    req.session.flash = 'Item saved.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect('/shop/inventory');
});

// Quick +/- quantity adjustment.
router.post('/:id/adjust', ...gate, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await adjustQty(req.user.id, req.params.id, req.body.delta);
    req.session.flash = 'Quantity updated.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect('/shop/inventory');
});

// Delete an item.
router.post('/:id/delete', ...gate, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await deleteItem(req.user.id, req.params.id);
    req.session.flash = 'Item deleted.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect('/shop/inventory');
});

module.exports = router;
