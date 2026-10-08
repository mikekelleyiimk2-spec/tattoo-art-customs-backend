// Print ordering: buyers order physical prints of art they have purchased
// (premade designs they own, or their saved studio combinations).
const express = require('express');
const db = require('../db');
const config = require('../config');
const { resolveStoredPath } = require('../lib/storage');
const paypal = require('../lib/paypal');
const pricing = require('../lib/pricing');
const { requireLogin } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { PRODUCTS, productIds } = require('../lib/print');

const router = express.Router();

// --- Public routes (no login): Printful file fetch + webhook ---
const path = require('path');
const fs = require('fs');
const { handleWebhook, webhookSecretOk } = require('../lib/printful');

// Printful fetches the artwork via this token-gated URL (fulfill_token is
// minted per print order and never exposed to customers).
router.get('/file/:id', async (req, res) => {
  const token = String(req.query.token || '');
  const po = await db.get('SELECT * FROM print_orders WHERE id = ? AND fulfill_token = ?', [req.params.id, token]);
  if (!po || !token) return res.status(404).send('Not found');
  let rel = null;
  if (po.design_id) {
    const d = await db.get('SELECT color_path, linework_path FROM designs WHERE id = ?', [po.design_id]);
    if (d) rel = po.style === 'linework' ? d.linework_path : d.color_path;
  } else if (po.combo_id) {
    const c = await db.get('SELECT output_path FROM combos WHERE id = ?', [po.combo_id]);
    if (c) rel = c.output_path;
  } else if (po.doodle_file) {
    // Doodle-merch orders (tee/poster from /doodle-to-tattoo): the kid's
    // uploaded drawing prints as-is. Basename only — traversal guard.
    rel = 'doodles/' + path.basename(String(po.doodle_file));
  } else if (po.catalog_asset) {
    // Merch-catalog fixed-design POD products (/merch). Stored as a
    // catalog/-prefixed relative path (see merchCatalog.js asset field).
    // Pinned under assets/catalog/ with a traversal guard.
    const ca = String(po.catalog_asset).replace(/\\/g, '/');
    if (/^catalog\/[A-Za-z0-9._/-]+$/.test(ca) && !ca.includes('..')) {
      rel = ca;
    }
  }
  const abs = rel ? resolveStoredPath(rel) : null;
  if (!abs) return res.status(404).send('File missing');
  res.download(abs);
});

// Printful order status / shipment webhook (?secret=PRINTFUL_WEBHOOK_SECRET).
router.post('/printful-webhook', express.json(), async (req, res) => {
  if (!webhookSecretOk(req)) return res.status(403).json({ ok: false });
  const result = await handleWebhook(req.body);
  res.json(result);
});

router.use(requireLogin);

async function ownsDesign(userId, designId) {
  const o = await db.get(
    `SELECT id FROM orders WHERE buyer_id = ? AND design_id = ? AND status = 'paid' AND order_type = 'premade'`,
    [userId, designId]
  );
  return !!o;
}

async function ownsCombo(userId, comboId) {
  const c = await db.get('SELECT id FROM combos WHERE id = ? AND user_id = ?', [comboId, userId]);
  return !!c;
}

async function renderOrderForm(req, res, source) {
  // source: { kind: 'design'|'combo', id, title }
  res.render('prints/order', {
    withFee: (c) => pricing.withFeeCents(c),
    title: `Order a print — Tattoo Art Customs`,
    source,
    products: PRODUCTS,
  });
}

router.get('/order/design/:designId', formLimiter, async (req, res) => {
  const design = await db.get("SELECT id, title FROM designs WHERE id = ? AND status = 'approved'", [req.params.designId]);
  if (!design) return res.status(404).render('error', { title: 'Not found', message: 'That design is not available.' });
  if (!(await ownsDesign(req.user.id, design.id))) {
    req.session.flash = 'You can order prints of designs you have purchased.';
    return res.redirect(`/design/${design.id}`);
  }
  return renderOrderForm(req, res, { kind: 'design', id: design.id, title: design.title });
});

router.get('/order/combo/:comboId', formLimiter, async (req, res) => {
  const combo = await db.get('SELECT id, name FROM combos WHERE id = ?', [req.params.comboId]);
  if (!combo || !(await ownsCombo(req.user.id, combo.id))) {
    return res.status(404).render('error', { title: 'Not found', message: 'Combination not found.' });
  }
  return renderOrderForm(req, res, { kind: 'combo', id: combo.id, title: combo.name });
});

router.post('/order', formLimiter, checkHoneypot, async (req, res) => {
  try {
    const { source_kind, source_id, product, quantity, style } = req.body;
    if (!productIds().includes(product)) throw new Error('Choose a valid print product.');
    const qty = Math.min(10, Math.max(1, parseInt(quantity, 10) || 1));
    const printStyle = style === 'linework' ? 'linework' : 'color';

    let designId = null;
    let comboId = null;
    let sourceTitle = '';
    if (source_kind === 'design') {
      const design = await db.get("SELECT id, title FROM designs WHERE id = ? AND status = 'approved'", [source_id]);
      if (!design || !(await ownsDesign(req.user.id, design.id))) throw new Error('You can only print designs you have purchased.');
      designId = design.id;
      sourceTitle = design.title;
    } else if (source_kind === 'combo') {
      const combo = await db.get('SELECT id, name FROM combos WHERE id = ?', [source_id]);
      if (!combo || !(await ownsCombo(req.user.id, combo.id))) throw new Error('Combination not found.');
      comboId = combo.id;
      sourceTitle = combo.name;
    } else {
      throw new Error('Choose what to print.');
    }

    const ship = {
      ship_name: String(req.body.ship_name || '').slice(0, 120).trim(),
      ship_address1: String(req.body.ship_address1 || '').slice(0, 160).trim(),
      ship_address2: String(req.body.ship_address2 || '').slice(0, 160).trim(),
      ship_city: String(req.body.ship_city || '').slice(0, 80).trim(),
      ship_state: String(req.body.ship_state || '').slice(0, 80).trim(),
      ship_zip: String(req.body.ship_zip || '').slice(0, 20).trim(),
      ship_country: String(req.body.ship_country || 'US').slice(0, 60).trim() || 'US',
    };
    if (!ship.ship_name || !ship.ship_address1 || !ship.ship_city || !ship.ship_zip) {
      throw new Error('Name, street address, city, and ZIP are required for shipping.');
    }

    const amount = PRODUCTS[product].price_cents * qty;
    const fee = pricing.processingFeeCents(amount);
    const orderId = await db.insert('orders', {
      buyer_id: req.user.id, design_id: designId, order_type: 'print',
      amount_cents: amount, fee_cents: fee, status: 'pending', payment_method: 'paypal',
      created_at: db.now(),
    });
    await db.insert('print_orders', {
      id: db.newId(), order_id: orderId, user_id: req.user.id,
      design_id: designId, combo_id: comboId, product, quantity: qty,
      style: printStyle, ...ship, status: 'pending',
      fulfill_token: db.newId() + db.newId(), created_at: db.now(),
    });

    try {
      const pp = await paypal.createCheckoutOrder({
        amountCents: amount + fee,
        description: `Tattoo Art Customs print — ${PRODUCTS[product].name} × ${qty} ("${sourceTitle}")`,
        returnUrl: `${config.baseUrl}/orders/approve/${orderId}`,
        cancelUrl: `${config.baseUrl}/account`,
      });
      await db.update('orders', orderId, { paypal_order_id: pp.id });
      const approve = pp.links.find((l) => l.rel === 'approve');
      return res.redirect(approve.href);
    } catch (e) {
      console.error('PayPal print order create failed:', e.message);
      req.session.flash = 'PayPal checkout is unavailable right now — you can pay manually below.';
      return res.redirect(`/orders/manual/${orderId}`);
    }
  } catch (e) {
    req.session.flash = e.message || 'Could not start your print order.';
    return res.redirect('/account');
  }
});

module.exports = router;
