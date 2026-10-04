// Phase 7 shop toolkit tests: waivers, aftercare, autofill, blasts,
// reactivation, attribution, no-show holds, payment plans.
// The coordinator (test/run.js) wires this in; do not run from here.
const db = require('../src/db');
const flow = require('../src/shop/bookingFlow');
const slots = require('../src/shop/bookingSlots');
const waivers = require('../src/shop/waivers');
const aftercare = require('../src/shop/aftercare');
const autofill = require('../src/shop/autofill');
const blasts = require('../src/shop/blasts');
const attribution = require('../src/shop/attribution');
const noshow = require('../src/shop/noshow');
const plans = require('../src/shop/plans');
const { upsertProfile } = require('../src/lib/profiles');

const DAY_MS = 86400000;
let seq = 0;
const tag = () => `p7-${Date.now()}-${(seq += 1)}`;

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

async function mkBookableShop(email, { deposit = 5000, weekday = 2 } = {}) {
  const id = await mkShop(email);
  await flow.saveBookingSettings(id, {
    deposit_before_booking: 0, deposit_amount_cents: deposit,
    cancel_window_hours: 24, slot_hold_minutes: 30, noshow_forfeit_deposit: 1,
    deposit_credit_expiry_days: 90, autofill_enabled: 1, autofill_audience: 'waitlist',
    autofill_expiry_minutes: 120, reactivation_enabled: 1, reactivation_lapse_days: 180,
  });
  await db.insert('availability_rules', {
    shop_user_id: id, staff_id: null, chair_id: null, weekday,
    start_minutes: 540, end_minutes: 720, slot_length_minutes: 60, active: 1,
  });
  return { id, day: futureDay(weekday) };
}

const fees5000 = { base: 5000, platformFee: 250, processing: 224, total: 5474 };

async function takeSlot(shopId) {
  const open = await slots.getOpenSlots(shopId, { fromTs: Date.now() + 7 * DAY_MS, toTs: Date.now() + 100 * DAY_MS });
  if (!open.length) throw new Error('no open slots for test shop');
  return open[0].start_at;
}

async function mkConfirmedBooking(shopId, customerId, startAt) {
  const bookingId = await flow.createPendingBooking({
    shopUserId: shopId, customerUserId: customerId,
    startAt, endAt: startAt + 3600000,
  });
  await flow.confirmBooking(bookingId, { kind: 'deposit', fees: fees5000 });
  return bookingId;
}

async function runDbTests(ok) {
  console.log('phase7 shop toolkit (db):');
  const customer = await mkUser(`cust-${tag()}@test.local`);
  const shop = await mkBookableShop(`shop-${tag()}@test.local`);

  // --- 1. waivers: template CRUD + signing + duplicate-sign guard ---
  const wId = await waivers.createWaiver(shop.id, {
    title: 'Standard consent', legalText: 'I consent to being tattooed. This is the shop-supplied waiver text, at least twenty chars.',
  });
  ok(!!wId, 'waiver template created');
  const list = await waivers.getWaiversForShop(shop.id);
  ok(list.length === 1 && list[0].title === 'Standard consent', 'waiver listed for shop');
  const bookingId = await mkConfirmedBooking(shop.id, customer, await takeSlot(shop.id));
  const svg = '<svg>' + 'x'.repeat(60) + '</svg>';
  const { signatureId } = await waivers.signWaiver({
    waiverId: wId, bookingId, customerUserId: customer,
    signerName: 'Test Customer', signatureSvg: svg, idPhotoBuffer: null,
  });
  ok(!!signatureId, 'waiver signed');
  let dupe = null;
  try {
    await waivers.signWaiver({ waiverId: wId, bookingId, customerUserId: customer, signerName: 'Test Customer', signatureSvg: svg });
  } catch (e) { dupe = e; }
  ok(!!dupe, 'duplicate signature rejected');

  // --- 2. waiver crypto round-trip ---
  const cfg = require('../src/config');
  const savedKey = cfg.idDocKey;
  cfg.idDocKey = require('crypto').randomBytes(32).toString('hex');
  const enc = waivers.encryptIdPhoto(Buffer.from('fake-jpeg-bytes'));
  const dec = waivers.decryptIdPhoto(enc);
  ok(dec.toString() === 'fake-jpeg-bytes', 'ID photo AES-256-GCM round-trip');
  cfg.idDocKey = savedKey;

  // --- 3. aftercare: completion schedules 3 check-ins; sweep sends ---
  await flow.markCompleted(bookingId);
  const checkins = await db.all('SELECT * FROM aftercare_checkins WHERE booking_id = ?', [bookingId]);
  ok(checkins.length === 3, `3 aftercare check-ins scheduled (got ${checkins.length})`);
  const sent = await aftercare.runAftercareSweep(Date.now() + 4 * DAY_MS);
  ok(sent >= 1, `aftercare sweep sent due check-ins (${sent})`);
  const responded = await aftercare.respondToCheckin({ checkinId: checkins[0].id, customerUserId: customer, response: 'great' });
  ok(responded.response === 'great', 'check-in response recorded');

  // --- 4. autofill: cancel -> broadcast offer -> claim race ---
  const open2 = await slots.getOpenSlots(shop.id, { fromTs: Date.now() + 7 * DAY_MS, toTs: Date.now() + 100 * DAY_MS });
  const b2 = await mkConfirmedBooking(shop.id, customer, open2[0].start_at);
  await db.insert('waitlist', { shop_user_id: shop.id, customer_user_id: customer, status: 'waiting', created_at: Date.now() });
  await flow.cancelBooking(b2, { now: Date.now() });
  const offers = await db.all("SELECT * FROM slot_offers WHERE shop_user_id = ? AND status = 'open'", [shop.id]);
  ok(offers.length >= 1, `cancel created auto-fill offer (${offers.length})`);
  const offer = offers[0];
  const claimer2 = await mkUser(`claimer2-${tag()}@test.local`);
  const [c1, c2] = await Promise.allSettled([
    autofill.claimOffer({ token: offer.claim_token, customerUserId: customer }),
    autofill.claimOffer({ token: offer.claim_token, customerUserId: claimer2 }),
  ]);
  const winners = [c1, c2].filter((r) => r.status === 'fulfilled' && r.value.won);
  ok(winners.length === 1, `exactly one autofill winner (${winners.length})`);
  const expired = await autofill.expireOffers();
  ok(Number.isInteger(expired), 'autofill expiry sweep runs');

  // --- 5. blasts: rate limit + empty audience guard ---
  const blastShop = await mkBookableShop(`blastshop-${tag()}@test.local`, { weekday: 4 });
  let blastErr = null;
  try { await blasts.sendBlast(blastShop.id, 'Chairs open Friday!'); }
  catch (e) { blastErr = e; }
  ok(!!blastErr, 'blast with no past clients refused');
  // give the shop a past client via a completed booking
  const bc = await mkConfirmedBooking(blastShop.id, customer,
    await takeSlot(blastShop.id));
  await flow.markCompleted(bc);
  const r1 = await blasts.sendBlast(blastShop.id, 'Two chairs open this Friday — book now!');
  ok(r1.sent >= 1, `blast sent (${r1.sent})`);
  await blasts.sendBlast(blastShop.id, 'Second blast this week.');
  let rlErr = null;
  try { await blasts.sendBlast(blastShop.id, 'Third blast — should fail.'); }
  catch (e) { rlErr = e; }
  ok(!!rlErr, '3rd blast in 7 days refused (rate limit)');

  // --- 6. reactivation sweep: nudges lapsed clients, dedups ---
  const nudged = await blasts.runReactivationSweep(Date.now());
  ok(Number.isInteger(nudged), `reactivation sweep runs (${nudged})`);

  // --- 7. attribution: marketplace bookings counted ---
  const ab = await mkConfirmedBooking(shop.id, customer,
    await takeSlot(shop.id));
  await db.query("UPDATE bookings SET attribution_source = 'tac_marketplace', design_id = 'd1' WHERE id = ?", [ab]);
  const stats = await attribution.getAttributionStats(shop.id);
  ok(stats.allTime.bookings >= 1 && stats.allTime.revenueCents >= 5000, 'attribution stats count marketplace bookings + revenue');

  // --- 8. no-show: pure policy engine + hold decision (no charge ever) ---
  const nb = await mkConfirmedBooking(shop.id, customer,
    await takeSlot(shop.id));
  const hold = await noshow.ensureHoldForBooking(await db.get('SELECT * FROM bookings WHERE id = ?', [nb]));
  ok(hold.status === 'authorized', 'deposit hold opened on confirm');
  const d1 = noshow.evaluateForfeit({ status: 'no_show', start_at: Date.now() + DAY_MS }, { noshow_forfeit_deposit: 1, cancel_window_hours: 24 });
  ok(d1.outcome === 'forfeit' && d1.reason === 'no_show', 'no-show => forfeit');
  const d2 = noshow.evaluateForfeit(
    { status: 'cancelled', start_at: Date.now() + 2 * 3600000, cancelled_at: Date.now() },
    { noshow_forfeit_deposit: 1, cancel_window_hours: 24 });
  ok(d2.outcome === 'forfeit' && d2.reason === 'late_cancel', 'late cancel => forfeit');
  const d3 = noshow.evaluateForfeit(
    { status: 'cancelled', start_at: Date.now() + 72 * 3600000, cancelled_at: Date.now() },
    { noshow_forfeit_deposit: 1, cancel_window_hours: 24 });
  ok(d3.outcome === 'release' && d3.reason === 'in_window', 'in-window cancel => release');
  const d4 = noshow.evaluateForfeit({ status: 'no_show' }, { noshow_forfeit_deposit: 0 });
  ok(d4.outcome === 'release', 'policy off => release');
  await noshow.recordHoldDecision(nb, d1);
  const decided = await db.get('SELECT * FROM deposit_holds WHERE booking_id = ?', [nb]);
  ok(decided.decision === 'forfeit' && decided.status === 'authorized',
    'forfeit decided but hold stays authorized (no auto-charge without PayPal/flag)');
  const swept = await noshow.runForfeitureSweep();
  ok(Number.isInteger(swept), 'forfeiture sweep runs without charging');
  const still = await db.get('SELECT status FROM deposit_holds WHERE booking_id = ?', [nb]);
  ok(still.status === 'authorized', 'sweep did not move the hold (no charge attempted)');

  // --- 9. payment plans: even split, remainder on last ---
  const { planId } = await plans.createPlan(shop.id, customer, {
    title: 'Sleeve plan', totalCents: 1000, sessionsCount: 3, firstDueAt: Date.now() + DAY_MS,
  });
  const detail = await plans.getPlanDetail(planId, shop.id, 'shop');
  const amounts = detail.installments.map((i) => i.amount_cents);
  ok(amounts.length === 3 && amounts.reduce((a, b) => a + b, 0) === 1000, `installments sum to total (${amounts.join('+')})`);
  ok(amounts[2] === 334 && amounts[0] === 333, 'remainder pennies on last installment');
  const sweep = await plans.runPlanChargeSweep(Date.now() + 40 * DAY_MS);
  ok(sweep.marked >= 1, `past-due installments marked awaiting PayPal, not charged (${sweep.marked})`);
  const inst = await db.get('SELECT status FROM plan_installments WHERE plan_id = ? AND seq = 1', [planId]);
  ok(inst.status === 'due_awaiting_paypal', 'installment marked due_awaiting_paypal (never charged)');
  await plans.waiveInstallment(planId, 2, shop.id);
  const w2 = await db.get('SELECT status FROM plan_installments WHERE plan_id = ? AND seq = 2', [planId]);
  ok(w2.status === 'waived', 'installment waived');
}

async function runHttpTests(ok, req) {
  console.log('phase7 shop toolkit (http):');
  const Database = require('better-sqlite3');
  const wdb = new Database(process.env.SQLITE_PATH);

  function makeClient() {
    const jar = {};
    return async function creq(method, p, { body, follow = true } = {}) {
      const h = {};
      const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) h.cookie = cookies;
      let payload;
      if (body && typeof body === 'object') {
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
  const shop = makeClient();
  const anon = makeClient();

  const sEmail = `tkshop-${tag()}@test.local`;
  let r = await shop('POST', '/signup', {
    body: { display_name: 'TkShop', email: sEmail, password: 'password123' }, follow: false,
  });
  ok(r.status === 302, 'toolkit shop signup');
  const shopId = wdb.prepare('SELECT id FROM users WHERE email = ?').get(sEmail).id;
  wdb.prepare('UPDATE users SET role = ? WHERE id = ?').run('tattoo_shop', shopId);
  const planId = wdb.prepare("SELECT id FROM plans WHERE slug = 'tattoo_shop'").get().id;
  wdb.prepare('INSERT INTO subscriptions (id, user_id, plan_id, status, created_at) VALUES (?,?,?,?,?)')
    .run(`sub-${shopId}`, shopId, planId, 'active', Date.now());

  const shopPaths = ['/toolkit/waivers', '/toolkit/aftercare', '/toolkit/autofill', '/toolkit/blasts', '/toolkit/healed', '/toolkit/noshow', '/toolkit/plans'];
  for (const p of shopPaths) {
    r = await shop('GET', p);
    ok(r.status === 200, `shop GET ${p} -> 200 (got ${r.status})`);
  }
  // Anonymous users get bounced to login.
  r = await anon('GET', '/toolkit/waivers', { follow: false });
  ok([301, 302, 303].includes(r.status), 'anon toolkit access redirects to login');
  // Unknown check-in -> 404 even for logged-in users.
  r = await shop('GET', '/toolkit/aftercare/r/does-not-exist');
  ok(r.status === 404, 'unknown check-in -> 404');
  // Waiver create round-trip.
  r = await shop('POST', '/toolkit/waivers', {
    body: { website: '', title: 'HTTP waiver', legal_text: 'Shop-supplied waiver text, more than twenty characters long.' },
    follow: false,
  });
  ok(r.status === 302 && r.location === '/toolkit/waivers', 'POST /toolkit/waivers creates + redirects');
  r = await shop('GET', '/toolkit/waivers');
  ok(r.status === 200 && r.text.includes('HTTP waiver'), 'new waiver appears in list');
  // Blast validation (no past clients -> friendly error, still 302).
  r = await shop('POST', '/toolkit/blasts', { body: { website: '', message: 'Chairs open Friday!' }, follow: false });
  ok(r.status === 302, 'POST /toolkit/blasts redirects (empty audience is a friendly error)');
  wdb.close();
}

module.exports = { runDbTests, runHttpTests };
