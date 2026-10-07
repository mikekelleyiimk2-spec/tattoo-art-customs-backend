// Doodle-to-merchandise tests (owner directive 2026-10-07).
// The /doodle-to-tattoo page is merchandise-first: T-shirt, Poster/Print,
// or Tattoo design (the original two-tier 48h pipeline, unchanged).
// The coordinator (test/run.js) wires this in; do not run from here.
const { randomUUID } = require('crypto');

async function runDbTests(ok) {
  console.log('doodle-merch (db):');
  const Database = require('better-sqlite3');
  const sdb = new Database(process.env.SQLITE_PATH);
  const cols = sdb.prepare('SELECT name FROM pragma_table_info(?)').all('print_orders').map((r) => r.name);
  ok(cols.includes('doodle_file'), 'migration 061: print_orders has doodle_file column');
  sdb.close();
}

async function runHttpTests(ok, req) {
  console.log('doodle-merch (http):');
  const Database = require('better-sqlite3');
  const sdb = new Database(process.env.SQLITE_PATH);

  function makeClient() {
    const jar = {};
    return async function creq(method, p, { body, headers = {}, follow = true } = {}) {
      const h = { ...headers };
      const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) h.cookie = cookies;
      const res = await fetch(`http://localhost:4137${p}`, {
        method, headers: h, body, redirect: follow ? 'follow' : 'manual',
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
  const form = (obj) => ({
    body: new URLSearchParams(obj), headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const doodleForm = (fields) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('doodle', new Blob([png], { type: 'image/png' }), 'doodle.png');
    return { body: fd };
  };
  const ship = {
    ship_name: 'Test Parent', ship_address1: '123 Main St', ship_city: 'Abbeville',
    ship_state: 'LA', ship_zip: '70510', ship_country: 'US',
  };

  // Page renders with the merchandise-first copy.
  let r = await req('GET', '/doodle-to-tattoo');
  ok(r.status === 200 && r.text.includes('Turn Their Doodle Into Merchandise'), 'GET /doodle-to-tattoo 200 with merchandise title');
  ok(r.text.includes('name="product"') && r.text.includes('value="tee"') && r.text.includes('value="print"') && r.text.includes('value="tattoo"'),
    'product picker offers tee / print / tattoo');

  // Guest POST bounces to login.
  const guest = makeClient();
  r = await guest('POST', '/doodle-to-tattoo', { ...form({ product: 'tattoo', rights: '1' }), follow: false });
  ok(r.status === 302 && (r.location || '').startsWith('/login'), 'guest POST -> login redirect');

  // Sign up a parent user.
  const user = makeClient();
  const email = `doodleparent-${randomUUID().slice(0, 8)}@test.local`;
  r = await user('POST', '/signup', { ...form({ display_name: 'Doodle Parent', email, password: 'password123' }), follow: false });
  ok(r.status === 302, 'signup redirects');

  // Tattoo flow (original behavior): file + tier=light -> custom order.
  r = await user('POST', '/doodle-to-tattoo', { ...doodleForm({ product: 'tattoo', tier: 'light', rights: '1' }), follow: false });
  ok(r.status === 302 && /^\/orders\/[a-zA-Z0-9-]+$/.test(r.location || ''), 'tattoo POST with file -> /orders/:id, got ' + r.location);
  const tattooOrderId = (r.location || '').split('/').pop();
  const tOrder = sdb.prepare('SELECT order_type, doodle_tier, doodle_file FROM orders WHERE id = ?').get(tattooOrderId);
  ok(tOrder && tOrder.order_type === 'custom' && tOrder.doodle_tier === 'light' && tOrder.doodle_file,
    'tattoo order is custom with doodle_tier=light and doodle_file');

  // Tattoo flow via app submission code (no file) still works.
  // (mint directly via sdb — the harness closes the shared db handle
  // before the HTTP phase.)
  const me = sdb.prepare('SELECT id FROM users WHERE email = ?').get(email);
  const code = 'TAC-' + randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  sdb.prepare(`INSERT INTO submission_codes (code, created_by_user, order_id, created_at) VALUES (?, ?, NULL, ?)`)
    .run(code, me.id, Date.now());
  r = await user('POST', '/doodle-to-tattoo', { ...form({ product: 'tattoo', tier: 'rework', rights: '1', tac_code: code }), follow: false });
  ok(r.status === 302 && /^\/orders\/[a-zA-Z0-9-]+$/.test(r.location || ''), 'tattoo POST with TAC code only -> /orders/:id');
  const codeRow = sdb.prepare('SELECT order_id FROM submission_codes WHERE code = ?').get(code);
  ok(codeRow && codeRow.order_id, 'submission code consumed by the tattoo order');

  // Tee without a file is rejected (merch needs the upload).
  r = await user('POST', '/doodle-to-tattoo', { ...form({ product: 'tee', rights: '1', size: 'M', color: 'black', tee_qty: '1', ...ship }), follow: false });
  ok(r.status === 302 && r.location === '/doodle-to-tattoo', 'tee POST without file -> back to form');

  // Tee with file + shipping -> print order (PayPal fails in test -> manual pay page).
  r = await user('POST', '/doodle-to-tattoo', { ...doodleForm({ product: 'tee', rights: '1', size: 'L', color: 'white', tee_qty: '2', ...ship }), follow: false });
  ok(r.status === 302 && /^\/orders\/(manual\/)?[a-zA-Z0-9-]+$/.test(r.location || ''), 'tee POST with file -> order redirect, got ' + r.location);
  const teeOrderId = (r.location || '').split('/').pop();
  const teeOrder = sdb.prepare('SELECT order_type, amount_cents FROM orders WHERE id = ?').get(teeOrderId);
  ok(teeOrder && teeOrder.order_type === 'print', 'tee order is order_type=print');
  const teePo = sdb.prepare('SELECT product, size, color, quantity, doodle_file, fulfill_token, ship_zip FROM print_orders WHERE order_id = ?').get(teeOrderId);
  ok(teePo && teePo.product === 'tee_classic' && teePo.size === 'L' && teePo.color === 'white' && teePo.quantity === 2,
    'tee print_orders row has product/size/color/qty');
  ok(teePo && teePo.doodle_file && teePo.fulfill_token && teePo.ship_zip === '70510',
    'tee print_orders row stores doodle_file, fulfill_token, shipping');

  // Poster/print with file + shipping -> print order.
  r = await user('POST', '/doodle-to-tattoo', { ...doodleForm({ product: 'print', rights: '1', print_product: 'poster_18x24', print_qty: '1', ...ship }), follow: false });
  ok(r.status === 302 && /^\/orders\/(manual\/)?[a-zA-Z0-9-]+$/.test(r.location || ''), 'poster POST with file -> order redirect');
  const posterOrderId = (r.location || '').split('/').pop();
  const posterPo = sdb.prepare('SELECT product, quantity, doodle_file FROM print_orders WHERE order_id = ?').get(posterOrderId);
  ok(posterPo && posterPo.product === 'poster_18x24' && posterPo.doodle_file,
    'poster print_orders row has product and doodle_file');

  sdb.close();
}

module.exports = { runDbTests, runHttpTests };
