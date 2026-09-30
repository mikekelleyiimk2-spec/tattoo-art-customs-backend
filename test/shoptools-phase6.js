// Phase 6 shop toolset tests: reliability hardening — race safety,
// idempotency, and crash-recovery for bookings, payments, gift cards,
// waitlist, and incentives.
// The coordinator (test/run.js) wires this in; do not run from here.
const db = require('../src/db');
const flow = require('../src/shop/bookingFlow');
const slots = require('../src/shop/bookingSlots');
const incentives = require('../src/shop/shopIncentives');
const waitlist = require('../src/shop/waitlist');
const giftcards = require('../src/shop/giftcards');
const paypal = require('../src/lib/paypal');
const { upsertProfile } = require('../src/lib/profiles');

const DAY_MS = 86400000;

let seq = 0;
const tag = () => `p6-${Date.now()}-${(seq += 1)}`;

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

// A shop with settings + one 09:00-12:00 UTC 60-min rule on `weekday`.
async function mkBookableShop(email, { deposit = 5000, depositFirst = 0, weekday = 2 } = {}) {
  const id = await mkShop(email);
  await flow.saveBookingSettings(id, {
    deposit_before_booking: depositFirst, deposit_amount_cents: deposit,
    cancel_window_hours: 24, slot_hold_minutes: 30, noshow_forfeit_deposit: 1,
    deposit_credit_expiry_days: 90,
  });
  await db.insert('availability_rules', {
    shop_user_id: id, staff_id: null, chair_id: null, weekday,
    start_minutes: 540, end_minutes: 720, slot_length_minutes: 60, active: 1,
  });
  return { id, day: futureDay(weekday) };
}

const fees5000 = { base: 5000, platformFee: 250, processing: 224, total: 5474 };

async function runDbTests(ok) {
  console.log('phase6 reliability (db):');
  const customer = await mkUser(`cust-${tag()}@test.local`);
  const shopA = await mkBookableShop(`shopa-${tag()}@test.local`); // standard flow
  const shopB = await mkBookableShop(`shopb-${tag()}@test.local`, { depositFirst: 1, weekday: 3 }); // deposit-first

  // --- 1. concurrent holds for the same slot: exactly one wins ---
  const open = await slots.getOpenSlots(shopA.id, { fromTs: shopA.day, toTs: shopA.day + DAY_MS });
  const s0 = open[0], s1 = open[1];
  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, () => flow.createPendingBooking({
      shopUserId: shopA.id, customerUserId: customer,
      startAt: s0.start_at, endAt: s0.end_at,
    })));
  const won = attempts.filter((a) => a.status === 'fulfilled');
  const lostSlotTaken = attempts.filter((a) => a.status === 'rejected' && a.reason && a.reason.code === 'SLOT_TAKEN');
  ok(won.length === 1 && lostSlotTaken.length === 4,
    `concurrent holds for one slot: exactly one wins, rest SLOT_TAKEN (won=${won.length})`);
  const bookingId = won[0].value;
  const holdCount = await db.all(
    'SELECT id FROM bookings WHERE shop_user_id = ? AND start_at = ? AND status = ?',
    [shopA.id, s0.start_at, 'pending_deposit']);
  ok(holdCount.length === 1, 'exactly one pending_deposit row exists for the contested slot');

  // --- 2. concurrent confirmBooking: one receipt, one ledger credit ---
  const confirms = await Promise.allSettled([
    flow.confirmBooking(bookingId, { fees: fees5000, captureId: 'C-P6-1' }),
    flow.confirmBooking(bookingId, { fees: fees5000, captureId: 'C-P6-2' }),
  ]);
  const confirmedOk = confirms.filter((c) => c.status === 'fulfilled');
  const alreadyCount = confirmedOk.filter((c) => c.value.already).length;
  ok(confirmedOk.length === 2 && alreadyCount === 1,
    'concurrent confirmBooking: one wins, the other returns already:true');
  ok((await db.all('SELECT id FROM receipts WHERE booking_id = ?', [bookingId])).length === 1,
    'concurrent confirms produce exactly one receipt');
  ok((await db.all("SELECT id FROM commission_ledger WHERE order_id = ? AND commission_type = 'booking'", [bookingId])).length === 1,
    'concurrent confirms produce exactly one shop ledger credit');
  // A plain sequential double-confirm is also idempotent.
  const again = await flow.confirmBooking(bookingId, { fees: fees5000, captureId: 'C-P6-3' });
  ok(again.already === true, 'sequential double confirmBooking returns already:true');

  // --- 3. concurrent creditShopForBase: exactly one ledger row ---
  const refId = `p6-ref-${tag()}`;
  const credits = await Promise.all(
    Array.from({ length: 4 }, () => flow.creditShopForBase({
      shopUserId: shopA.id, baseCents: 1000, refId, commissionType: 'booking',
    })));
  ok(credits.filter((c) => c.already).length === 3,
    'concurrent creditShopForBase: one inserts, three report already:true');
  ok((await db.all('SELECT id FROM commission_ledger WHERE order_id = ?', [refId])).length === 1,
    'exactly one ledger row for the contested refId');

  // --- 4. captureDeposit is race-safe: one receipt, one credit ---
  const { deposit } = await flow.startDepositFirst(shopB.id, customer);
  const caps = await Promise.allSettled([
    flow.captureDeposit(deposit.id, 'C-P6-D1'),
    flow.captureDeposit(deposit.id, 'C-P6-D2'),
  ]);
  const capsOk = caps.filter((c) => c.status === 'fulfilled');
  ok(capsOk.length === 2 && capsOk.filter((c) => c.value.already).length === 1,
    'concurrent captureDeposit: one wins, the other returns already:true');
  ok((await db.all("SELECT id FROM receipts WHERE kind = 'booking_deposit' AND lines_json LIKE ?",
    [`%${deposit.id}%`])).length === 1,
    'concurrent deposit captures produce exactly one receipt');
  ok((await db.all("SELECT id FROM commission_ledger WHERE order_id = ? AND commission_type = 'booking_deposit'",
    [deposit.id])).length === 1,
    'concurrent deposit captures produce exactly one ledger credit');

  // --- 5. bookWithDeposit double-spend: one booking wins ---
  const openB = await slots.getOpenSlots(shopB.id, { fromTs: shopB.day, toTs: shopB.day + DAY_MS });
  const bs0 = openB[0], bs1 = openB[1];
  const spends = await Promise.allSettled([
    flow.bookWithDeposit({ depositId: deposit.id, startAt: bs0.start_at, endAt: bs0.end_at }),
    flow.bookWithDeposit({ depositId: deposit.id, startAt: bs1.start_at, endAt: bs1.end_at }),
  ]);
  const spendsOk = spends.filter((s) => s.status === 'fulfilled');
  const spendsUsed = spends.filter((s) => s.status === 'rejected' && s.reason && s.reason.code === 'DEPOSIT_USED');
  ok(spendsOk.length === 1 && spendsUsed.length === 1,
    'concurrent bookWithDeposit: one booking wins, the other gets DEPOSIT_USED');
  const depBookings = await db.all(
    "SELECT id FROM bookings WHERE id IN (SELECT booking_id FROM booking_deposits WHERE id = ?)",
    [deposit.id]);
  ok(depBookings.length === 1, 'deposit linked to exactly one booking');

  // --- 6. recordBalanceDue double-click: second throws EXISTS ---
  const bal1 = await flow.recordBalanceDue({ bookingId, shopUserId: shopA.id, amountCents: 10000 });
  let balErr = null;
  try {
    await flow.recordBalanceDue({ bookingId, shopUserId: shopA.id, amountCents: 10000 });
  } catch (e) { balErr = e; }
  ok(balErr && balErr.code === 'EXISTS', 'second recordBalanceDue throws EXISTS');
  ok((await db.all("SELECT id FROM booking_payments WHERE booking_id = ? AND kind = 'balance'", [bookingId])).length === 1,
    'exactly one balance payment row after double recordBalanceDue');
  // captureBalancePayment double: one receipt.
  const cb1 = await flow.captureBalancePayment(bal1.paymentId, { captureId: 'C-P6-B1' });
  const cb2 = await flow.captureBalancePayment(bal1.paymentId, { captureId: 'C-P6-B2' });
  ok(!cb1.already && cb2.already === true, 'second captureBalancePayment returns already:true');
  ok((await db.all("SELECT id FROM receipts WHERE booking_id = ? AND kind = 'balance'", [bookingId])).length === 1,
    'concurrent balance captures produce exactly one receipt');

  // --- 7. maybeAwardBookingBonus concurrent: one bonus row ---
  const bonusBuyer = await mkUser(`bonusbuyer-${tag()}@test.local`);
  const bonusShop = await mkShop(`bonusshop-${tag()}@test.local`);
  // Fresh confirmed booking, re-pointed at the bonus shop/buyer.
  const bbOpen = await slots.getOpenSlots(shopA.id, { fromTs: shopA.day, toTs: shopA.day + DAY_MS });
  const bbId = await flow.createPendingBooking({
    shopUserId: shopA.id, customerUserId: bonusBuyer, startAt: bbOpen[1].start_at, endAt: bbOpen[1].end_at,
  });
  await flow.confirmBooking(bbId, { fees: fees5000, captureId: 'C-P6-BB' });
  await db.update('bookings', bbId, { shop_user_id: bonusShop, customer_user_id: bonusBuyer });
  const bbRow2 = await db.get('SELECT * FROM bookings WHERE id = ?', [bbId]);
  const orderId = await db.insert('orders', {
    buyer_id: bonusBuyer, referred_shop_id: bonusShop, status: 'paid',
    paid_at: bbRow2.created_at - 1000, order_type: 'premade',
    amount_cents: 7812, deposit_cents: 0, amount_paid_cents: 7812,
  });
  const bonuses = await Promise.all(
    Array.from({ length: 3 }, () => incentives.maybeAwardBookingBonus(bbRow2)));
  ok(bonuses.filter(Boolean).length === 1, 'concurrent bonus awards: exactly one returns a bonus');
  ok((await db.all("SELECT id FROM commission_ledger WHERE order_id = ? AND commission_type = 'booking_bonus'",
    [orderId])).length === 1,
    'concurrent bonus awards produce exactly one ledger row');

  // --- 8. waitlist: concurrent offers go to different entries; double claim ---
  const wCust1 = await mkUser(`w1-${tag()}@test.local`);
  const wCust2 = await mkUser(`w2-${tag()}@test.local`);
  await waitlist.joinWaitlist({ shopUserId: shopA.id, customerUserId: wCust1, notes: 'p6-1' });
  await waitlist.joinWaitlist({ shopUserId: shopA.id, customerUserId: wCust2, notes: 'p6-2' });
  const [wo1, wo2] = await Promise.all([
    waitlist.offerNextInLine({ shopUserId: shopA.id }),
    waitlist.offerNextInLine({ shopUserId: shopA.id }),
  ]);
  const offeredIds = [wo1, wo2].filter(Boolean).map((o) => o.entryId).sort();
  ok(offeredIds.length === 2 && offeredIds[0] !== offeredIds[1],
    'concurrent offerNextInLine offers two different entries');
  const cl1 = await waitlist.claimOffer({ id: wo1.entryId, customerUserId: wo1.customerUserId });
  const cl2 = await waitlist.claimOffer({ id: wo1.entryId, customerUserId: wo1.customerUserId });
  ok(!cl1.already && cl2.already === true, 'double claimOffer: second returns already:true');

  // --- 9. expireStaleHolds never expires a booking that just got paid ---
  // Lapsed hold (created 2h ago, 30-min hold) still expires normally.
  const lapsedId = await flow.createPendingBooking({
    shopUserId: shopA.id, customerUserId: customer,
    startAt: s1.start_at, endAt: s1.end_at, now: Date.now() - 2 * 3600 * 1000,
  });
  await flow.expireStaleHolds();
  ok((await db.get('SELECT status FROM bookings WHERE id = ?', [lapsedId])).status === 'expired',
    'lapsed hold still expires');
  // Simulate the race: hold selected as pending, then paid before the sweep's
  // UPDATE runs — the conditional update must not clobber the confirmation.
  const racyId = await flow.createPendingBooking({
    shopUserId: shopA.id, customerUserId: customer,
    startAt: s1.start_at, endAt: s1.end_at, now: Date.now() - 2 * 3600 * 1000,
  });
  await flow.confirmBooking(racyId, { fees: fees5000, captureId: 'C-P6-R' });
  const racyUpdate = await db.query(
    "UPDATE bookings SET status = 'expired' WHERE id = ? AND status = 'pending_deposit'", [racyId]);
  ok(racyUpdate.changes === 0, 'expiry UPDATE touches 0 rows once the booking is confirmed');
  ok((await db.get('SELECT status FROM bookings WHERE id = ?', [racyId])).status === 'confirmed',
    'confirmed booking survives a racing expiry sweep');

  // --- 10. gift card: already-captured recovery activates the card ---
  const gcCust = await mkUser(`gc-${tag()}@test.local`);
  const { pendingId } = await giftcards.createPendingGiftCard({
    purchaserUserId: gcCust, amountCents: 5000, recipientEmail: 'r6@test.local',
  });
  const gcFees = giftcards.giftCardFees(5000);
  const realGetOrder = paypal.getCheckoutOrder;
  paypal.getCheckoutOrder = async () => ({
    purchase_units: [{ payments: { captures: [{ id: 'C-REC-6', amount: { value: (gcFees.total / 100).toFixed(2) } }] } }],
  });
  try {
    const res = await giftcards.activateGiftCard({
      pendingId, purchaserUserId: gcCust, paypalOrderId: 'ALREADY-CAPTURED-6',
    });
    ok(res.code && !res.already, 'already-captured recovery activates the gift card');
    ok((await db.get('SELECT status FROM gift_cards WHERE id = ?', [pendingId])).status === 'active',
      'card is active after recovery');
    ok((await db.all('SELECT id FROM receipts WHERE gift_card_id = ?', [pendingId])).length === 1,
      'exactly one gift-card receipt after recovery');
  } finally {
    paypal.getCheckoutOrder = realGetOrder;
  }

  // --- 11. isAlreadyCapturedError unit checks ---
  ok(paypal.isAlreadyCapturedError(new Error('PayPal API POST /v2/checkout/orders/X/capture failed: Order already captured.')) === true,
    'isAlreadyCapturedError detects ORDER_ALREADY_CAPTURED');
  ok(paypal.isAlreadyCapturedError(new Error('PayPal API failed: something else')) === false,
    'isAlreadyCapturedError ignores other errors');
  ok(paypal.isAlreadyCapturedError(null) === false, 'isAlreadyCapturedError handles null');

  // --- 12. db.query exposes affected-row counts ---
  const noMatch = await db.query("UPDATE bookings SET status = 'confirmed' WHERE id = ? AND status = 'nope-never'", [bookingId]);
  ok(noMatch.changes === 0, 'conditional update reports 0 changes when nothing matches');

  // --- 13. slot listing is range-bounded (public endpoint, no DoS) ---
  const far = await slots.getOpenSlots(shopA.id, {
    fromTs: shopA.day, toTs: shopA.day + 365 * DAY_MS,
  });
  const near = await slots.getOpenSlots(shopA.id, {
    fromTs: shopA.day, toTs: shopA.day + 93 * DAY_MS,
  });
  ok(far.length === near.length && far.length > 0,
    `getOpenSlots clamps a 1-year range to the 93-day horizon (${far.length} slots)`);
}

async function runHttpTests(ok, req) {
  console.log('phase6 reliability (http):');
  const Database = require('better-sqlite3');
  const wdb = new Database(process.env.SQLITE_PATH);

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
  const shop = makeClient(), cust = makeClient();

  async function signup(client, name, email) {
    const r = await client('POST', '/signup', {
      body: { display_name: name, email, password: 'password123' }, follow: false,
    });
    return r.status;
  }
  ok(await signup(shop, 'HttpRelShop', 'httprelshop@test.local') === 302, 'shop signup');
  ok(await signup(cust, 'HttpRelCust', 'httprelcust@test.local') === 302, 'customer signup');
  const shopId = wdb.prepare('SELECT id FROM users WHERE email = ?').get('httprelshop@test.local').id;
  const custId = wdb.prepare('SELECT id FROM users WHERE email = ?').get('httprelcust@test.local').id;
  wdb.prepare('UPDATE users SET role = ? WHERE id = ?').run('tattoo_shop', shopId);
  const planId = wdb.prepare("SELECT id FROM plans WHERE slug = 'tattoo_shop'").get().id;
  wdb.prepare('INSERT INTO subscriptions (id, user_id, plan_id, status, created_at) VALUES (?,?,?,?,?)')
    .run(`sub-${shopId}`, shopId, planId, 'active', Date.now());
  wdb.prepare('INSERT INTO shop_profiles (user_id, payout_paypal_email, created_at) VALUES (?,?,?)')
    .run(shopId, 'httprelshop@test.local', Date.now());
  // Shop settings: standard flow, $50 deposit, one weekday rule.
  const now = Date.now();
  const dayMs = 86400000;
  const future = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) + 8 * dayMs);
  const weekday = future.getUTCDay();
  const dayStart = Date.UTC(future.getUTCFullYear(), future.getUTCMonth(), future.getUTCDate());
  wdb.prepare(`INSERT INTO shop_booking_settings
    (shop_user_id, deposit_before_booking, deposit_amount_cents, cancel_window_hours, slot_hold_minutes, noshow_forfeit_deposit, deposit_credit_expiry_days)
    VALUES (?,?,?,?,?,?,?)`)
    .run(shopId, 0, 5000, 24, 30, 1, 90);
  wdb.prepare(`INSERT INTO availability_rules
    (id, shop_user_id, staff_id, chair_id, weekday, start_minutes, end_minutes, slot_length_minutes, active, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(`ar-${shopId}`, shopId, null, null, weekday, 540, 720, 60, 1, now);
  const slotStart = dayStart + 9 * 3600000;
  const slotEnd = slotStart + 3600000;
  // Customer creates a hold directly, then double-POSTs checkout.
  const bookingId = `bk-${shopId}`.slice(0, 32);
  wdb.prepare(`INSERT INTO bookings
    (id, shop_user_id, customer_user_id, start_at, end_at, status, deposit_cents, source, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(bookingId, shopId, custId, slotStart, slotEnd, 'pending_deposit', 5000, 'shop_page', now);

  const r1 = await cust('POST', `/bookings/checkout/${bookingId}`, { follow: false });
  const r2 = await cust('POST', `/bookings/checkout/${bookingId}`, { follow: false });
  const pendingCount = wdb.prepare(
    "SELECT COUNT(*) AS n FROM booking_payments WHERE booking_id = ? AND status = 'pending'").get(bookingId).n;
  ok(pendingCount === 1, `double POST /bookings/checkout/:id creates exactly one pending payment (got ${pendingCount})`);
  // Both POSTs redirect toward PayPal approval (stub order) — no 500s.
  ok([301, 302, 303, 307, 308].includes(r1.status) && [301, 302, 303, 307, 308].includes(r2.status),
    'both checkout POSTs redirect (no server error)');

  wdb.close();
}

module.exports = { runDbTests, runHttpTests };
