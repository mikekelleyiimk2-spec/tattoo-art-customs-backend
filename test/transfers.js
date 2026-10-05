// Art transfers: customer<->shop pipeline tests ([transfers]).
// Phase 1: send-to-shop. Phase 2: shop buy-for-client + client bills.
// The coordinator (test/run.js) wires this in; do not run from here.
const fs = require('fs');
const path = require('path');

async function runHttpTests(ok, req) {
  console.log('art transfers (customer<->shop pipeline):');
  const Database = require('better-sqlite3');
  const tdb = new Database(process.env.SQLITE_PATH);

  // Per-user cookie jar (mirrors the suite's req helper).
  function makeClient() {
    const jar = {};
    return async function creq(method, p, { body, headers = {}, follow = true } = {}) {
      const h = { ...headers };
      const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) h.cookie = cookies;
      let payload;
      if (body && typeof body === 'object' && !(body instanceof URLSearchParams)) {
        payload = new URLSearchParams(body);
        h['content-type'] = 'application/x-www-form-urlencoded';
      } else payload = body;
      const res = await fetch(`http://localhost:4137${p}`, {
        method, headers: h, body: payload, redirect: follow ? 'follow' : 'manual',
      });
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of setCookies) {
        const [pair] = c.split(';');
        const [k, v] = pair.split('=');
        jar[k.trim()] = (v || '').trim();
      }
      const text = await res.text();
      return { status: res.status, text, location: res.headers.get('location') };
    };
  }
  const customer = makeClient();
  const shop = makeClient();
  const stranger = makeClient();

  const now = Date.now();
  // Design with real files for transfer downloads.
  const designId = 'testdesign-transfer1';
  tdb.prepare(`INSERT INTO designs (id, title, description, price_cents, status, color_path, linework_path, linework_wm_path, categories, sale_count, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(designId, 'Transfer Rose', 'desc', 7500, 'approved',
    'designs/color/transfer.jpg', 'designs/linework/transfer.jpg', 'designs/linework-wm/transfer-wm.jpg', '[]', 0, now);
  fs.mkdirSync(path.join(process.env.ASSET_DIR, 'designs', 'color'), { recursive: true });
  fs.mkdirSync(path.join(process.env.ASSET_DIR, 'designs', 'linework'), { recursive: true });
  fs.writeFileSync(path.join(process.env.ASSET_DIR, 'designs', 'color', 'transfer.jpg'), 'fake-color');
  fs.writeFileSync(path.join(process.env.ASSET_DIR, 'designs', 'linework', 'transfer.jpg'), 'fake-linework');

  // Users sign up over HTTP (proper password hashes); the shop is then
  // promoted to a verified shop with an active subscription.
  async function signupAs(client, name, email) {
    const r = await client('POST', '/signup', { body: { display_name: name, email, password: 'password123' }, follow: false });
    if (r.status !== 302) throw new Error('signup failed for ' + email);
  }
  await signupAs(customer, 'TCust2', 'tcust2@test.local');
  await signupAs(shop, 'TShop2', 'tshop2@test.local');
  await signupAs(stranger, 'TStranger2', 'tstranger2@test.local');
  const cust2 = tdb.prepare('SELECT id FROM users WHERE email = ?').get('tcust2@test.local');
  const shop2 = tdb.prepare('SELECT id FROM users WHERE email = ?').get('tshop2@test.local');
  // Promote shop2 to verified shop with active subscription.
  tdb.prepare("UPDATE users SET role = 'tattoo_shop' WHERE id = ?").run(shop2.id);
  tdb.prepare(`INSERT INTO shop_profiles (user_id, business_name, verified, created_at)
    VALUES (?,?,1,?)`).run(shop2.id, 'Test Shop 2', now);
  const planRow = tdb.prepare("SELECT id FROM plans WHERE slug = 'tattoo_shop'").get();
  tdb.prepare(`INSERT INTO subscriptions (id, user_id, plan_id, status, current_period_end, created_at)
    VALUES (lower(hex(randomblob(16))),?,?, 'active', ?, ?)`).run(shop2.id, planRow.id, now + 86400000, now);

  // Paid premade order for the customer.
  const paidOrderId = tdb.prepare(`INSERT INTO orders
    (id, buyer_id, design_id, order_type, amount_cents, fee_cents, amount_paid_cents, status, payment_method, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    'ord-transfer-1', cust2.id, designId, 'premade', 7500, 312, 7812, 'paid', 'paypal', now).lastInsertRowid;
  void paidOrderId;
  const paidOrder = tdb.prepare('SELECT id FROM orders WHERE buyer_id = ? AND design_id = ?').get(cust2.id, designId);

  // --- Phase 1: send-to-shop happy path ---
  let r = await customer('GET', `/transfers/send/${paidOrder.id}`);
  ok(r.status === 200 && r.text.includes('Test Shop 2'), 'send form renders with verified shops');
  r = await customer('POST', `/transfers/send/${paidOrder.id}`, { body: { shop_user_id: shop2.id, shop_email: '' }, follow: false });
  ok(r.status === 302, 'send-to-shop redirects after creation');
  const tr = tdb.prepare('SELECT * FROM art_transfers WHERE order_id = ?').get(paidOrder.id);
  ok(!!tr && tr.kind === 'to_shop' && tr.to_shop_user_id === shop2.id && /^[0-9a-f]{48}$/.test(tr.token),
    'transfer row created with secure token');
  ok(tr && tr.license_note.includes('single-client use') || tr.license_note.includes('Single-client'),
    'license note attached');

  // Shop inbox shows the transfer.
  r = await shop('GET', '/shop');
  ok(r.status === 200 && r.text.includes('Transfer Rose') && r.text.includes(`/transfers/${tr.token}`),
    'shop dashboard inbox shows client art');

  // Transfer download landing + file serve.
  r = await shop('GET', `/transfers/${tr.token}`);
  ok(r.status === 200 && r.text.includes('Transfer Rose') && r.text.includes('License'),
    'transfer landing renders with license note');
  r = await shop('GET', `/transfers/${tr.token}/file?which=color`, { follow: false });
  ok(r.status === 200, 'transfer color file downloads via token');
  r = await shop('GET', `/transfers/${tr.token}/file?which=linework`, { follow: false });
  ok(r.status === 200, 'transfer linework file downloads via token');
  const claimed = tdb.prepare('SELECT status FROM art_transfers WHERE id = ?').get(tr.id);
  ok(claimed.status === 'claimed', 'transfer marked claimed on download');

  // --- Unpaid order blocked ---
  const pendOrder = tdb.prepare(`INSERT INTO orders
    (id, buyer_id, design_id, order_type, amount_cents, fee_cents, status, payment_method, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    'ord-transfer-2', cust2.id, designId, 'premade', 7500, 312, 'pending', 'paypal', now);
  void pendOrder;
  const pendRow = tdb.prepare('SELECT id FROM orders WHERE id = ?').get('ord-transfer-2');
  r = await customer('POST', `/transfers/send/${pendRow.id}`, { body: { shop_email: 'any@shop.test' }, follow: false });
  ok(r.status === 302, 'unpaid order send redirects (blocked)');
  const noTr = tdb.prepare('SELECT id FROM art_transfers WHERE order_id = ?').get(pendRow.id);
  ok(!noTr, 'no transfer created for unpaid order');
  r = await customer('GET', `/transfers/send/${pendRow.id}`, { follow: false });
  ok(r.status === 302, 'send form blocked for unpaid order');

  // --- Non-owner blocked ---
  r = await stranger('POST', `/transfers/send/${paidOrder.id}`, { body: { shop_email: 'evil@shop.test' }, follow: false });
  ok(r.status === 302, "stranger's send attempt redirects");
  const evilTr = tdb.prepare("SELECT id FROM art_transfers WHERE order_id = ? AND to_email = 'evil@shop.test'").get(paidOrder.id);
  ok(!evilTr, "stranger cannot transfer another user's order");

  // --- Phase 2: shop buy-for-client ---
  r = await shop('GET', `/design/${designId}`);
  ok(r.status === 200 && r.text.includes('buy-for-client'), 'design page shows buy-for-client for shops');
  r = await customer('GET', `/design/${designId}`);
  ok(r.status === 200 && !r.text.includes('buy-for-client'), 'design page hides buy-for-client for customers');

  // Non-shop blocked from the route.
  r = await customer('POST', `/orders/buy-for-client/${designId}`, { body: { client_email: 'client@test.local' }, follow: false });
  ok(r.status === 302 && (r.location || '').includes('/membership'), 'non-shop blocked from buy-for-client');

  // Invalid email blocked.
  r = await shop('POST', `/orders/buy-for-client/${designId}`, { body: { client_email: 'not-an-email' }, follow: false });
  ok(r.status === 302, 'invalid client email rejected');

  // Valid purchase: order row carries client_email, no referral.
  r = await shop('POST', `/orders/buy-for-client/${designId}`, { body: { client_email: 'client@test.local' }, follow: false });
  const bfcOrder = tdb.prepare(`SELECT * FROM orders WHERE buyer_id = ? AND client_email = 'client@test.local'
    ORDER BY created_at DESC`).get(shop2.id);
  ok(!!bfcOrder && bfcOrder.referred_shop_id === null && bfcOrder.referral_code === '',
    'buy-for-client order records client, forces no referral');

  // Pay it via the stubbed approve flow -> client bill created.
  tdb.prepare('UPDATE orders SET paypal_order_id = ? WHERE id = ?').run('pp-bfc-' + now, bfcOrder.id);
  r = await shop('GET', `/orders/approve/${bfcOrder.id}`, { follow: false });
  ok(r.status === 302, 'buy-for-client capture redirects');
  const paidBfc = tdb.prepare('SELECT * FROM orders WHERE id = ?').get(bfcOrder.id);
  ok(paidBfc.status === 'paid', 'buy-for-client order marked paid');
  const bill = tdb.prepare('SELECT * FROM client_bills WHERE order_id = ?').get(bfcOrder.id);
  ok(!!bill && bill.status === 'unpaid' && bill.client_email === 'client@test.local' && bill.amount_cents > 0,
    'client bill auto-created unpaid on payment');
  // No referral commission to the buying shop (self-referral guard).
  const shopComm = tdb.prepare(`SELECT id FROM commission_ledger WHERE order_id = ? AND recipient_type = 'shop'`).get(bfcOrder.id);
  ok(!shopComm, 'buying shop earns no referral commission on its own purchase');

  // Shop dashboard shows client order + bill; mark paid.
  r = await shop('GET', '/shop');
  ok(r.status === 200 && r.text.includes('client@test.local'), 'shop dashboard shows client-linked purchase + bill');
  r = await shop('POST', `/shop/client-bills/${bill.id}/paid`, { body: {}, follow: false });
  ok(r.status === 302, 'mark-bill-paid redirects');
  const paidBill = tdb.prepare('SELECT status FROM client_bills WHERE id = ?').get(bill.id);
  ok(paidBill.status === 'paid', 'client bill marked paid');

  // Shop forwards art to client.
  r = await shop('POST', `/transfers/send-client/${bfcOrder.id}`, { body: {}, follow: false });
  ok(r.status === 302, 'forward-to-client redirects');
  const ctr = tdb.prepare(`SELECT * FROM art_transfers WHERE order_id = ? AND kind = 'to_client'`).get(bfcOrder.id);
  ok(!!ctr && ctr.to_email === 'client@test.local', 'client transfer created');

  // Expired token rejected.
  tdb.prepare('UPDATE art_transfers SET expires_at = ? WHERE id = ?').run(now - 1000, tr.id);
  r = await shop('GET', `/transfers/${tr.token}`, { follow: false });
  ok(r.status === 410, 'expired transfer token rejected');

  tdb.close();
}

module.exports = { runHttpTests };
