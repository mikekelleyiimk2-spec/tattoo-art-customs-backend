// Phase 3 shop toolset tests: gift cards, intake forms, waitlist, booking
// reminders, flash events.
// The coordinator (test/run.js) wires this in; do not run from here.
//
//   await require('./shoptools-phase3').runDbTests(ok);      // before db.close()
//   await require('./shoptools-phase3').runHttpTests(ok, req); // HTTP phase
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const P3 = {}; // shared ids between the DB phase and the HTTP phase

async function mkUser(email, role, password) {
  const id = await db.insert('users', {
    email, password_hash: await bcrypt.hash(password || 'P3Test123!', 10),
    role, display_name: email.split('@')[0],
  });
  return id;
}

async function mkBooking(customerId, shopId, overrides = {}) {
  const now = Date.now();
  return db.insert('bookings', {
    shop_user_id: shopId, customer_user_id: customerId, staff_id: null, chair_id: null,
    start_at: now + 48 * 3600 * 1000, end_at: now + 49 * 3600 * 1000,
    status: 'confirmed', deposit_cents: 0, source: 'shop_page',
    design_id: null, intake_form_id: null, cancelled_at: null, completed_at: null,
    ...overrides,
  });
}

// Build a pending gift card through the real purchase path (PayPal stub).
async function buyCard(lib, { purchaser, amountCents, recipientEmail, shopUserId }) {
  const { pendingId, approveUrl, fees } = await lib.createPendingGiftCard({
    purchaserUserId: purchaser, amountCents, recipientEmail, shopUserId,
  });
  const token = String(approveUrl).split('token=')[1];
  if (!token) throw new Error('approve URL missing stub token');
  await lib.activateGiftCard({ pendingId, purchaserUserId: purchaser, paypalOrderId: token });
  return { pendingId, fees, code: (await db.get('SELECT code FROM gift_cards WHERE id = ?', [pendingId])).code };
}

async function runDbTests(ok) {
  console.log('phase3 gift cards:');
  const gc = require('../src/shop/giftcards');
  const { computeBookingFees } = require('../src/shop/bookingFees');

  P3.cust1 = await mkUser('p3cust1@test.local', 'customer');
  P3.cust2 = await mkUser('p3cust2@test.local', 'customer');
  P3.cust3 = await mkUser('p3cust3@test.local', 'customer');
  P3.cust4 = await mkUser('p3cust4@test.local', 'customer');
  P3.shop = await mkUser('p3shop@test.local', 'tattoo_shop');
  P3.shop2 = await mkUser('p3shop2@test.local', 'tattoo_shop');
  const shopPlan = (await db.get("SELECT id FROM plans WHERE slug = 'tattoo_shop'")).id;
  await db.insert('subscriptions', {
    user_id: P3.shop, plan_id: shopPlan, status: 'active',
    current_period_end: Date.now() + 30 * 86400000,
  });

  // Buyer total = amount + 5% platform fee + grossed-up processing.
  const fees = gc.giftCardFees(5000);
  const expect = computeBookingFees(5000);
  ok(fees.total === 5491 && fees.platformFee === 250 && fees.processing === 241, 'gift card fee math: $50 -> $54.91 total');
  ok(fees.total === fees.base + fees.platformFee + fees.processing, 'buyer total = amount + 5% + processing');
  ok(JSON.stringify(fees) === JSON.stringify(expect), 'gift card fees identical to computeBookingFees');
  const lines = gc.giftCardReceiptLines(fees);
  ok(lines.length === 5 && lines[3] === 'Total charged: $54.91', 'gift card receipt lines');

  // Code uniqueness across many generations.
  const codes = new Set();
  for (let i = 0; i < 200; i++) codes.add(await gc.generateUniqueCode());
  ok(codes.size === 200, '200 generated codes are all unique');
  ok([...codes].every((c) => /^[A-Z2-9]{12}$/.test(c)), 'code format: 12 uppercase unambiguous chars');

  // Full purchase path: pending -> capture -> active + receipt + emails.
  const bought = await buyCard(gc, { purchaser: P3.cust1, amountCents: 5000, recipientEmail: 'pal@test.local' });
  const row = await db.get('SELECT * FROM gift_cards WHERE id = ?', [bought.pendingId]);
  ok(row.status === 'active' && row.total_paid_cents === 5491, 'capture activates the card with the fee-inclusive total');
  const receipt = await db.get("SELECT * FROM receipts WHERE gift_card_id = ? AND kind = 'gift_card'", [bought.pendingId]);
  ok(receipt && receipt.shop_receives_cents === 0 && receipt.customer_total_cents === 5491,
    'receipt recorded: shop receives $0 until redemption');
  const mailed = await db.get(
    "SELECT id FROM notifications WHERE user_id = ? AND kind = 'gift-card-purchased'", [P3.cust1]);
  ok(!!mailed, 'purchaser notified of the new gift card');

  // Redemption: fee-free, full amount applies.
  P3.bGiftDb = await mkBooking(P3.cust1, P3.shop);
  const red = await gc.redeemGiftCard({ code: bought.code, bookingId: P3.bGiftDb, customerUserId: P3.cust1 });
  ok(red.amount_cents === 5000, 'redeem returns the full amount fee-free');
  const after = await db.get('SELECT status, redeemed_booking_id FROM gift_cards WHERE id = ?', [bought.pendingId]);
  ok(after.status === 'redeemed' && after.redeemed_booking_id === P3.bGiftDb, 'card marked redeemed against the booking');

  // Double-redeem rejected.
  let threw = false;
  try { await gc.redeemGiftCard({ code: bought.code, bookingId: P3.bGiftDb, customerUserId: P3.cust1 }); }
  catch (e) { threw = /already been used/.test(e.message); }
  ok(threw, 'double-redeem rejected');

  // Expired rejected.
  const exp = await buyCard(gc, { purchaser: P3.cust1, amountCents: 2500 });
  await db.update('gift_cards', exp.pendingId, { expires_at: Date.now() - 1000 });
  P3.bGiftDb2 = await mkBooking(P3.cust1, P3.shop);
  threw = false;
  try { await gc.redeemGiftCard({ code: exp.code, bookingId: P3.bGiftDb2, customerUserId: P3.cust1 }); }
  catch (e) { threw = /expired/.test(e.message); }
  ok(threw, 'expired card rejected');

  // Shop-scoped card only works at its shop.
  const scoped = await buyCard(gc, { purchaser: P3.cust1, amountCents: 2500, shopUserId: P3.shop });
  P3.bGiftDb3 = await mkBooking(P3.cust1, P3.shop2);
  threw = false;
  try { await gc.redeemGiftCard({ code: scoped.code, bookingId: P3.bGiftDb3, customerUserId: P3.cust1 }); }
  catch (e) { threw = /only redeemable/.test(e.message); }
  ok(threw, 'shop-scoped card rejected at a different shop');

  // Only the booking's customer can redeem.
  const other = await buyCard(gc, { purchaser: P3.cust1, amountCents: 2500 });
  threw = false;
  try { await gc.redeemGiftCard({ code: other.code, bookingId: P3.bGiftDb2, customerUserId: P3.cust2 }); }
  catch (e) { threw = /not yours/.test(e.message); }
  ok(threw, "another customer's booking rejected");

  // Custom amounts: allowed range ok, out of range rejected.
  const custom = await buyCard(gc, { purchaser: P3.cust1, amountCents: 3333 });
  ok((await db.get('SELECT amount_cents FROM gift_cards WHERE id = ?', [custom.pendingId])).amount_cents === 3333,
    'custom amount within range accepted');
  threw = false;
  try { await gc.createPendingGiftCard({ purchaserUserId: P3.cust1, amountCents: 50 }); }
  catch (e) { threw = true; }
  ok(threw, 'custom amount below minimum rejected');

  console.log('phase3 intake forms:');
  const intakeLib = require('../src/shop/intake');
  P3.bIntake = await mkBooking(P3.cust1, P3.shop);
  const tmp1 = path.join(os.tmpdir(), 'p3photo1.jpg');
  const tmp2 = path.join(os.tmpdir(), 'p3photo2.jpg');
  fs.writeFileSync(tmp1, 'fakeimg1');
  fs.writeFileSync(tmp2, 'fakeimg2');
  const s1 = await intakeLib.saveIntake({
    bookingId: P3.bIntake, customerUserId: P3.cust1,
    fields: { placement: 'left forearm', size_text: '4 inches', cover_up: '1', details: 'blackwork rose' },
    files: [{ path: tmp1, originalname: 'rose.jpg' }],
  });
  ok(!s1.flagged, 'clean intake saves unflagged');
  let form = await intakeLib.getIntakeForBooking(P3.bIntake);
  ok(form && form.placement === 'left forearm' && form.cover_up === 1, 'intake fields persisted');
  ok(JSON.parse(form.reference_photos_json).length === 1, 'reference photo stored');
  // Upsert: second save updates the same row and merges photos.
  await intakeLib.saveIntake({
    bookingId: P3.bIntake, customerUserId: P3.cust1,
    fields: { placement: 'right forearm', details: 'email me at bob@example.com' },
    files: [{ path: tmp2, originalname: 'rose2.jpg' }],
  });
  const count = await db.get('SELECT COUNT(*) AS n FROM intake_forms WHERE booking_id = ?', [P3.bIntake]);
  form = await intakeLib.getIntakeForBooking(P3.bIntake);
  ok(count.n === 1 && form.placement === 'right forearm', 'intake upsert: one row per booking, fields updated');
  ok(JSON.parse(form.reference_photos_json).length === 2, 'photos merge up to the cap');
  const flagged = await db.get("SELECT id FROM review_queue WHERE item_type = 'intake' AND status = 'open'");
  ok(!!flagged, 'contact info in intake details opens admin review but keeps the form');
  // Non-owner cannot save.
  threw = false;
  try {
    await intakeLib.saveIntake({ bookingId: P3.bIntake, customerUserId: P3.cust2, fields: {}, files: [] });
  } catch (e) { threw = /not yours/.test(e.message); }
  ok(threw, "another customer cannot save to someone else's booking");

  console.log('phase3 waitlist:');
  const wl = require('../src/shop/waitlist');
  const w1 = await wl.joinWaitlist({ shopUserId: P3.shop, staffId: null, customerUserId: P3.cust1, notes: 'flexible' });
  ok(!!w1, 'customer joins the waitlist');
  threw = false;
  try { await wl.joinWaitlist({ shopUserId: P3.shop, staffId: null, customerUserId: P3.cust1, notes: '' }); }
  catch (e) { threw = /already/.test(e.message); }
  ok(threw, 'duplicate waitlist join rejected');
  const slotStart = Date.now() + 72 * 3600 * 1000;
  const offered = await wl.offerNextInLine({
    shopUserId: P3.shop, staffId: null, startAt: slotStart, endAt: slotStart + 3600 * 1000,
  });
  ok(offered && offered.entryId === w1, 'first in line gets the offer');
  const wrow = await db.get('SELECT status, offer_expires_at FROM waitlist WHERE id = ?', [w1]);
  ok(wrow.status === 'offered' && Math.abs(wrow.offer_expires_at - (Date.now() + 24 * 3600 * 1000)) < 60000,
    'offer expires ~24h out');
  const offerNote = await db.get(
    "SELECT id FROM notifications WHERE user_id = ? AND kind = 'waitlist-offer'", [P3.cust1]);
  ok(!!offerNote, 'offered customer notified');
  const claimed = await wl.claimOffer({ id: w1, customerUserId: P3.cust1, startAt: slotStart, endAt: slotStart + 3600 * 1000 });
  ok(!claimed.already && claimed.startAt === slotStart, 'claim returns the slot info for booking');
  ok((await db.get('SELECT status FROM waitlist WHERE id = ?', [w1])).status === 'claimed', 'entry marked claimed');
  // Expiry chain: cust2 offered -> expires -> cust3 offered automatically.
  const w2 = await wl.joinWaitlist({ shopUserId: P3.shop, staffId: null, customerUserId: P3.cust2, notes: '' });
  const w3 = await wl.joinWaitlist({ shopUserId: P3.shop, staffId: null, customerUserId: P3.cust3, notes: '' });
  await wl.offerNextInLine({ shopUserId: P3.shop });
  await db.update('waitlist', w2, { offer_expires_at: Date.now() - 1000 });
  const expired = await wl.expireOffers();
  ok(expired.length === 1 && expired[0].expiredId === w2, 'stale offer expires');
  ok((await db.get('SELECT status FROM waitlist WHERE id = ?', [w2])).status === 'expired', 'expired status set');
  ok((await db.get('SELECT status FROM waitlist WHERE id = ?', [w3])).status === 'offered',
    'next in line auto-offered after expiry');
  threw = false;
  try { await wl.claimOffer({ id: w2, customerUserId: P3.cust2 }); }
  catch (e) { threw = /no longer available|expired/.test(e.message); }
  ok(threw, 'claiming an expired offer rejected');
  const shopList = await wl.getWaitlistForShop(P3.shop);
  ok(shopList.length === 3, 'shop sees all waitlist entries');
  const mine = await wl.getWaitlistForCustomer(P3.cust1);
  ok(mine.length === 1 && mine[0].shop_name, 'customer sees own entries with shop name');

  console.log('phase3 booking reminders:');
  const rem = require('../src/shop/bookingReminders');
  const now = Date.now();
  P3.bRemDay = await mkBooking(P3.cust1, P3.shop, { start_at: now + 24 * 3600 * 1000, end_at: now + 25 * 3600 * 1000 });
  P3.bRemDayOf = await mkBooking(P3.cust1, P3.shop, { start_at: now + 2 * 3600 * 1000, end_at: now + 3 * 3600 * 1000 });
  P3.bRemAfter = await mkBooking(P3.cust1, P3.shop, {
    start_at: now - 4 * 24 * 3600 * 1000, end_at: now - 4 * 24 * 3600 * 1000 + 3600 * 1000,
    status: 'completed', completed_at: now - 72 * 3600 * 1000,
  });
  ok(await rem.sendBookingConfirmation(P3.bRemDay) === true, 'booking confirmation sent');
  ok(await rem.sendBookingConfirmation(P3.bRemDay) === false, 'confirmation not duplicated');
  const conf = await db.get(
    "SELECT kind, link FROM notifications WHERE user_id = ? AND kind = 'booking-confirmation'", [P3.cust1]);
  ok(conf && conf.link === `/journal#booking-${P3.bRemDay}`, 'confirmation dedup key = kind + link');
  const sweep1 = await rem.runReminderSweep();
  ok(sweep1.dayBefore === 1 && sweep1.dayOf === 1 && sweep1.aftercare === 1, 'sweep sends all three reminder kinds');
  const kinds = await db.all(
    "SELECT kind FROM notifications WHERE user_id = ? AND kind LIKE 'reminder-%' OR kind = 'aftercare-checkin'",
    [P3.cust1]);
  ok(kinds.some((k) => k.kind === 'reminder-day-before') && kinds.some((k) => k.kind === 'reminder-day-of'),
    'day-before and day-of reminders recorded');
  ok(kinds.some((k) => k.kind === 'aftercare-checkin'), 'aftercare check-in recorded');
  const before = await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', [P3.cust1]);
  const sweep2 = await rem.runReminderSweep();
  const afterCount = await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', [P3.cust1]);
  ok(sweep2.dayBefore === 0 && sweep2.dayOf === 0 && sweep2.aftercare === 0 && before.n === afterCount.n,
    'second sweep sends nothing (dedup via notifications)');

  console.log('phase3 flash events:');
  const ev = require('../src/lib/events');
  const eid = await ev.createEvent({
    shopUserId: P3.shop, title: 'Friday the 13th Flash', description: '$50 flash',
    startsAt: Date.now() + 7 * 24 * 3600 * 1000, endsAt: null, cap: 2,
  });
  ok(!!eid, 'shop creates an event');
  await ev.signupForEvent({ eventId: eid, customerUserId: P3.cust1 });
  await ev.signupForEvent({ eventId: eid, customerUserId: P3.cust2 });
  threw = false;
  try { await ev.signupForEvent({ eventId: eid, customerUserId: P3.cust3 }); }
  catch (e) { threw = /full/.test(e.message); }
  ok(threw, 'cap enforced: third signup rejected');
  threw = false;
  try { await ev.signupForEvent({ eventId: eid, customerUserId: P3.cust1 }); }
  catch (e) { threw = /already signed up/.test(e.message); }
  ok(threw, 'duplicate signup rejected');
  await ev.leaveEvent({ eventId: eid, customerUserId: P3.cust1 });
  await ev.signupForEvent({ eventId: eid, customerUserId: P3.cust3 });
  const cnt = await db.get("SELECT COUNT(*) AS n FROM event_signups WHERE event_id = ? AND status = 'signed_up'", [eid]);
  ok(cnt.n === 2, 'leaving frees the spot for someone else');
  const upcoming = await ev.getUpcomingEvents(P3.cust4);
  ok(upcoming.some((e) => e.id === eid) && upcoming.find((e) => e.id === eid).signup_count === 2,
    'upcoming events list shows signup counts');
  await ev.closeEvent({ eventId: eid, shopUserId: P3.shop });
  threw = false;
  try { await ev.signupForEvent({ eventId: eid, customerUserId: P3.cust4 }); }
  catch (e) { threw = /not open/.test(e.message); }
  ok(threw, 'closed event rejects signups');
  P3.eventId = eid;
  P3.bGiftHttp = await mkBooking(P3.cust1, P3.shop);
}

async function runHttpTests(ok, req) {
  console.log('phase3 http:');
  const Database = require('better-sqlite3');
  const sdb = new Database(process.env.SQLITE_PATH);
  const PORT = process.env.P3_TEST_PORT || 4137;

  // Per-user cookie jars (the shared `req` jar is left alone).
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
    const r = await j('POST', '/login', { body: { email, password: 'P3Test123!' }, follow: false });
    ok(r.status === 302 && (r.location || '').includes('/account'), `login ok for ${email}`);
  }

  const cust = makeJar(), cust4 = makeJar(), shop = makeJar(), anon = makeJar();
  await login(cust, 'p3cust1@test.local');
  await login(cust4, 'p3cust4@test.local');
  await login(shop, 'p3shop@test.local');

  // --- Gift cards over HTTP ---
  let r = await anon('GET', '/giftcards/buy', { follow: false });
  ok(r.status === 302 && (r.location || '').includes('/login'), 'anonymous buy page redirects to login');
  r = await cust('GET', '/giftcards/buy');
  ok(r.status === 200 && r.text.includes('Buy a Gift Card') && r.text.includes('$100'), 'buy page renders amount picker');
  r = await cust('POST', '/giftcards/buy', { body: { preset: '5000', recipient_email: '' }, follow: false });
  ok(r.status === 302 && (r.location || '').includes('paypal.test/approve/stub?token=GC-ORDER-STUB-'),
    'buy redirects to PayPal approval with stub token');
  const token = r.location.split('token=')[1];
  const pending = sdb.prepare(
    "SELECT id FROM gift_cards WHERE purchaser_user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
    .get(P3.cust1);
  ok(!!pending, 'pending gift card row created');
  r = await cust('GET', `/giftcards/capture/${pending.id}?token=${token}`);
  const activeRow = sdb.prepare('SELECT code, status, amount_cents FROM gift_cards WHERE id = ?').get(pending.id);
  ok(r.status === 200 && activeRow.status === 'active' && r.text.includes(activeRow.code),
    'capture activates the card and shows the code');
  r = await cust('POST', '/giftcards/redeem', {
    body: { code: activeRow.code.toLowerCase(), booking_id: P3.bGiftHttp }, follow: false,
  });
  ok(r.status === 302, 'redeem posts (lowercase code normalized)');
  ok(sdb.prepare('SELECT status FROM gift_cards WHERE id = ?').get(pending.id).status === 'redeemed',
    'card redeemed via HTTP');
  r = await shop('GET', '/giftcards/shop');
  ok(r.status === 200 && r.text.includes('Gift Card Sales'), 'shop gift-card sales page loads');

  // --- Intake over HTTP ---
  r = await cust('GET', `/intake/${P3.bIntake}`);
  ok(r.status === 200 && r.text.includes('Intake Form'), 'customer intake form loads');
  r = await cust('POST', `/intake/${P3.bIntake}`, {
    body: { placement: 'upper arm', size_text: '5 inches', details: 'http test details' }, follow: false,
  });
  ok(r.status === 302, 'intake form posts');
  ok(sdb.prepare('SELECT placement FROM intake_forms WHERE booking_id = ?').get(P3.bIntake).placement === 'upper arm',
    'intake fields updated via HTTP');
  r = await shop('GET', `/intake/view/${P3.bIntake}`);
  ok(r.status === 200 && r.text.includes('p3cust1'), 'shop views the intake form');
  r = await cust4('GET', `/intake/view/${P3.bIntake}`);
  ok(r.status === 403, "non-owning customer cannot view the intake form");

  // --- Waitlist over HTTP ---
  r = await cust('POST', '/waitlist/join', { body: { shop_user_id: P3.shop, notes: 'http join' }, follow: false });
  ok(r.status === 302, 'waitlist join posts');
  r = await cust('GET', '/waitlist/mine');
  ok(r.status === 200 && r.text.includes('p3shop'), 'customer waitlist page shows the shop');
  r = await shop('GET', '/waitlist/list');
  ok(r.status === 200 && r.text.includes('Waitlist') && r.text.includes('p3cust1'), 'shop waitlist page loads');

  // --- Events over HTTP ---
  const future = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString().slice(0, 16);
  r = await shop('POST', '/events/create', {
    body: { title: 'HTTP Flash Night', description: 'test', starts_at: future, cap: '2' }, follow: false,
  });
  ok(r.status === 302, 'shop creates an event');
  const hev = sdb.prepare('SELECT id FROM shop_events WHERE shop_user_id = ? ORDER BY created_at DESC LIMIT 1').get(P3.shop);
  r = await cust('GET', '/events');
  ok(r.status === 200 && r.text.includes('HTTP Flash Night'), 'upcoming events list the new event');
  r = await cust('POST', `/events/${hev.id}/signup`, { follow: false });
  ok(r.status === 302, 'customer signs up');
  r = await cust4('POST', `/events/${hev.id}/signup`, { follow: false });
  ok(r.status === 302, 'second customer signs up (cap 2)');
  const cust2jar = makeJar();
  await login(cust2jar, 'p3cust2@test.local');
  r = await cust2jar('POST', `/events/${hev.id}/signup`, { follow: false });
  const fullCount = sdb.prepare("SELECT COUNT(*) AS n FROM event_signups WHERE event_id = ? AND status = 'signed_up'").get(hev.id).n;
  ok(r.status === 302 && fullCount === 2, 'cap enforced over HTTP: third signup blocked');
  r = await shop('GET', '/events/manage');
  ok(r.status === 200 && r.text.includes('HTTP Flash Night'), 'shop manage page lists the event');
  r = await shop('GET', `/events/manage/${hev.id}`);
  ok(r.status === 200 && r.text.includes('p3cust1'), 'attendee list shows signups');

  sdb.close();
}

module.exports = { runDbTests, runHttpTests };
