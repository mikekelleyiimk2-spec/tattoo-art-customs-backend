// Phase 8 shop toolset: client profiles CRM + review request automation.
// The coordinator (test/run.js) wires this in; do not run from here.
//
// Review asks are deduped across sources: the aftercare 'great' ask
// (aftercare.js maybeAskReview, tracked via aftercare_checkins.review_requested_at)
// and this module's unified log (shop_review_requests, UNIQUE booking_id).
// A customer must never be asked twice for one booking.
const db = require('../src/db');
const clients = require('../src/shop/clients');
const reviews = require('../src/shop/reviewRequests');

const DAY_MS = 86400000;
let seq = 0;
const tag = () => `p8-${Date.now()}-${(seq += 1)}`;

async function mkUser(email, role = 'customer') {
  return db.insert('users', { email, password_hash: 'x', role, display_name: email.split('@')[0] });
}

async function mkShop(email) {
  const id = await mkUser(email, 'tattoo_shop');
  const plan = await db.get("SELECT id FROM plans WHERE slug = 'tattoo_shop'");
  await db.insert('subscriptions', { user_id: id, plan_id: plan.id, status: 'active' });
  return id;
}

async function mkCompletedBooking(shopId, customerId, daysAgo) {
  return db.insert('bookings', {
    shop_user_id: shopId, customer_user_id: customerId,
    start_at: Date.now() - daysAgo * DAY_MS, end_at: Date.now() - daysAgo * DAY_MS + 3600000,
    status: 'completed', completed_at: Date.now() - daysAgo * DAY_MS,
  });
}

async function runDbTests(ok) {
  console.log('phase8 client profiles + review requests (db):');
  const mail = require('../src/lib/mail');
  let mailSent = 0;
  mail.__setTransporter({ sendMail: async () => { mailSent += 1; return { messageId: 'stub-p8' }; } });
  try {
    const shop = await mkShop(`p8shop-${tag()}@test.local`);
    const shop2 = await mkShop(`p8shop2-${tag()}@test.local`);
    const cust = await mkUser(`p8cust-${tag()}@test.local`);

    // --- Clients CRM ---
    let threw = false;
    try { await clients.createClient(shop, { name: '  ' }); } catch (e) { threw = true; }
    ok(threw, 'createClient rejects a blank name');
    const cid = await clients.createClient(shop, {
      name: 'Jane Ink', email: 'jane@test.local', phone: '555-0100',
      allergies: 'Latex', notes: 'Prefers blackwork.',
    });
    ok(typeof cid === 'string' && cid.length > 0, 'createClient returns a TEXT id');
    const list = await clients.getClients(shop);
    ok(list.length === 1 && list[0].name === 'Jane Ink' && list[0].email === 'jane@test.local',
      'getClients returns the shop client');
    ok(!(await clients.getClients(shop2)).length, 'other shop sees none of this shop\'s clients');
    ok(await clients.getClient(cid, shop2) === null, 'other shop cannot open the client');

    await clients.updateClient(cid, shop, { name: 'Jane Inked', email: '', phone: '', allergies: '', notes: 'Updated.' });
    const updated = await clients.getClient(cid, shop);
    ok(updated.name === 'Jane Inked' && updated.email === null && updated.notes === 'Updated.',
      'updateClient saves changes');
    threw = false;
    try { await clients.updateClient(cid, shop2, { name: 'Hijack' }); } catch (e) { threw = true; }
    ok(threw, 'other shop cannot update the client');

    const booking = await mkCompletedBooking(shop, cust, 10);
    const otherBooking = await mkCompletedBooking(shop2, cust, 10);
    await clients.addTattoo(cid, shop, {
      description: 'Koi sleeve', placement: 'Left forearm', date_done: '2026-09-20',
      artist_name: 'Mike', aftercare_notes: 'Keep wrapped 2 days.', booking_id: booking,
    });
    await clients.addTattoo(cid, shop, {
      description: 'Rose', placement: 'Shoulder', booking_id: otherBooking, // not this shop's — must drop
    });
    const detail = await clients.getClient(cid, shop);
    ok(detail.tattoos.length === 2, 'two tattoos on the client');
    const koi = detail.tattoos.find((t) => t.description === 'Koi sleeve');
    const rose = detail.tattoos.find((t) => t.description === 'Rose');
    ok(koi && koi.booking_id === String(booking), 'own booking links');
    ok(rose && rose.booking_id === null, 'foreign booking link is dropped');
    threw = false;
    try { await clients.addTattoo(cid, shop, { description: '   ' }); } catch (e) { threw = true; }
    ok(threw, 'addTattoo rejects a blank description');

    await clients.deleteClient(cid, shop);
    ok(!(await clients.getClients(shop)).length, 'client deleted');
    const orphans = await db.all('SELECT id FROM shop_client_tattoos WHERE client_id = ?', [cid]);
    ok(orphans.length === 0, 'tattoo history deleted with the client');

    // --- Review requests ---
    const b1 = await mkCompletedBooking(shop, cust, 2);
    threw = false;
    try { await reviews.sendReviewRequest({ shopUserId: shop, bookingId: b1 }); } catch (e) { threw = true; }
    ok(threw, 'sendReviewRequest throws before a review URL is set');
    await reviews.saveSettings(shop, { googleReviewUrl: 'https://g.page/shop/review', enabled: true });
    const s = await reviews.getSettings(shop);
    ok(s && s.google_review_url === 'https://g.page/shop/review' && Number(s.enabled) === 1,
      'review settings saved to the shared 051 settings row (enabled column)');

    const r1 = await reviews.sendReviewRequest({ shopUserId: shop, bookingId: b1 });
    ok(r1.already === false && mailSent === 1, 'manual send emails the customer once');
    const r2 = await reviews.sendReviewRequest({ shopUserId: shop, bookingId: b1 });
    ok(r2.already === true && r2.by === 'manual' && mailSent === 1,
      'second send for the same booking is deduped (no duplicate email)');
    const logRow = await db.get('SELECT * FROM shop_review_requests WHERE booking_id = ?', [String(b1)]);
    ok(logRow && logRow.source === 'manual' && Number(logRow.clicked) === 0, 'sent log records the manual ask');

    // The aftercare 'great' ask blocks any further ask for that booking.
    const b2 = await mkCompletedBooking(shop, cust, 3);
    await db.insert('aftercare_checkins', {
      booking_id: String(b2), shop_user_id: shop, customer_user_id: cust,
      kind: 'day3', due_at: Date.now() - DAY_MS, status: 'responded',
      response: 'great', review_requested_at: Date.now(),
    });
    const r3 = await reviews.sendReviewRequest({ shopUserId: shop, bookingId: b2 });
    ok(r3.already === true && r3.by === 'aftercare' && mailSent === 1,
      'no double-ask after the aftercare great-response ask');
    ok(!(await reviews.getEligibleBookings(shop)).some((b) => String(b.id) === String(b2)),
      'aftercare-asked booking is not listed as eligible');

    // Auto-send sweep: only enabled shops, only the 24h–7d window, never the
    // aftercare-asked booking, one ask per booking.
    const b3 = await mkCompletedBooking(shop, cust, 2); // in the auto window
    const b4 = await mkCompletedBooking(shop, cust, 0.5); // too fresh (12h)
    await reviews.saveSettings(shop2, { googleReviewUrl: 'https://g.page/other/review', enabled: false });
    const b5 = await mkCompletedBooking(shop2, cust, 2); // disabled shop
    const sent = await reviews.runReviewSweep();
    ok(sent.includes(String(b3)), 'sweep auto-sends the eligible booking');
    ok(!sent.includes(String(b4)) && !sent.includes(String(b5)),
      'sweep skips too-fresh and disabled-shop bookings');
    const b3row = await db.get('SELECT source FROM shop_review_requests WHERE booking_id = ?', [String(b3)]);
    ok(b3row && b3row.source === 'auto', 'sweep logs source=auto in the unified log');
    const sentAgain = await reviews.runReviewSweep();
    ok(!sentAgain.includes(String(b3)) && mailSent === 2, 'sweep never re-sends a logged booking');
  } finally {
    mail.__setTransporter(null);
  }
}

async function runHttpTests(ok, req) {
  console.log('phase8 client profiles + review requests (http):');
  const PORT = process.env.PHASE8_TEST_PORT || 4137;
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
  const shop = makeClient();
  const anon = makeClient();

  const sEmail = `p8hshop-${tag()}@test.local`;
  let r = await shop('POST', '/signup', {
    body: { display_name: 'P8Shop', email: sEmail, password: 'password123' }, follow: false,
  });
  ok(r.status === 302, 'phase8 shop signup');
  const shopId = wdb.prepare('SELECT id FROM users WHERE email = ?').get(sEmail).id;
  wdb.prepare('UPDATE users SET role = ? WHERE id = ?').run('tattoo_shop', shopId);
  const planId = wdb.prepare("SELECT id FROM plans WHERE slug = 'tattoo_shop'").get().id;
  wdb.prepare('INSERT INTO subscriptions (id, user_id, plan_id, status, created_at) VALUES (?,?,?,?,?)')
    .run(`sub-${shopId}`, shopId, planId, 'active', Date.now());

  for (const p of ['/shop/clients', '/shop/clients/new', '/shop/reviews', '/shop/reviews/log']) {
    r = await shop('GET', p);
    ok(r.status === 200, `shop GET ${p} -> 200 (got ${r.status})`);
  }
  // Anonymous users get bounced to login.
  r = await anon('GET', '/shop/clients', { follow: false });
  ok([301, 302, 303].includes(r.status), 'anon client access redirects to login');
  r = await anon('GET', '/shop/reviews', { follow: false });
  ok([301, 302, 303].includes(r.status), 'anon review access redirects to login');
  // Client create round-trip.
  r = await shop('POST', '/shop/clients', {
    body: { website: '', name: 'HTTP Client', email: 'httpclient@test.local' }, follow: false,
  });
  ok(r.status === 302 && /^\/shop\/clients\//.test(r.location || ''),
    `POST /shop/clients creates + redirects to detail (got ${r.status} -> ${r.location})`);
  const cid = wdb.prepare('SELECT id FROM shop_clients WHERE shop_user_id = ?').get(shopId).id;
  r = await shop('GET', `/shop/clients/${cid}`);
  ok(r.status === 200 && r.text.includes('HTTP Client'), 'new client appears in detail');
  // Unknown client -> 404 even for logged-in shops.
  r = await shop('GET', '/shop/clients/does-not-exist');
  ok(r.status === 404, 'unknown client -> 404');
  wdb.close();
}

module.exports = { runDbTests, runHttpTests };
