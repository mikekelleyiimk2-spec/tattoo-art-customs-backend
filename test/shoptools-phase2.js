// Phase 2 shop toolset: booking core + deposits/balances + receipts +
// "Get this tattooed" + shop booking settings.
// The coordinator (test/run.js) wires this in; do not run from here.
const db = require('../src/db');
const flow = require('../src/shop/bookingFlow');
const slots = require('../src/shop/bookingSlots');
const { computeBookingFees, flatBookingFee } = require('../src/shop/bookingFees');
const { upsertProfile } = require('../src/lib/profiles');

const DAY_MS = 86400000;

let seq = 0;
const tag = () => `p2-${Date.now()}-${(seq += 1)}`;

// Midnight UTC of a `weekday` (0=Sun..6=Sat) at least 7 days in the future.
function futureDay(weekday) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 7 * DAY_MS);
  d.setUTCDate(d.getUTCDate() + ((weekday - d.getUTCDay() + 7) % 7));
  return d.getTime();
}

async function mkUser(email, role = 'customer') {
  return db.insert('users', { email, password_hash: 'x', role, display_name: email.split('@')[0] });
}

async function mkShop(email) {
  const id = await mkUser(email, 'tattoo_shop');
  const plan = await db.get("SELECT id FROM plans WHERE slug = 'tattoo_shop'");
  await db.insert('subscriptions', { user_id: id, plan_id: plan.id, status: 'active' });
  await upsertProfile('shop_profiles', id, { payout_paypal_email: email });
  return id;
}

// A shop with settings + one staffer + one 09:00-12:00 UTC 60-min rule.
async function mkBookableShop(email, { deposit = 5000, depositFirst = 0, weekday = 2 } = {}) {
  const id = await mkShop(email);
  await flow.saveBookingSettings(id, {
    deposit_before_booking: depositFirst, deposit_amount_cents: deposit,
    cancel_window_hours: 24, slot_hold_minutes: 30, noshow_forfeit_deposit: 1,
    deposit_credit_expiry_days: 90,
  });
  const staffId = await db.insert('shop_staff', { shop_user_id: id, name: 'Ari', active: 1 });
  await db.insert('availability_rules', {
    shop_user_id: id, staff_id: null, chair_id: null, weekday,
    start_minutes: 540, end_minutes: 720, slot_length_minutes: 60, active: 1,
  });
  return { id, staffId, day: futureDay(weekday) };
}

async function ledgerRows(refId) {
  return db.all('SELECT * FROM commission_ledger WHERE order_id = ?', [refId]);
}

async function runDbTests(ok) {
  console.log('booking core (db):');
  const customer = await mkUser(`cust-${tag()}@test.local`);
  const shopA = await mkBookableShop(`shopa-${tag()}@test.local`); // standard flow, $50 deposit
  const shopB = await mkBookableShop(`shopb-${tag()}@test.local`, { deposit: 3000, depositFirst: 1 });

  // --- slot generation excludes booked slots ---
  let open = await slots.getOpenSlots(shopA.id, { fromTs: shopA.day, toTs: shopA.day + DAY_MS });
  ok(open.length === 3, 'rule expands to 3 one-hour slots');
  const s0 = open[0], s1 = open[1];
  const b1 = await flow.createPendingBooking({
    shopUserId: shopA.id, customerUserId: customer,
    startAt: s0.start_at, endAt: s0.end_at,
  });
  ok((await db.get('SELECT status FROM bookings WHERE id = ?', [b1])).status === 'pending_deposit',
    'hold creates a pending_deposit booking');
  open = await slots.getOpenSlots(shopA.id, { fromTs: shopA.day, toTs: shopA.day + DAY_MS });
  ok(open.length === 2, 'held slot disappears from open slots');
  ok(!(await slots.isSlotFree(shopA.id, { startAt: s0.start_at, endAt: s0.end_at })), 'held slot is not free');
  ok(await slots.isSlotFree(shopA.id, { startAt: s1.start_at, endAt: s1.end_at }), 'untouched slot stays free');

  // --- standard flow: pending -> confirmed on capture ---
  const fees = computeBookingFees(5000);
  const conf = await flow.confirmBooking(b1, { fees, captureId: 'C-T1' });
  ok(!conf.already && conf.booking.status === 'confirmed', 'confirmBooking confirms the booking');
  ok(conf.payment.status === 'paid' && conf.payment.paypal_capture_id === 'C-T1', 'booking_payments row marked paid');
  const lines = JSON.parse(conf.receipt.lines_json).lines;
  ok(lines[0] === 'Shop receives: $50.00 (100%)', 'receipt says the shop receives 100% of base');
  ok(conf.receipt.shop_receives_cents === 5000 && conf.receipt.customer_total_cents === fees.total,
    'receipt stores shop-receives and customer-total');
  const rows = await ledgerRows(b1);
  ok(rows.length === 1 && rows[0].recipient_type === 'shop' && rows[0].amount_cents === 5000
    && rows[0].status === 'payable' && rows[0].commission_type === 'booking',
    'shop nets exactly base: one payable ledger row for $50.00, no platform-fee row');
  const again = await flow.confirmBooking(b1, { fees, captureId: 'C-T1' });
  ok(again.already && (await ledgerRows(b1)).length === 1, 'confirm is idempotent (no double credit)');

  // --- expired holds stop blocking slots ---
  const bHold = await flow.createPendingBooking({
    shopUserId: shopA.id, customerUserId: customer, startAt: s1.start_at, endAt: s1.end_at,
  });
  await db.update('bookings', bHold, { created_at: Date.now() - 3600000 }); // hold window (30m) lapsed
  ok(await slots.isSlotFree(shopA.id, { startAt: s1.start_at, endAt: s1.end_at }),
    'slot frees up once the hold window lapses');
  const swept = await flow.expireStaleHolds();
  ok(swept >= 1 && (await db.get('SELECT status FROM bookings WHERE id = ?', [bHold])).status === 'expired',
    'expireStaleHolds marks lapsed holds expired');

  // --- reversed flow: deposit-first -> confirmed ---
  const { deposit, fees: dfees } = await flow.startDepositFirst(shopB.id, customer);
  ok(deposit.status === 'pending' && dfees.base === 3000, 'deposit-first opens a pending deposit credit');
  const cap = await flow.captureDeposit(deposit.id, 'C-D1');
  ok(!cap.already && cap.deposit.status === 'paid', 'deposit capture marks it paid');
  const depRows = await ledgerRows(deposit.id);
  ok(depRows.length === 1 && depRows[0].amount_cents === 3000 && depRows[0].status === 'payable'
    && depRows[0].commission_type === 'booking_deposit',
    'deposit capture credits the shop exactly base (payable)');
  const bOpen = await slots.getOpenSlots(shopB.id, { fromTs: shopB.day, toTs: shopB.day + DAY_MS });
  const booked = await flow.bookWithDeposit({
    depositId: deposit.id, startAt: bOpen[0].start_at, endAt: bOpen[0].end_at,
  });
  ok(booked.status === 'confirmed', 'deposit-first booking lands directly confirmed');
  ok((await db.get('SELECT booking_id FROM booking_deposits WHERE id = ?', [deposit.id])).booking_id === booked.id,
    'deposit links to the booking');
  ok((await db.get("SELECT booking_id FROM receipts WHERE kind = 'booking_deposit' AND booking_id = ?", [booked.id])).booking_id === booked.id,
    'deposit receipt is attached to the booked appointment');
  ok((await ledgerRows(deposit.id)).length === 1, 'no second ledger credit when the deposit is spent');
  let used = false;
  try { await flow.bookWithDeposit({ depositId: deposit.id, startAt: bOpen[1].start_at, endAt: bOpen[1].end_at }); }
  catch (e) { used = e.code === 'DEPOSIT_USED'; }
  ok(used, 'a spent deposit cannot book twice');

  // --- cancel inside the window: refund base, keep the platform fee ---
  const bOpenA = await slots.getOpenSlots(shopA.id, { fromTs: shopA.day, toTs: shopA.day + DAY_MS });
  const b2 = await flow.createPendingBooking({
    shopUserId: shopA.id, customerUserId: customer, startAt: bOpenA[0].start_at, endAt: bOpenA[0].end_at,
  });
  await flow.confirmBooking(b2, { fees: computeBookingFees(5000), captureId: 'C-T2' });
  const cx = await flow.cancelBooking(b2, {});
  ok(cx.outcome === 'refunded_base' && cx.booking.status === 'cancelled', 'cancel inside window refunds base');
  const pay2 = await db.get('SELECT status, refunded_cents FROM booking_payments WHERE booking_id = ?', [b2]);
  ok(pay2.status === 'refunded' && pay2.refunded_cents === 5000, 'payment marked refunded for exactly base');
  const rows2 = await ledgerRows(b2);
  ok(rows2.length === 1 && rows2[0].amount_cents === 0, 'shop ledger credit reduced to 0 on refund (platform fee was never in the ledger)');

  // --- cancel outside the window: forfeit ---
  const b3 = await flow.createPendingBooking({
    shopUserId: shopA.id, customerUserId: customer, startAt: bOpenA[1].start_at, endAt: bOpenA[1].end_at,
  });
  await flow.confirmBooking(b3, { fees: computeBookingFees(5000), captureId: 'C-T3' });
  // Move the appointment inside the 24h cancel window.
  await db.update('bookings', b3, { start_at: Date.now() + 3600000, end_at: Date.now() + 2 * 3600000 });
  const cx3 = await flow.cancelBooking(b3, {});
  ok(cx3.outcome === 'forfeited', 'cancel outside the window forfeits');
  ok((await db.get('SELECT status FROM booking_payments WHERE booking_id = ?', [b3])).status === 'forfeited',
    'payment marked forfeited');
  const rows3 = await ledgerRows(b3);
  ok(rows3.length === 1 && rows3[0].amount_cents === 5000 && rows3[0].status === 'payable',
    'forfeited deposit stays with the shop (payable credit stands)');

  // --- no-show forfeiture ---
  const bOpenB = await slots.getOpenSlots(shopA.id, { fromTs: shopA.day, toTs: shopA.day + DAY_MS });
  const b4 = await flow.createPendingBooking({
    shopUserId: shopA.id, customerUserId: customer, startAt: bOpenB[0].start_at, endAt: bOpenB[0].end_at,
  });
  await flow.confirmBooking(b4, { fees: computeBookingFees(5000), captureId: 'C-T4' });
  const ns = await flow.markNoShow(b4);
  ok(ns.status === 'no_show', 'markNoShow flips status');
  ok((await db.get('SELECT status FROM booking_payments WHERE booking_id = ?', [b4])).status === 'forfeited',
    'no-show forfeits the payment to the shop');

  // --- complete ---
  const done = await flow.markCompleted(conf.booking.id);
  ok(done.status === 'completed' && Number(done.completed_at) > 0, 'markCompleted flips status');

  // --- settings toggle flips the flow ---
  await flow.saveBookingSettings(shopA.id, { deposit_before_booking: 1 });
  let refused = false;
  try {
    await flow.createPendingBooking({ shopUserId: shopA.id, customerUserId: customer, startAt: s1.start_at, endAt: s1.end_at });
  } catch (e) { refused = e.code === 'DEPOSIT_FIRST'; }
  ok(refused, 'standard hold refuses once deposit_before_booking=1');
  const st = await flow.getBookingSettings(shopA.id);
  ok(Number(st.deposit_before_booking) === 1 && Number(st.cancel_window_hours) === 24, 'settings round-trip');

  // --- $0 deposit -> $1 flat booking fee ---
  const flat = flatBookingFee();
  ok(flat.base === 100 && flat.total === 160, '$0-deposit bookings charge the $1 flat fee');
  await flow.saveBookingSettings(shopA.id, { deposit_before_booking: 0, deposit_amount_cents: 0 });
  ok(flow.depositBaseCents(await flow.getBookingSettings(shopA.id)) === 100, 'null/0 deposit amount falls back to $1 base');
}

async function runHttpTests(ok, req) {
  console.log('booking core (http):');
  const Database = require('better-sqlite3');
  const wdb = new Database(process.env.SQLITE_PATH);

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
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [k, v] = c.split(';')[0].split('=');
        jar[k.trim()] = (v || '').trim();
      }
      return { status: res.status, text: await res.text(), location: res.headers.get('location') };
    };
  }
  const shop = makeClient(), cust = makeClient(), cust2 = makeClient(), anon = makeClient();

  async function signup(client, name, email) {
    const r = await client('POST', '/signup', {
      body: { display_name: name, email, password: 'password123' }, follow: false,
    });
    return r.status;
  }
  ok(await signup(shop, 'HttpBookShop', 'httpbookshop@test.local') === 302, 'shop signup');
  ok(await signup(cust, 'HttpBookCust', 'httpbookcust@test.local') === 302, 'customer signup');
  ok(await signup(cust2, 'HttpBookCust2', 'httpbookcust2@test.local') === 302, 'second customer signup');

  const shopId = wdb.prepare('SELECT id FROM users WHERE email = ?').get('httpbookshop@test.local').id;
  wdb.prepare('UPDATE users SET role = ? WHERE id = ?').run('tattoo_shop', shopId);
  const planId = wdb.prepare("SELECT id FROM plans WHERE slug = 'tattoo_shop'").get().id;
  wdb.prepare('INSERT INTO subscriptions (id, user_id, plan_id, status, created_at) VALUES (?,?,?,?,?)')
    .run(`sub-${shopId}`, shopId, planId, 'active', Date.now());
  wdb.prepare('INSERT INTO shop_profiles (user_id, payout_paypal_email, created_at) VALUES (?,?,?)').run(shopId, 'httpbookshop@test.local', Date.now());

  // Shop-only routes require the subscription.
  let r = await anon('GET', '/bookings/manage', { follow: false });
  ok(r.status === 302 && (r.location || '').includes('/login'), 'anonymous manage redirects to login');
  r = await shop('GET', '/bookings/settings');
  ok(r.status === 200 && r.text.includes('Booking settings'), 'shop settings page renders');
  ok(r.text.includes('deposit first') && r.text.includes('book first'), 'settings explains both flows in plain English');

  // Chairs / staff / availability CRUD.
  r = await shop('POST', '/bookings/chairs', { body: { name: 'Chair A' }, follow: false });
  ok(r.status === 302, 'chair created');
  r = await shop('POST', '/bookings/staff', { body: { name: 'Ari' }, follow: false });
  ok(r.status === 302, 'staff created');
  const wd = new Date(futureDay(3)).getUTCDay();
  const day = futureDay(3);
  r = await shop('POST', '/bookings/availability', {
    body: { weekday: String(wd), start: '09:00', end: '12:00', slot_length_minutes: '60' }, follow: false,
  });
  ok(r.status === 302, 'availability rule created');
  r = await shop('GET', '/bookings/availability');
  ok(r.status === 200 && r.text.includes('09:00'), 'availability list shows the rule');

  // Standard flow settings: $50 deposit.
  r = await shop('POST', '/bookings/settings', {
    body: {
      deposit_amount_cents: '5000', cancel_window_hours: '24', slot_hold_minutes: '30',
      deposit_credit_expiry_days: '90', deposit_policy_text: '', booking_instructions: '',
    }, follow: false,
  });
  ok(r.status === 302, 'settings saved');

  // Public booking page + slots JSON.
  r = await cust('GET', `/bookings/shop/${shopId}`);
  ok(r.status === 200 && r.text.includes('Pick a time'), 'booking page renders the slot picker');
  r = await cust('GET', `/bookings/slots?shop_id=${shopId}&from=${day}&to=${day + DAY_MS}`);
  const sj = JSON.parse(r.text);
  ok(r.status === 200 && sj.ok && sj.slots.length === 3, 'slots JSON lists 3 open slots');
  const s0 = sj.slots[0], s1 = sj.slots[1], s2 = sj.slots[2];

  // Hold -> checkout.
  async function holdAndCheckout(client, slot) {
    let h = await client('POST', '/bookings/hold', {
      body: { shop_id: shopId, start_at: String(slot.start_at), end_at: String(slot.end_at) }, follow: false,
    });
    if (!(h.status === 302 && (h.location || '').startsWith('/bookings/checkout/'))) {
      throw new Error('hold failed: ' + h.status + ' ' + h.location);
    }
    return h.location.split('/bookings/checkout/')[1];
  }
  const bookingId = await holdAndCheckout(cust, s0);
  r = await cust('GET', `/bookings/checkout/${bookingId}`);
  ok(r.status === 200 && r.text.includes('Shop receives: $50.00 (100%)'), 'checkout shows the fee breakdown');
  ok(r.text.includes('non-refundable'), 'checkout discloses the non-refundable platform fee');

  // PayPal is unconfigured offline -> fail-safe, no crash; the pending
  // payment row exists, so capture (stubbed) can still run.
  r = await cust('POST', `/bookings/checkout/${bookingId}`, { follow: false });
  ok(r.status === 302 && r.location === `/bookings/checkout/${bookingId}`, 'checkout fails safe when PayPal is off');
  const paymentId = wdb.prepare("SELECT id FROM booking_payments WHERE booking_id = ? AND status = 'pending'").get(bookingId).id;
  ok(!!paymentId, 'pending payment row recorded at checkout');
  // Simulate "customer approved on PayPal": give the pending payment a
  // PayPal order id, then capture (the test stub answers COMPLETED).
  async function capturePayment(client, bId) {
    const pay = wdb.prepare("SELECT id FROM booking_payments WHERE booking_id = ? AND status = 'pending'").get(bId);
    wdb.prepare('UPDATE booking_payments SET paypal_order_id = ? WHERE id = ?').run('TEST-ORDER-' + pay.id, pay.id);
    const cr = await client('POST', '/bookings/capture', { body: { payment_id: pay.id }, follow: false });
    return { res: cr, payId: pay.id };
  }
  const { res: capRes } = await capturePayment(cust, bookingId);
  r = capRes;
  ok(r.status === 302 && r.location === `/bookings/receipt/${bookingId}`, 'capture redirects to the receipt');
  ok(wdb.prepare('SELECT status FROM bookings WHERE id = ?').get(bookingId).status === 'confirmed', 'booking confirmed after capture');
  ok(wdb.prepare("SELECT status FROM booking_payments WHERE id = ?").get(paymentId).status === 'paid', 'payment marked paid');
  const led = wdb.prepare("SELECT amount_cents, status FROM commission_ledger WHERE order_id = ? AND recipient_type = 'shop'").get(bookingId);
  ok(led && led.amount_cents === 5000 && led.status === 'payable', 'shop credited exactly base (payable)');

  // Receipt page + access control.
  r = await cust('GET', `/bookings/receipt/${bookingId}`);
  ok(r.status === 200 && r.text.includes('Shop receives: $50.00 (100%)'), 'receipt page shows the fee lines');
  r = await cust2('GET', `/bookings/receipt/${bookingId}`);
  ok(r.status === 404, 'another customer cannot view the receipt');
  r = await shop('GET', `/bookings/receipt/${bookingId}`);
  ok(r.status === 200, 'shop can view the receipt');

  // Shop manage + no-show.
  r = await shop('GET', '/bookings/manage');
  ok(r.status === 200 && r.text.includes('Upcoming'), 'manage dashboard renders');
  r = await shop('POST', `/bookings/${bookingId}/no-show`, { follow: false });
  ok(r.status === 302, 'no-show posts');
  ok(wdb.prepare('SELECT status FROM bookings WHERE id = ?').get(bookingId).status === 'no_show', 'booking marked no-show');
  ok(wdb.prepare("SELECT status FROM booking_payments WHERE id = ?").get(paymentId).status === 'forfeited', 'no-show forfeits the payment');

  // Cancel inside the window -> base refunded via the PayPal stub.
  const bookingId2 = await holdAndCheckout(cust, s1);
  await cust('POST', `/bookings/checkout/${bookingId2}`, { follow: false });
  const { payId: pay2 } = await capturePayment(cust, bookingId2);
  r = await cust('POST', `/bookings/${bookingId2}/cancel`, { follow: false });
  ok(r.status === 302, 'cancel posts');
  const st2 = wdb.prepare('SELECT status, refunded_cents FROM booking_payments WHERE id = ?').get(pay2);
  ok(st2.status === 'refunded' && st2.refunded_cents === 5000, 'cancel inside window refunds base');
  ok(wdb.prepare('SELECT status FROM bookings WHERE id = ?').get(bookingId2).status === 'cancelled', 'booking canceled');

  // Complete action.
  const bookingId3 = await holdAndCheckout(cust, s2);
  await cust('POST', `/bookings/checkout/${bookingId3}`, { follow: false });
  await capturePayment(cust, bookingId3);
  r = await shop('POST', `/bookings/${bookingId3}/complete`, { follow: false });
  ok(r.status === 302 && wdb.prepare('SELECT status FROM bookings WHERE id = ?').get(bookingId3).status === 'completed',
    'shop can complete a booking');

  // Toggle deposit-first: standard hold now refuses and points at the reversed flow.
  r = await shop('POST', '/bookings/settings', {
    body: { deposit_before_booking: '1', deposit_amount_cents: '5000' }, follow: false,
  });
  ok(r.status === 302, 'deposit-first toggled on');
  r = await cust('POST', '/bookings/hold', {
    body: { shop_id: shopId, start_at: String(s0.start_at), end_at: String(s0.end_at) }, follow: false,
  });
  ok(r.status === 302 && r.location === `/bookings/deposit-first/${shopId}`, 'hold refuses and directs to deposit-first');
  r = await cust('GET', `/bookings/deposit-first/${shopId}`);
  ok(r.status === 200 && r.text.includes('Shop receives: $50.00 (100%)'), 'deposit-first page shows the fee breakdown');
  r = await cust('POST', `/bookings/deposit-first/${shopId}`, { follow: false });
  ok(r.status === 302 && r.location === `/bookings/deposit-first/${shopId}`, 'deposit-first fails safe when PayPal is off');

  // Seed a paid deposit (simulating a completed PayPal capture) and book
  // the slot through the real route.
  const depId = `depp2-${Date.now()}`;
  const df = { base: 5000, platformFee: 250, processing: 241, total: 5491 };
  wdb.prepare(`INSERT INTO booking_deposits
    (id, shop_user_id, customer_user_id, amount_cents, platform_fee_cents, processing_cents, total_cents, status, paypal_capture_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(depId, shopId,
    wdb.prepare('SELECT id FROM users WHERE email = ?').get('httpbookcust@test.local').id,
    df.base, df.platformFee, df.processing, df.total, 'paid', 'C-HTTP1', Date.now());
  // A real capture also writes a receipt with booking_id NULL until the slot
  // is picked; the book route must attach it to the new booking.
  wdb.prepare(`INSERT INTO receipts
    (id, booking_id, kind, lines_json, shop_receives_cents, customer_total_cents, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(`rcpt-${Date.now()}`, null, 'booking_deposit',
    JSON.stringify({ lines: [
      `Shop receives: $${(df.base / 100).toFixed(2)} (100%)`,
      `Platform fee (5%): $${(df.platformFee / 100).toFixed(2)} (non-refundable)`,
      `Processing: $${(df.processing / 100).toFixed(2)}`,
      `Total charged: $${(df.total / 100).toFixed(2)}`,
    ], deposit_id: depId, captured_at: Date.now(), capture_id: 'C-HTTP1' }),
    df.base, df.total, Date.now());
  r = await cust('GET', `/bookings/deposit-first/${depId}/slots`);
  ok(r.status === 200 && r.text.includes('Pick your slot'), 'deposit slot picker renders');
  const sj2 = JSON.parse((await cust('GET', `/bookings/slots?shop_id=${shopId}&from=${day}&to=${day + DAY_MS}`)).text);
  const free = sj2.slots.find((s) => !wdb.prepare('SELECT id FROM bookings WHERE shop_user_id = ? AND start_at = ? AND status IN (?,?)')
    .get(shopId, s.start_at, 'pending_deposit', 'confirmed'));
  r = await cust('POST', `/bookings/deposit-first/${depId}/book`, {
    body: { start_at: String(free.start_at), end_at: String(free.end_at) }, follow: false,
  });
  ok(r.status === 302 && (r.location || '').startsWith('/bookings/receipt/'), 'deposit-first booking confirms');
  const bkId = r.location.split('/bookings/receipt/')[1];
  ok(wdb.prepare('SELECT status FROM bookings WHERE id = ?').get(bkId).status === 'confirmed', 'deposit-first booking is confirmed');
  ok(wdb.prepare('SELECT booking_id FROM booking_deposits WHERE id = ?').get(depId).booking_id === bkId,
    'deposit linked to the booking');
  r = await cust('GET', `/bookings/receipt/${bkId}`);
  ok(r.status === 200 && r.text.includes('Platform fee (5%)') && r.text.includes('non-refundable'),
    'deposit-first receipt page shows the fee lines');

  // "Get this tattooed" picker lists the bookable shop.
  r = await cust('GET', '/bookings/start');
  ok(r.status === 200 && r.text.includes('HttpBookShop'), 'start page lists the bookable shop');
  r = await cust('POST', '/bookings/start', { body: { shop_id: shopId, design_id: 'd123' }, follow: false });
  ok(r.status === 302 && r.location === `/bookings/shop/${shopId}?design_id=d123`, 'start routes to the shop booking page');

  wdb.close();
}

module.exports = { runDbTests, runHttpTests };
