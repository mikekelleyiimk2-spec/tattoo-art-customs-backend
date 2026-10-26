// Guest PAID-APP checkout tests (money-path fix 2026-10-15): a logged-out
// visitor buys a sideload app end-to-end — buy page (guest email field, no
// "Log in to buy") -> POST buy with a delivery email -> order row with the
// '' guest sentinel + guest_email -> HMAC-gated PayPal approve/capture ->
// emailed download page serving the gated APK update token. Covers the
// generic /buy-app/:slug routes, /tac-android-pro, and /ios-app (Part 2).
// Member orders stay login-gated. The coordinator (test/run.js) wires
// this in; do not run from here.
async function runHttpTests(ok, req, areq) {
  console.log('guest app checkout (http):');
  const Database = require('better-sqlite3');
  const tdb = new Database(process.env.SQLITE_PATH);
  const guestCheckout = require('../src/lib/guestCheckout');

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

  // 1. Buy pages: guest form present, no login wall (two buy-app slugs + Pro).
  for (const p of ['/buy-app/odometer', '/buy-app/muse-button', '/buy-app/clipboard-bar', '/tac-android-pro', '/ios-app']) {
    const a = await anon('GET', p);
    ok(a.status === 200, `guest: ${p} page 200`);
    ok(a.text.includes('name="guest_email"'), `guest: ${p} has the guest delivery-email field`);
    ok(!a.text.includes('Log in to buy'), `guest: ${p} has no "Log in to buy" wall`);
  }

  // 2. Buy without a delivery email bounces back to the buy page — never /login.
  let a = await anon('POST', '/buy-app/odometer/buy', {});
  ok(a.status === 302 && a.location.includes('/buy-app/odometer') && !a.location.includes('/login'),
    'guest: buy-app buy without email returns to the buy page (no login bounce)');
  a = await anon('POST', '/tac-android-pro/buy', {});
  ok(a.status === 302 && a.location.includes('/tac-android-pro') && !a.location.includes('/login'),
    'guest: TAC Pro buy without email returns to the buy page (no login bounce)');
  a = await anon('POST', '/ios-app/buy', {});
  ok(a.status === 302 && a.location.includes('/ios-app') && !a.location.includes('/login'),
    'guest: iOS app buy without email returns to the buy page (no login bounce)');

  // 3. Buy with a delivery email creates the guest order; never /login.
  // NOTE: like the design guest flow, createCheckoutOrder keeps its real
  // behavior in this harness and the test PayPal credentials are invalid,
  // so checkout falls back to the buy page — the invariant asserted is:
  // an order row exists and the guest is NEVER bounced to /login. The
  // live PayPal handoff is verified post-deploy.
  a = await anon('POST', '/buy-app/odometer/buy', { guest_email: 'appguest@test.local' });
  ok(a.status === 302 && !a.location.includes('/login'), 'guest: buy-app buy with email never bounces to /login');
  const odoOrder = tdb.prepare('SELECT * FROM orders WHERE guest_email = ? ORDER BY created_at DESC').get('appguest@test.local');
  ok(!!odoOrder, 'guest: buy-app order row created');
  ok(odoOrder && odoOrder.buyer_id === '' && odoOrder.order_type === 'sideload:com.usefulappz.odometer' && odoOrder.status === 'pending',
    'guest: buy-app order is a pending sideload with the guest sentinel buyer');
  a = await anon('POST', '/tac-android-pro/buy', { guest_email: 'proguest@test.local' });
  ok(a.status === 302 && !a.location.includes('/login'), 'guest: TAC Pro buy with email never bounces to /login');
  const proOrder = tdb.prepare('SELECT * FROM orders WHERE guest_email = ? ORDER BY created_at DESC').get('proguest@test.local');
  ok(proOrder && proOrder.buyer_id === '' && proOrder.order_type === 'tac_android_pro' && proOrder.status === 'pending',
    'guest: TAC Pro order is a pending order with the guest sentinel buyer');
  a = await anon('POST', '/ios-app/buy', { guest_email: 'iosguest@test.local' });
  ok(a.status === 302 && !a.location.includes('/login'), 'guest: iOS app buy with email never bounces to /login');
  const iosOrder = tdb.prepare('SELECT * FROM orders WHERE guest_email = ? ORDER BY created_at DESC').get('iosguest@test.local');
  ok(iosOrder && iosOrder.buyer_id === '' && iosOrder.order_type === 'ios_app' && iosOrder.status === 'pending',
    'guest: iOS app order is a pending order with the guest sentinel buyer');

  // Seed a pending guest order the capture stub can settle: the stub
  // returns a COMPLETED $0.00 capture, so the order carries 0/0 amounts
  // (same trick as the run.js sideload capture regression block).
  const seedGuest = (id, type, email) => tdb.prepare(`INSERT INTO orders
    (id, buyer_id, design_id, order_type, amount_cents, fee_cents, status, payment_method, paypal_order_id, referral_code, guest_email, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, '', null, type, 0, 0, 'pending', 'paypal', `pp-${id}`, '', email, Date.now());

  // 4. buy-app approve is HMAC-gated; the real token captures + pays.
  seedGuest('ord-guest-odo-1', 'sideload:com.usefulappz.odometer', 'odo2@test.local');
  a = await anon('GET', '/buy-app/odometer/approve/ord-guest-odo-1');
  ok(a.status === 403, 'guest: buy-app approve without the checkout token is 403');
  a = await anon('GET', '/buy-app/odometer/approve/ord-guest-odo-1?gt=ord-guest-odo-1.00000000000000000000000000000000');
  ok(a.status === 403, 'guest: buy-app approve with a forged token is 403');
  const odoGt = guestCheckout.guestToken('ord-guest-odo-1', 'com.usefulappz.odometer');
  a = await anon('GET', `/buy-app/odometer/approve/ord-guest-odo-1?gt=${encodeURIComponent(odoGt)}`);
  ok(a.status === 302 && a.location.includes('/buy-app/odometer/download/ord-guest-odo-1') && a.location.includes('gt='),
    'guest: buy-app approve captures and redirects to the token download page');
  let row = tdb.prepare('SELECT status FROM orders WHERE id = ?').get('ord-guest-odo-1');
  ok(row && row.status === 'paid', 'guest: buy-app order is paid after capture');

  // 5. buy-app download page: token-gated, serves the gated APK token.
  a = await anon('GET', '/buy-app/odometer/download/ord-guest-odo-1');
  ok(a.status === 403, 'guest: buy-app download page without the token is 403');
  a = await anon('GET', `/buy-app/odometer/download/ord-guest-odo-1?gt=${encodeURIComponent(odoGt)}`);
  ok(a.status === 200 && a.text.includes('/api/apps/com.usefulappz.odometer/apk?t='),
    'guest: buy-app download page serves the gated APK update token');

  // 6. Paid approve link revisited returns to the download page.
  a = await anon('GET', `/buy-app/odometer/approve/ord-guest-odo-1?gt=${encodeURIComponent(odoGt)}`);
  ok(a.status === 302 && a.location.includes('/buy-app/odometer/download/ord-guest-odo-1'),
    'guest: paid buy-app approve link returns to the download page');

  // 7. TAC Pro: same HMAC gate, capture, and token download page.
  seedGuest('ord-guest-pro-1', 'tac_android_pro', 'pro2@test.local');
  a = await anon('GET', '/tac-android-pro/approve/ord-guest-pro-1');
  ok(a.status === 403, 'guest: TAC Pro approve without the checkout token is 403');
  const proGt = guestCheckout.guestToken('ord-guest-pro-1', 'tac_android_pro');
  a = await anon('GET', `/tac-android-pro/approve/ord-guest-pro-1?gt=${encodeURIComponent(proGt)}`);
  ok(a.status === 302 && a.location.includes('/tac-android-pro/download/ord-guest-pro-1') && a.location.includes('gt='),
    'guest: TAC Pro approve captures and redirects to the token download page');
  row = tdb.prepare('SELECT status FROM orders WHERE id = ?').get('ord-guest-pro-1');
  ok(row && row.status === 'paid', 'guest: TAC Pro order is paid after capture');
  a = await anon('GET', '/tac-android-pro/download/ord-guest-pro-1');
  ok(a.status === 403, 'guest: TAC Pro download page without the token is 403');
  a = await anon('GET', `/tac-android-pro/download/ord-guest-pro-1?gt=${encodeURIComponent(proGt)}`);
  ok(a.status === 200 && a.text.includes('/orders/download/'),
    'guest: TAC Pro download page serves the APK download token link');

  // 7b. iOS app: same HMAC gate, capture, and token download page.
  seedGuest('ord-guest-ios-1', 'ios_app', 'ios2@test.local');
  a = await anon('GET', '/ios-app/approve/ord-guest-ios-1');
  ok(a.status === 403, 'guest: iOS app approve without the checkout token is 403');
  a = await anon('GET', '/ios-app/approve/ord-guest-ios-1?gt=ord-guest-ios-1.00000000000000000000000000000000');
  ok(a.status === 403, 'guest: iOS app approve with a forged token is 403');
  const iosGt = guestCheckout.guestToken('ord-guest-ios-1', 'ios_app');
  a = await anon('GET', `/ios-app/approve/ord-guest-ios-1?gt=${encodeURIComponent(iosGt)}`);
  ok(a.status === 302 && a.location.includes('/ios-app/download/ord-guest-ios-1') && a.location.includes('gt='),
    'guest: iOS app approve captures and redirects to the token download page');
  row = tdb.prepare('SELECT status FROM orders WHERE id = ?').get('ord-guest-ios-1');
  ok(row && row.status === 'paid', 'guest: iOS app order is paid after capture');
  a = await anon('GET', '/ios-app/download/ord-guest-ios-1');
  ok(a.status === 403, 'guest: iOS app download page without the token is 403');
  a = await anon('GET', `/ios-app/download/ord-guest-ios-1?gt=${encodeURIComponent(iosGt)}`);
  ok(a.status === 200 && a.text.includes('/orders/download/') && a.text.includes('file=ipa'),
    'guest: iOS app download page serves the IPA download token link');
  a = await anon('GET', `/ios-app/approve/ord-guest-ios-1?gt=${encodeURIComponent(iosGt)}`);
  ok(a.status === 302 && a.location.includes('/ios-app/download/ord-guest-ios-1'),
    'guest: paid iOS app approve link returns to the download page');

  // 8. Member orders stay login-gated for anonymous visitors.
  const buyerRow = tdb.prepare("SELECT id FROM users WHERE email = 'buyer@test.local'").get();
  if (buyerRow) {
    tdb.prepare(`INSERT INTO orders
      (id, buyer_id, design_id, order_type, amount_cents, fee_cents, status, payment_method, paypal_order_id, referral_code, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('ord-member-odo-1', buyerRow.id, null,
      'sideload:com.usefulappz.odometer', 0, 0, 'paid', 'paypal', 'pp-member-1', '', Date.now());
    a = await anon('GET', '/buy-app/odometer/download/ord-member-odo-1');
    ok(a.status !== 200 && !a.text.includes('/api/apps/com.usefulappz.odometer/apk?t='),
      'member: paid member order download stays behind login for anonymous visitors');
  }

  // 9. Member regression: a logged-in visitor sees the plain buy form
  // (no guest email field) on both page types.
  if (areq) {
    const r1 = await areq('GET', '/buy-app/odometer');
    ok(r1.status === 200 && !r1.text.includes('name="guest_email"'), 'member: buy-app page has no guest email field');
    const r2 = await areq('GET', '/tac-android-pro');
    ok(r2.status === 200 && !r2.text.includes('name="guest_email"'), 'member: TAC Pro page has no guest email field');
    const r3 = await areq('GET', '/ios-app');
    ok(r3.status === 200 && !r3.text.includes('name="guest_email"'), 'member: iOS app page has no guest email field');
  }
  tdb.close();
}

module.exports = { runHttpTests };
