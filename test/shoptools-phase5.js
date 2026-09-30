// Shop-tool payment routing tests: every tool-suite payment goes through the
// WEBSITE PayPal/card checkout — never Google Play Billing. Covers paid event
// registrations and session-balance collection (both new), plus a static
// assertion that no tool payment path touches Play Billing.
//
// The coordinator (test/run.js) wires this in; do not run from here.
//
//   await require('./shoptools-phase5').runDbTests(ok);       // before db.close()
//   await require('./shoptools-phase5').runHttpTests(ok, req); // HTTP phase
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const P5 = {};

async function mkUser(email, role) {
  return db.insert('users', {
    email, password_hash: await bcrypt.hash('P5Test123!', 10),
    role, display_name: email.split('@')[0],
  });
}

async function runDbTests(ok) {
  console.log('phase5 website-only payment routing:');
  const events = require('../src/lib/events');
  const flow = require('../src/shop/bookingFlow');
  const { computeBookingFees } = require('../src/shop/bookingFees');

  P5.cust = await mkUser('p5cust@test.local', 'customer');
  P5.cust2 = await mkUser('p5cust2@test.local', 'customer');
  P5.shop = await mkUser('p5shop@test.local', 'tattoo_shop');
  const shopPlan = (await db.get("SELECT id FROM plans WHERE slug = 'tattoo_shop'")).id;
  await db.insert('subscriptions', {
    user_id: P5.shop, plan_id: shopPlan, status: 'active',
    current_period_end: Date.now() + 30 * 86400000,
  });
  // Shop is payout-eligible so ledger credits are payable (and reducible on refund).
  await db.insert('payout_destinations', {
    user_id: P5.shop, recipient_type: 'shop', dest_type: 'paypal',
    label: 'test', details: '{}', is_default: 1, created_at: Date.now(),
  });

  const future = Date.now() + 7 * 86400000;

  // --- free events keep working (no payment) ---
  const freeId = await events.createEvent({
    shopUserId: P5.shop, title: 'Free Flash', startsAt: future, cap: 10,
  });
  const freeRes = await events.signupForEvent({ eventId: freeId, customerUserId: P5.cust });
  ok(freeRes.needsPayment === false && freeRes.signupId, 'free event signup confirms immediately, no payment');
  const freeSignup = await db.get('SELECT status FROM event_signups WHERE id = ?', [freeRes.signupId]);
  ok(freeSignup.status === 'signed_up', 'free signup status is signed_up');

  // --- paid event: pending payment with the fee engine ---
  const paidId = await events.createEvent({
    shopUserId: P5.shop, title: 'Paid Flash Night', startsAt: future, cap: 10,
    registrationPriceCents: 2000,
  });
  const ev = await db.get('SELECT registration_price_cents FROM shop_events WHERE id = ?', [paidId]);
  ok(Number(ev.registration_price_cents) === 2000, 'event stores registration price');
  const res = await events.signupForEvent({ eventId: paidId, customerUserId: P5.cust });
  ok(res.needsPayment === true && res.paymentId, 'paid event signup returns needsPayment + paymentId');
  const pay = await db.get('SELECT * FROM event_signup_payments WHERE id = ?', [res.paymentId]);
  const want = computeBookingFees(2000);
  ok(pay && pay.status === 'pending', 'paid signup creates a pending event payment');
  ok(pay.base_cents === 2000 && pay.platform_fee_cents === want.platformFee
    && pay.processing_cents === want.processing && pay.total_cents === want.total,
    `event payment uses the fee engine (base 2000, total ${want.total})`);
  const pendSignup = await db.get('SELECT status FROM event_signups WHERE id = ?', [res.signupId]);
  ok(pendSignup.status === 'pending_payment', 'paid signup waits in pending_payment until checkout');
  // Cap counts only confirmed signups, not pending payments.
  const cnt = await db.get(
    "SELECT COUNT(*) AS n FROM event_signups WHERE event_id = ? AND status = 'signed_up'", [paidId]);
  ok(cnt.n === 0, 'pending payments do not consume event capacity');
  // Re-signup while pending reuses the same payment (no duplicates).
  const res2 = await events.signupForEvent({ eventId: paidId, customerUserId: P5.cust });
  ok(res2.paymentId === res.paymentId, 're-signup while pending reuses the payment');

  // --- confirm the paid registration (as the website checkout would) ---
  const conf = await events.confirmEventSignupPayment(res.paymentId, {
    captureId: 'C-P5TEST', orderId: 'O-P5TEST', customerUserId: P5.cust,
  });
  ok(conf.already === false, 'paid registration confirms');
  const doneSignup = await db.get('SELECT status FROM event_signups WHERE id = ?', [res.signupId]);
  ok(doneSignup.status === 'signed_up', 'confirmed registration is signed_up');
  const receipt = await db.get(
    "SELECT * FROM receipts WHERE kind = 'event_registration' ORDER BY created_at DESC LIMIT 1");
  ok(receipt && receipt.shop_receives_cents === 2000 && receipt.customer_total_cents === want.total,
    'event receipt shows shop receives 100% of base');
  ok(JSON.parse(receipt.lines_json).lines.some((l) => String(l).includes('Shop receives')),
    'event receipt lines include the "Shop receives" line');
  const ledger = await db.get(
    `SELECT * FROM commission_ledger WHERE order_id = ? AND commission_type = 'event_registration'`,
    ['event:' + res.signupId]);
  ok(ledger && ledger.amount_cents === 2000 && ledger.recipient_id === P5.shop,
    'shop ledger credited exactly the registration base');
  const conf2 = await events.confirmEventSignupPayment(res.paymentId, { customerUserId: P5.cust });
  ok(conf2.already === true, 'event payment confirmation is idempotent');

  // --- leaving a paid event before it starts refunds the base ---
  const paidId2 = await events.createEvent({
    shopUserId: P5.shop, title: 'Paid Flash 2', startsAt: future, registrationPriceCents: 1000,
  });
  const r3 = await events.signupForEvent({ eventId: paidId2, customerUserId: P5.cust2 });
  await db.update('event_signup_payments', r3.paymentId, { paypal_capture_id: 'C-P5REFUND' });
  await events.confirmEventSignupPayment(r3.paymentId, { captureId: 'C-P5REFUND', customerUserId: P5.cust2 });
  const leave = await events.leaveEvent({ eventId: paidId2, customerUserId: P5.cust2 });
  ok(leave.outcome === 'refunded_base', 'leaving a paid future event refunds the base');
  const refunded = await db.get('SELECT status, refunded_cents FROM event_signup_payments WHERE id = ?', [r3.paymentId]);
  ok(refunded.status === 'refunded' && refunded.refunded_cents === 1000, 'refund recorded on the payment');
  const ledger2 = await db.get(
    `SELECT amount_cents FROM commission_ledger WHERE order_id = ? AND commission_type = 'event_registration'`,
    ['event:' + r3.signupId]);
  ok(Number(ledger2.amount_cents) === 0, 'shop credit reduced to zero on refund');

  // --- session balances: shop records, customer pays on the website ---
  const bookingId = await db.insert('bookings', {
    shop_user_id: P5.shop, customer_user_id: P5.cust, staff_id: null, chair_id: null,
    start_at: future, end_at: future + 3600000, status: 'confirmed', deposit_cents: 5000,
    source: 'shop_page', design_id: null, intake_form_id: null,
    cancelled_at: null, completed_at: null, created_at: Date.now(),
  });
  const { paymentId: balPayId, fees: balFees } = await flow.recordBalanceDue({
    bookingId, shopUserId: P5.shop, amountCents: 15000,
  });
  const wantBal = computeBookingFees(15000);
  ok(balFees.total === wantBal.total, 'balance payment uses the fee engine');
  const balPay = await db.get('SELECT * FROM booking_payments WHERE id = ?', [balPayId]);
  ok(balPay.kind === 'balance' && balPay.status === 'pending' && balPay.base_cents === 15000,
    'balance recorded as a pending booking payment');
  let dup = null;
  try { await flow.recordBalanceDue({ bookingId, shopUserId: P5.shop, amountCents: 15000 }); }
  catch (e) { dup = e.code; }
  ok(dup === 'EXISTS', 'duplicate balance recording rejected');
  const cap = await flow.captureBalancePayment(balPayId, {
    captureId: 'C-P5BAL', orderId: 'O-P5BAL', customerUserId: P5.cust,
  });
  ok(cap.already === false && cap.payment.status === 'paid', 'balance payment captures');
  const balReceipt = await db.get(
    "SELECT * FROM receipts WHERE kind = 'balance' AND booking_id = ?", [bookingId]);
  ok(balReceipt && balReceipt.shop_receives_cents === 15000,
    'balance receipt shows shop receives 100% of base');
  const balLedger = await db.get(
    `SELECT * FROM commission_ledger WHERE order_id = ? AND commission_type = 'booking_balance'`, [bookingId]);
  ok(balLedger && balLedger.amount_cents === 15000, 'shop ledger credited exactly the balance base');
  const stillConfirmed = await db.get('SELECT status FROM bookings WHERE id = ?', [bookingId]);
  ok(stillConfirmed.status === 'confirmed', 'balance capture leaves the booking confirmed');
  const cap2 = await flow.captureBalancePayment(balPayId, { customerUserId: P5.cust });
  ok(cap2.already === true, 'balance capture is idempotent');

  // --- static: no tool payment path may touch Google Play Billing ---
  const toolFiles = [
    'src/shop/routes-bookings.js', 'src/routes/events.js', 'src/shop/routes-giftcards.js',
    'src/shop/bookingFlow.js', 'src/lib/events.js', 'src/shop/giftcards.js',
  ];
  // Real integration identifiers only — plain-English mentions of Play Billing
  // in comments ("never Google Play Billing") are the policy, not usage.
  const banned = ['playverify', 'androidpublisher', 'inappproducts', 'googleapis',
    'billingclient', 'queryproductdetails', 'launchbillingflow'];
  for (const f of toolFiles) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').toLowerCase();
    for (const b of banned) {
      ok(!src.includes(b), `${f} has no Play Billing reference (${b})`);
    }
  }
  const paywalled = [
    'src/shop/routes-bookings.js', 'src/routes/events.js', 'src/shop/routes-giftcards.js',
  ];
  for (const f of paywalled) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ok(src.includes('paypal'), `${f} routes payments through the website PayPal checkout`);
  }
  console.log('phase5 db tests done');
}

async function runHttpTests(ok, req) {
  const sdb = new Database(process.env.SQLITE_PATH);
  const PORT = process.env.P3_TEST_PORT || 4137;

  function makeJar() {
    const jar = {};
    return async function jreq(method, p, { body, follow = true } = {}) {
      const h = {};
      const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) h.cookie = cookies;
      let payload;
      if (body && typeof body === 'object') {
        payload = new URLSearchParams(body);
        h['content-type'] = 'application/x-www-form-urlencoded';
      } else payload = body;
      const res = await fetch(`http://localhost:${PORT}${p}`, {
        method, headers: h, body: payload, redirect: follow ? 'follow' : 'manual',
      });
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [k, v] = c.split(';')[0].split('=');
        jar[k.trim()] = (v || '').trim();
      }
      return { status: res.status, text: await res.text(), location: res.headers.get('location') };
    };
  }
  async function login(j, email) {
    const r = await j('POST', '/login', { body: { email, password: 'P5Test123!' }, follow: false });
    ok(r.status === 302 && (r.location || '').includes('/account'), `login ok for ${email}`);
  }

  const cust = makeJar(), cust2 = makeJar(), shop = makeJar();
  await login(cust, 'p5cust@test.local');
  await login(cust2, 'p5cust2@test.local');
  await login(shop, 'p5shop@test.local');

  // --- paid event over HTTP: signup engages checkout, not a free confirm ---
  const future = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString().slice(0, 16);
  let r = await shop('POST', '/events/create', {
    body: { title: 'HTTP Paid Flash', starts_at: future, registration_price_dollars: '25' }, follow: false,
  });
  ok(r.status === 302, 'shop creates a paid event');
  const hev = sdb.prepare('SELECT * FROM shop_events WHERE shop_user_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(sdb.prepare('SELECT id FROM users WHERE email = ?').get('p5shop@test.local').id);
  ok(Number(hev.registration_price_cents) === 2500, 'paid event price stored from dollars form field');
  r = await cust('GET', '/events');
  ok(r.status === 200 && r.text.includes('$25.00'), 'events page shows the registration price');
  r = await cust('POST', `/events/${hev.id}/signup`, { follow: false });
  ok(r.status === 302, 'paid signup redirects (to website checkout or back on PayPal failure)');
  const hpay = sdb.prepare('SELECT * FROM event_signup_payments WHERE event_id = ?').get(hev.id);
  ok(hpay && hpay.status === 'pending', 'paid signup leaves a pending website-checkout payment');
  const hsignup = sdb.prepare('SELECT status FROM event_signups WHERE id = ?').get(hpay.signup_id);
  ok(hsignup.status === 'pending_payment', 'signup waits for website payment, not auto-confirmed');
  // Simulate the PayPal return: order id set, stubbed capture confirms.
  sdb.prepare('UPDATE event_signup_payments SET paypal_order_id = ? WHERE id = ?').run('O-P5HTTP', hpay.id);
  r = await cust('GET', `/events/signup/approve/${hpay.id}`, { follow: false });
  ok(r.status === 302, 'PayPal return redirects');
  const after = sdb.prepare('SELECT status FROM event_signup_payments WHERE id = ?').get(hpay.id);
  ok(after.status === 'paid', 'approve captures via stub and marks the payment paid');
  const afterSignup = sdb.prepare('SELECT status FROM event_signups WHERE id = ?').get(hpay.signup_id);
  ok(afterSignup.status === 'signed_up', 'signup confirmed after website payment');

  // --- balance over HTTP: shop records, customer sees pay page ---
  const custId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('p5cust@test.local').id;
  const shopId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('p5shop@test.local').id;
  const bId = 'b5-' + Date.now().toString(36);
  sdb.prepare(`INSERT INTO bookings
    (id, shop_user_id, customer_user_id, staff_id, chair_id, start_at, end_at, status,
     deposit_cents, source, design_id, intake_form_id, cancelled_at, completed_at, created_at)
    VALUES (?, ?, ?, NULL, NULL, ?, ?, 'confirmed', 5000, 'shop_page', NULL, NULL, NULL, NULL, ?)`)
    .run(bId, shopId, custId, Date.now() + 86400000, Date.now() + 90000000, Date.now());
  r = await shop('POST', `/bookings/${bId}/balance`, {
    body: { amount_dollars: '80' }, follow: false,
  });
  ok(r.status === 302, 'shop records a balance due');
  const bpay = sdb.prepare("SELECT * FROM booking_payments WHERE booking_id = ? AND kind = 'balance'").get(bId);
  ok(bpay && bpay.status === 'pending' && bpay.base_cents === 8000, 'balance payment pending for the shop amount');
  r = await cust('GET', `/bookings/balance/${bpay.id}`);
  ok(r.status === 200 && r.text.includes('Session balance'), 'customer balance checkout page loads');
  ok(!r.text.toLowerCase().includes('google play'), 'balance page mentions no Play Billing');
  r = await cust('GET', `/bookings/receipt/${bId}`);
  ok(r.status === 200 && r.text.includes('Pay $'), 'receipt shows the pay-balance button');
  // Simulate the PayPal return for the balance.
  sdb.prepare('UPDATE booking_payments SET paypal_order_id = ? WHERE id = ?').run('O-P5BALHTTP', bpay.id);
  r = await cust('GET', `/bookings/balance/approve/${bpay.id}`, { follow: false });
  ok(r.status === 302, 'balance approve redirects');
  const bAfter = sdb.prepare('SELECT status FROM booking_payments WHERE id = ?').get(bpay.id);
  ok(bAfter.status === 'paid', 'balance captured via stubbed website checkout');

  sdb.close();
  console.log('phase5 http tests done');
}

module.exports = { runDbTests, runHttpTests };
