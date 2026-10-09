// POD custom tees (mounted at /merch). Owner rule 2026-09-30.
//
// Flow: a buyer picks one of their OWNED premade designs -> size/color/qty
// -> checkout -> order rides the print_orders + Printful auto-fulfillment
// path (order_type='print', product='tee_classic'). Ownership is required
// (same rule as prints): the designer was already paid on the design sale,
// so the shirt itself is a site-margin physical product (see the merch_tee
// guard in recordSaleCommissions).
//
// Without PRINTFUL_API_KEY the tee flow degrades to "merch coming soon"
// with an email notify list (merch_notify) — no silent manual-queue labor
// lands on the owner.
const express = require('express');
const db = require('../db');
const config = require('../config');
const paypal = require('../lib/paypal');
const pricing = require('../lib/pricing');
const { requireLogin } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { printfulConfigured } = require('../lib/printful');
const catalog = require('../lib/merchCatalog');

const router = express.Router();

// --- Public: merch landing (tee info, or "coming soon" + notify) ---
router.get('/', async (req, res) => {
  const configured = printfulConfigured();
  let ownedCount = 0;
  let ownedDesigns = [];
  if (configured && req.session && req.session.userId) {
    const r = await db.get(
      `SELECT COUNT(*) AS c FROM orders WHERE buyer_id = ? AND design_id IS NOT NULL
       AND status = 'paid' AND order_type = 'premade'`,
      [req.session.userId]
    ).catch(() => ({ c: 0 }));
    ownedCount = r ? r.c : 0;
    if (ownedCount > 0) {
      ownedDesigns = await db.all(
        `SELECT d.id, d.title FROM designs d
         JOIN orders o ON o.design_id = d.id
         WHERE o.buyer_id = ? AND o.status = 'paid' AND o.order_type = 'premade'
         GROUP BY d.id ORDER BY MAX(o.created_at) DESC LIMIT 50`,
        [req.session.userId]
      ).catch(() => []);
    }
  }
  const poster = require('../lib/print').PRODUCTS.poster_18x24;
  res.render('merch/index', {
    title: "Mike's Custom Tees",
    configured,
    sizes: pricing.TEE_SIZES,
    colors: pricing.TEE_COLORS,
    priceFor: pricing.teePriceCents,
    withFee: (c) => pricing.withFeeCents(c),
    money: pricing.money,
    ownedCount,
    ownedDesigns,
    posterPrice: poster ? pricing.withFeeCents(poster.price_cents) : 0,
    // Merch catalog (owner rule 2026-10-08): data-driven POD + affiliate
    // products. Affiliate cards render regardless of Printful state.
    affiliates: catalog.affiliateProducts(),
    podProducts: catalog.podProducts(),
    sheinProducts: catalog.sheinProducts(),
    printfulOk: configured,
    metaDescription: "Mike's Custom Tees — your purchased Tattoo Art Customs designs on premium Bella + Canvas tees and bold 18×24\" posters, printed on demand.",
  });
});

router.post('/notify', formLimiter, checkHoneypot, async (req, res) => {
  const email = String(req.body.email || '').trim().slice(0, 160);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    req.session.flash = 'Please enter a valid email address.';
    return res.redirect('/merch');
  }
  const existing = await db.get('SELECT id FROM merch_notify WHERE email = ?', [email]).catch(() => null);
  if (!existing) {
    // Guarded like /app-notify: a missing/failed table must never 500 the form.
    try {
      await db.insert('merch_notify', { id: db.newId(), email, created_at: db.now() });
    } catch (e) { console.error('merch-notify insert failed:', e.message); }
  }
  req.session.flash = "You're on the list — we'll email you the moment merch drops.";
  res.redirect('/merch');
});

async function ownsDesign(userId, designId) {
  const o = await db.get(
    `SELECT id FROM orders WHERE buyer_id = ? AND design_id = ? AND status = 'paid' AND order_type = 'premade'`,
    [userId, designId]
  );
  return !!o;
}

// --- Tee order form for one owned design ---
router.get('/tee/:designId', requireLogin, formLimiter, async (req, res) => {
  if (!printfulConfigured()) {
    req.session.flash = "Mike's Custom Tees are coming soon — join the notify list below.";
    return res.redirect('/merch');
  }
  const design = await db.get("SELECT id, title, color_source FROM designs WHERE id = ? AND status = 'approved'", [req.params.designId]);
  if (!design) return res.status(404).render('error', { title: 'Not found', message: 'That design is not available.' });
  if (!(await ownsDesign(req.user.id, design.id))) {
    req.session.flash = 'Tees are available for designs you have purchased.';
    return res.redirect(`/design/${design.id}`);
  }
  res.render('merch/tee-order', {
    title: `Mike's Custom Tees — ${design.title}`,
    design,
    sizes: pricing.TEE_SIZES,
    colors: pricing.TEE_COLORS,
    priceFor: pricing.teePriceCents,
    withFee: (c) => pricing.withFeeCents(c),
    money: pricing.money,
  });
});

router.post('/tee', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  try {
    if (!printfulConfigured()) throw new Error("Mike's Custom Tees are coming soon.");
    const designId = String(req.body.design_id || '');
    const design = await db.get("SELECT id, title FROM designs WHERE id = ? AND status = 'approved'", [designId]);
    if (!design || !(await ownsDesign(req.user.id, design.id))) {
      throw new Error('Tees are available for designs you have purchased.');
    }
    const size = pricing.teeSizeLabel(req.body.size);
    const color = pricing.teeColorLabel(req.body.color);
    const qty = Math.min(10, Math.max(1, parseInt(req.body.quantity, 10) || 1));
    const style = req.body.style === 'linework' ? 'linework' : 'color';

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

    const unit = pricing.teePriceCents(size);
    const amount = unit * qty;
    const fee = pricing.processingFeeCents(amount);
    const orderId = await db.insert('orders', {
      buyer_id: req.user.id, design_id: design.id, order_type: 'print',
      amount_cents: amount, fee_cents: fee, status: 'pending', payment_method: 'paypal',
      created_at: db.now(),
    });
    await db.insert('print_orders', {
      id: db.newId(), order_id: orderId, user_id: req.user.id,
      design_id: design.id, combo_id: null, product: 'tee_classic', quantity: qty,
      style, size, color, ...ship, status: 'pending',
      fulfill_token: db.newId() + db.newId(), created_at: db.now(),
    });

    try {
      const pp = await paypal.createCheckoutOrder({
        amountCents: amount + fee,
        description: `Tattoo Art Customs tee — Bella + Canvas 3001 ${color} ${size} × ${qty} ("${design.title}")`,
        returnUrl: `${config.baseUrl}/orders/approve/${orderId}`,
        cancelUrl: `${config.baseUrl}/account`,
      });
      await db.update('orders', orderId, { paypal_order_id: pp.id });
      const approve = pp.links.find((l) => l.rel === 'approve');
      return res.redirect(approve.href);
    } catch (e) {
      console.error('PayPal tee order create failed:', e.message);
      req.session.flash = 'PayPal checkout is unavailable right now — you can pay manually below.';
      return res.redirect(`/orders/manual/${orderId}`);
    }
  } catch (e) {
    req.session.flash = e.message || 'Could not start your tee order.';
    return res.redirect('/merch');
  }
});

// --- Fixed-design catalog POD products (owner rule 2026-10-08) ---
// Anyone can buy these (no design ownership needed); the print file is the
// catalog asset, not an owned design. Degrades to /merch when the product
// isn't live or Printful isn't configured.
router.get('/catalog/:productId', requireLogin, formLimiter, async (req, res) => {
  const product = catalog.getProduct(req.params.productId);
  if (!product || product.kind !== 'pod' || product.status !== 'live' || !printfulConfigured()) {
    req.session.flash = 'That item is not available yet — join the notify list below.';
    return res.redirect('/merch');
  }
  // Per-product sizes/pricing: synced Printful products carry their own
  // sizes + priceCents; legacy tee_classic entries fall back to tee pricing.
  const sizes = product.sizes || pricing.TEE_SIZES;
  const priceFor = (size) => {
    if (product.priceCents != null) {
      if (typeof product.priceCents === 'object') {
        return product.priceCents[String(size || 'M').toUpperCase()] || product.priceCents.M;
      }
      return product.priceCents;
    }
    return pricing.teePriceCents(size);
  };
  res.render('merch/catalog-order', {
    title: `Mike's Custom Tees — ${product.id}`,
    product,
    sizes,
    singleVariant: !product.sizes,
    colors: pricing.TEE_COLORS,
    priceFor,
    withFee: (c) => pricing.withFeeCents(c),
    money: pricing.money,
  });
});

router.post('/catalog', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const product = catalog.getProduct(String(req.body.product_id || ''));
    if (!product || product.kind !== 'pod' || product.status !== 'live' || !printfulConfigured()) {
      throw new Error('That item is not available yet.');
    }
    // Size validation: synced products use their own size list; single-
    // variant products (mug/sticker/poster) use 'OS'. Color is fixed.
    const rawSize = String(req.body.size || 'M').toUpperCase();
    const size = product.sizes
      ? (product.sizes.includes(rawSize) ? rawSize : product.sizes[0])
      : 'OS';
    const color = 'black';
    const qty = Math.min(10, Math.max(1, parseInt(req.body.quantity, 10) || 1));

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

    const unit = (() => {
      if (product.priceCents != null) {
        if (typeof product.priceCents === 'object') {
          return product.priceCents[size] || product.priceCents.M;
        }
        return product.priceCents;
      }
      return pricing.teePriceCents(size);
    })();
    const amount = unit * qty;
    const fee = pricing.processingFeeCents(amount);
    const orderId = await db.insert('orders', {
      buyer_id: req.user.id, design_id: null, order_type: 'print',
      amount_cents: amount, fee_cents: fee, status: 'pending', payment_method: 'paypal',
      created_at: db.now(),
    });
    await db.insert('print_orders', {
      id: db.newId(), order_id: orderId, user_id: req.user.id,
      design_id: null, combo_id: null, catalog_asset: product.asset,
      product: product.printfulProduct, quantity: qty,
      style: 'color', size, color, ...ship, status: 'pending',
      fulfill_token: db.newId() + db.newId(), created_at: db.now(),
    });

    try {
      const pp = await paypal.createCheckoutOrder({
        amountCents: amount + fee,
        description: `Tattoo Art Customs merch — ${product.id} ${color} ${size} × ${qty}`,
        returnUrl: `${config.baseUrl}/orders/approve/${orderId}`,
        cancelUrl: `${config.baseUrl}/account`,
      });
      await db.update('orders', orderId, { paypal_order_id: pp.id });
      const approve = pp.links.find((l) => l.rel === 'approve');
      return res.redirect(approve.href);
    } catch (e) {
      console.error('PayPal catalog merch order create failed:', e.message);
      req.session.flash = 'PayPal checkout is unavailable right now — you can pay manually below.';
      return res.redirect(`/orders/manual/${orderId}`);
    }
  } catch (e) {
    req.session.flash = e.message || 'Could not start your merch order.';
    return res.redirect('/merch');
  }
});

module.exports = router;
