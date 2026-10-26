// Guest design checkout tests (money-path fix 2026-10-15): a logged-out
// visitor buys a premade design end-to-end — design page (no "Log in to
// buy", trust block present, no house ads/ad slots; the disclosed
// "Complete the kit" affiliate block renders below the buy column —
// restored 2026-10-26, RoboScraper Gap 1) -> POST /orders/buy
// with a delivery email -> PayPal stub -> HMAC-gated approve/capture ->
// emailed-token download page -> file download. The coordinator
// (test/run.js) wires this in; do not run from here.
const fs = require('fs');
const path = require('path');

async function runHttpTests(ok, req, areq) {
  console.log('guest design checkout (http):');
  const Database = require('better-sqlite3');
  const tdb = new Database(process.env.SQLITE_PATH);
  const updateTokens = require('../src/lib/updateTokens');

  // Design with real files for guest downloads.
  const designId = 'testdesign-guest1';
  const now = Date.now();
  tdb.prepare(`INSERT INTO designs (id, title, description, price_cents, status, color_path, linework_path, linework_wm_path, categories, sale_count, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(designId, 'Guest Owl', 'desc', 7500, 'approved',
    'designs/color/guest.jpg', 'designs/linework/guest.jpg', 'designs/linework-wm/guest-wm.jpg', '[]', 0, now);
  fs.mkdirSync(path.join(process.env.ASSET_DIR, 'designs', 'color'), { recursive: true });
  fs.mkdirSync(path.join(process.env.ASSET_DIR, 'designs', 'linework'), { recursive: true });
  fs.writeFileSync(path.join(process.env.ASSET_DIR, 'designs', 'color', 'guest.jpg'), 'fake-color-guest');
  fs.writeFileSync(path.join(process.env.ASSET_DIR, 'designs', 'linework', 'guest.jpg'), 'fake-linework-guest');

  // Cookieless anonymous client (the shared suite jar is logged in by now).
  const anon = async (method, p, body) => {
    const res = await fetch(`http://localhost:4137${p}`, {
      method, redirect: 'manual',
      headers: body ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
      body: body ? new URLSearchParams(body).toString() : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get('location') || '' };
  };

  // 1. Design page: guest buy form + trust block, no login wall, no ad
  // slots/house ads; the disclosed affiliate kit renders (restored
  // 2026-10-26 — it had died in the 2026-10-15 pass while the Rolodex
  // records still claimed the placement; RoboScraper Gap 1).
  let a = await anon('GET', `/design/${designId}`);
  ok(a.status === 200, 'guest: design page 200');
  ok(a.text.includes('name="guest_email"'), 'guest: design page has the guest delivery-email field');
  ok(!a.text.includes('Log in to buy'), 'guest: design page has no "Log in to buy" wall');
  ok(a.text.includes('What you get — no surprises'), 'guest: trust block renders on the design page');
  ok(a.text.includes('All sales are final'), 'guest: trust block states the real refund policy');
  ok(a.text.includes('Complete the kit'), 'guest: affiliate kit renders on the design page (restored 2026-10-26)');
  ok(a.text.includes('baselabs.is/?coupon=TAC20'), 'guest: kit carries the live Base Labs link + TAC20 code');
  ok(a.text.includes('drtattooskin.com/TATTOOARTCUSTOMS'), 'guest: kit carries the live DrTattooSkin link');
  ok(a.text.includes('rel="noopener nofollow sponsored"'), 'guest: kit links carry the sponsored rel (disclosure lock)');
  ok(!a.text.includes('house-ad'), 'guest: no house ads on the design page');
  ok(!a.text.includes('ad-slot'), 'guest: no ad slots on the design page');

  // 2. Buy without a delivery email bounces back to the design — never /login.
  a = await anon('POST', `/orders/buy/${designId}`, { linework_only: '0' });
  ok(a.status === 302 && a.location.includes(`/design/${designId}`) && !a.location.includes('/login'),
    'guest: buy without email returns to the design page (no login bounce)');

  // 3. Buy with a delivery email creates the order and heads to PayPal.
  // NOTE: in this harness createCheckoutOrder keeps its real behavior and
  // the test PayPal credentials are invalid, so — exactly like the member
  // flow's manual fallback — the guest falls back to the design page. The
  // invariant asserted here is: an order is created and the guest is NEVER
  // bounced to /login. The live PayPal handoff is verified post-deploy.
  a = await anon('POST', `/orders/buy/${designId}`, { linework_only: '0', guest_email: 'guest@test.local' });
  ok(a.status === 302 && !a.location.includes('/login'),
    'guest: buy with email never bounces to /login');
  const order = tdb.prepare('SELECT * FROM orders WHERE guest_email = ? ORDER BY created_at DESC').get('guest@test.local');
  ok(!!order, 'guest: order row created');
  ok(order && order.buyer_id === '' && order.status === 'pending' && order.order_type === 'premade',
    'guest: order is a pending premade with the guest sentinel buyer');

  // 4. Approve is HMAC-gated: no token -> 403; wrong token -> 403.
  a = await anon('GET', `/orders/approve/${order.id}`);
  ok(a.status === 403, 'guest: approve without the checkout token is 403');
  a = await anon('GET', `/orders/approve/${order.id}?gt=${order.id}.00000000000000000000000000000000`);
  ok(a.status === 403, 'guest: approve with a forged token is 403');

  // 5. Approve with the real token captures (PayPal stub) and lands on the
  // public download page; the order is paid and a download token exists.
  const gt = updateTokens.issue(order.id, 'guest-design-checkout');
  a = await anon('GET', `/orders/approve/${order.id}?gt=${encodeURIComponent(gt)}`);
  ok(a.status === 302 && a.location.includes('/orders/download/') && a.location.includes('/view'),
    'guest: approve redirects to the download page');
  const paid = tdb.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  ok(paid && paid.status === 'paid', 'guest: order is paid after capture');
  const dl = tdb.prepare('SELECT * FROM downloads WHERE order_id = ?').get(order.id);
  ok(!!dl, 'guest: download token issued at fulfillment');
  const viewPath = a.location;

  // 6. Download page + both files serve anonymously on the token.
  a = await anon('GET', viewPath);
  ok(a.status === 200, 'guest: download page 200');
  ok(!a.text.includes('house-ad'), 'guest: no house ads on the download page');
  a = await anon('GET', `/orders/download/${dl.token}`);
  ok(a.status === 200 && a.text === 'fake-color-guest', 'guest: color file downloads on the token');
  a = await anon('GET', `/orders/download/${dl.token}?file=linework`);
  ok(a.status === 200 && a.text === 'fake-linework-guest', 'guest: linework file downloads on the token');

  // 7. Revisiting the approve link once paid goes back to the download page.
  a = await anon('GET', `/orders/approve/${order.id}?gt=${encodeURIComponent(gt)}`);
  ok(a.status === 302 && a.location.includes('/orders/download/'),
    'guest: paid approve link returns to the download page');

  // 8. Member regression: a logged-in buyer still sees the trust block, no
  // ads on the design page, and the member buy form (no guest email field).
  if (areq) {
    const r = await areq('GET', `/design/${designId}`);
    ok(r.status === 200 && r.text.includes('What you get — no surprises'), 'member: trust block renders on the design page');
    ok(r.status === 200 && !r.text.includes('house-ad'), 'member: no house ads on the design page');
    ok(r.status === 200 && !r.text.includes('name="guest_email"'), 'member: buy form has no guest email field');
  }
  tdb.close();
}

module.exports = { runHttpTests };
