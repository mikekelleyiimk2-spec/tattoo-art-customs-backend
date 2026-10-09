// Printful print-on-demand auto-fulfillment.
//
// When PRINTFUL_API_KEY is set, paid print orders are submitted to Printful
// automatically via onOrderPaid() (called from the PayPal capture + admin
// manual-confirm flows). Without the key, orders stay in the manual admin
// print queue as before.
//
// Printful needs a public URL for the artwork file, so each print order gets
// a random fulfill_token and is served at /prints/file/:id?token=... (see
// routes/prints.js). Set PRINTFUL_WEBHOOK_SECRET and register
// <BASE_URL>/prints/printful-webhook?secret=<secret> in Printful for
// shipment/tracking updates.
//
// Variant IDs: Printful variant IDs depend on the exact products you pick in
// your Printful account. Set them via env (defaults below are empty — an
// order for a product with no variant configured stays in the manual queue
// and the admin is told why).
const db = require('../db');
const config = require('../config');

const API_BASE = 'https://api.printful.com';

function printfulConfigured() {
  return !!(process.env.PRINTFUL_API_KEY || '').trim();
}

function variantIdFor(product, printOrder) {
  // POD custom tee (owner rule 2026-09-30): Bella + Canvas 3001 variants are
  // size+color specific. Set one env var per combo you sell, e.g.
  // PRINTFUL_VARIANT_TEE_BLACK_M=4011. Find the IDs in your Printful
  // dashboard (Products > Bella + Canvas 3001 > variant list). A combo with
  // no variant configured stays in the manual admin queue and the admin is
  // told exactly which env var to set.
  if (product === 'tee_classic' && printOrder) {
    const color = String(printOrder.color || 'black').toUpperCase();
    const size = String(printOrder.size || 'M').toUpperCase();
    return process.env[`PRINTFUL_VARIANT_TEE_${color}_${size}`] || '';
  }
  // Printful synced catalog products (merch store, live 2026-10-09):
  // the catalog entry carries syncVariants {SIZE: sync_variant_id}.
  try {
    const catalog = require('./merchCatalog');
    const entry = catalog.CATALOG.find((p) => p.printfulProduct === product && p.syncVariants);
    if (entry) {
      const size = String(printOrder?.size || 'M').toUpperCase();
      const vid = entry.syncVariants[size] || entry.syncVariants.OS || Object.values(entry.syncVariants)[0];
      return String(vid || '');
    }
  } catch (e) { /* fall through to static map */ }
  const map = {
    print_8x10: process.env.PRINTFUL_VARIANT_8X10 || '',
    print_12x16: process.env.PRINTFUL_VARIANT_12X16 || '',
    poster_18x24: process.env.PRINTFUL_VARIANT_POSTER || '',
    canvas_16x20: process.env.PRINTFUL_VARIANT_CANVAS || '',
  };
  return map[product] || '';
}

async function api(path, method = 'GET', body) {
  const key = (process.env.PRINTFUL_API_KEY || '').trim();
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(key).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Printful ${method} ${path} failed (${res.status}): ${data?.error?.message || JSON.stringify(data).slice(0, 200)}`);
  }
  return data.result;
}

function fileUrlFor(printOrder) {
  const base = (config.baseUrl || '').replace(/\/$/, '');
  return `${base}/prints/file/${printOrder.id}?token=${printOrder.fulfill_token}`;
}

// Submit one paid print_orders row to Printful. Returns the Printful order id.
async function submitPrintOrder(printOrder) {
  const variantId = variantIdFor(printOrder.product, printOrder);
  if (!variantId) {
    const hint = printOrder.product === 'tee_classic'
      ? ` (set PRINTFUL_VARIANT_TEE_${String(printOrder.color || 'black').toUpperCase()}_${String(printOrder.size || 'M').toUpperCase()})`
      : ' (set PRINTFUL_VARIANT_*)';
    throw new Error(`No Printful variant configured for ${printOrder.product}${hint}`);
  }
  if (!printOrder.fulfill_token) {
    printOrder.fulfill_token = db.newId() + db.newId();
    await db.update('print_orders', printOrder.id, { fulfill_token: printOrder.fulfill_token });
  }
  const payload = {
    external_id: printOrder.id,
    shipping: 'STANDARD',
    recipient: {
      name: printOrder.ship_name,
      address1: printOrder.ship_address1,
      address2: printOrder.ship_address2 || undefined,
      city: printOrder.ship_city,
      state_code: printOrder.ship_state,
      country_code: printOrder.ship_country,
      zip: printOrder.ship_zip,
    },
    items: [{
      variant_id: parseInt(variantId, 10),
      quantity: printOrder.quantity,
      files: [{ url: fileUrlFor(printOrder) }],
    }],
  };
  const result = await api('/orders', 'POST', payload);
  await db.update('print_orders', printOrder.id, {
    printful_order_id: String(result.id),
    status: 'submitted',
  });
  return result.id;
}

// Called whenever an order reaches 'paid'. Auto-submits print orders to
// Printful when configured; never throws (falls back to the manual queue).
async function onOrderPaid(order) {
  if (!order || order.order_type !== 'print') return { submitted: false };
  const po = await db.get('SELECT * FROM print_orders WHERE order_id = ?', [order.id]);
  if (!po || po.status !== 'pending') return { submitted: false };
  if (!printfulConfigured()) return { submitted: false, reason: 'printful not configured' };
  try {
    const externalId = await submitPrintOrder(po);
    return { submitted: true, externalId };
  } catch (e) {
    console.error('Printful auto-submit failed, kept in manual queue:', e.message);
    return { submitted: false, reason: e.message };
  }
}

// Printful webhook: order status / shipment updates.
async function handleWebhook(body) {
  const data = body?.data?.order || body?.data || {};
  const externalId = data.external_id || body?.data?.external_id;
  if (!externalId) return { ok: false, reason: 'no external_id' };
  const po = await db.get('SELECT * FROM print_orders WHERE id = ?', [externalId]);
  if (!po) return { ok: false, reason: 'unknown order' };
  const status = String(data.status || '').toLowerCase();
  const updates = {};
  if (status === 'fulfilled' || status === 'shipped') {
    updates.status = 'fulfilled';
    updates.fulfilled_at = db.now();
  } else if (status) {
    updates.status = 'submitted';
  }
  const shipment = data.shipments?.[0] || {};
  if (shipment.tracking_number) updates.tracking_number = shipment.tracking_number;
  if (shipment.tracking_url) updates.tracking_url = shipment.tracking_url;
  if (Object.keys(updates).length) await db.update('print_orders', po.id, updates);
  return { ok: true };
}

function webhookSecretOk(req) {
  const secret = process.env.PRINTFUL_WEBHOOK_SECRET || '';
  if (!secret) return false;
  return req.query.secret === secret;
}

module.exports = {
  printfulConfigured, variantIdFor, submitPrintOrder, onOrderPaid,
  handleWebhook, webhookSecretOk, fileUrlFor,
};
