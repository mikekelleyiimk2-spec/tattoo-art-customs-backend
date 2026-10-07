// Holiday Doodle Raffle tests (owner directive 2026-10-07).
// Entries: 20 per customer membership, 5 per paid purchase, direct packs
// (1/$1, 10/$5, 25/$10). Prize: 1 winner per 100 entries, RAFFLE-XXXXXX
// codes redeemable for free doodle merch. Separate tables from the opening
// raffle in lib/founding.js.
const { randomUUID } = require('crypto');
const db = require('../src/db');
const hr = require('../src/lib/holidayRaffle');

async function mkUser(email) {
  return db.insert('users', {
    email, password_hash: 'x', role: 'customer', display_name: email.split('@')[0],
  });
}

async function mkRaffle(name) {
  return db.insert('holiday_raffles', {
    name: name || `Test Raffle ${randomUUID().slice(0, 8)}`,
    ends_at: Date.now() + 86400000,
    status: 'open',
    created_at: db.now(),
  });
}

async function runDbTests(ok) {
  console.log('holiday-raffle (db):');
  const Database = require('better-sqlite3');
  const sdb = new Database(process.env.SQLITE_PATH);
  for (const t of ['holiday_raffles', 'holiday_raffle_entries', 'holiday_raffle_winners', 'holiday_raffle_codes']) {
    const found = sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    ok(!!found, `migration 062: table ${t} exists`);
  }
  const orderCols = sdb.prepare('SELECT name FROM pragma_table_info(?)').all('orders').map((r) => r.name);
  ok(orderCols.includes('raffle_entries_bought'), 'migration 062: orders has raffle_entries_bought column');
  sdb.close();

  // Entry packs are fee-inclusive $1 / $5 / $10.
  const { withFeeCents } = require('../src/lib/pricing');
  for (const p of hr.ENTRY_PACKS) {
    const total = withFeeCents(p.baseCents);
    const expected = { pack1: 100, pack10: 500, pack25: 1000 }[p.id];
    ok(total === expected, `pack ${p.id}: fee-inclusive total is $${(expected / 100).toFixed(2)}`);
  }

  // Membership entries: customer plans earn 20, others earn 0.
  const u1 = await mkUser(`hr1-${randomUUID().slice(0, 8)}@test.local`);
  const raffleId = await mkRaffle();
  // Temporarily point getOpenRaffle at our raffle by making it the only open one.
  const r1 = await hr.awardMembershipEntries({ userId: u1, planSlug: 'customer', providerRef: `test:${u1}` });
  ok(r1.awarded && r1.entries === 20, 'customer plan payment awards 20 entries');
  const r1b = await hr.awardMembershipEntries({ userId: u1, planSlug: 'customer', providerRef: `test:${u1}` });
  ok(!r1b.awarded && r1b.reason === 'duplicate', 'membership entries are idempotent per providerRef');
  const r2 = await hr.awardMembershipEntries({ userId: u1, planSlug: 'design_artist', providerRef: `test:da:${u1}` });
  ok(!r2.awarded, 'non-customer plan awards no entries');
  ok((await hr.userEntries(raffleId, u1)) === 20, 'user entry total is 20');

  // Purchase entries: 5 per paid order, entry-pack orders credit the bundle.
  const u2 = await mkUser(`hr2-${randomUUID().slice(0, 8)}@test.local`);
  const orderId = db.newId();
  await db.insert('orders', {
    id: orderId, buyer_id: u2, order_type: 'premade',
    amount_cents: 1000, fee_cents: 84, status: 'paid', payment_method: 'paypal',
    created_at: db.now(),
  });
  const p1 = await hr.awardPurchaseEntries(await db.get('SELECT * FROM orders WHERE id = ?', [orderId]));
  ok(p1.awarded && p1.entries === 5, 'paid purchase awards 5 entries');
  const p1b = await hr.awardPurchaseEntries(await db.get('SELECT * FROM orders WHERE id = ?', [orderId]));
  ok(!p1b.awarded && p1b.reason === 'duplicate', 'purchase entries idempotent per order');
  // Unpaid orders earn nothing.
  const unpaidId = db.newId();
  await db.insert('orders', {
    id: unpaidId, buyer_id: u2, order_type: 'premade',
    amount_cents: 1000, fee_cents: 84, status: 'pending', payment_method: 'paypal',
    created_at: db.now(),
  });
  const p2 = await hr.awardPurchaseEntries(await db.get('SELECT * FROM orders WHERE id = ?', [unpaidId]));
  ok(!p2.awarded, 'unpaid order awards no entries');
  // Entry-pack order credits the bundle, not the 5 purchase entries.
  const packId = db.newId();
  await db.insert('orders', {
    id: packId, buyer_id: u2, order_type: 'raffle_entries',
    amount_cents: 436, fee_cents: 64, status: 'paid', payment_method: 'paypal',
    raffle_entries_bought: 10, created_at: db.now(),
  });
  const p3 = await hr.awardPurchaseEntries(await db.get('SELECT * FROM orders WHERE id = ?', [packId]));
  ok(p3.awarded && p3.entries === 10, 'entry-pack order credits its 10 bundle entries');
  ok((await hr.userEntries(raffleId, u2)) === 15, 'user total is 5 + 10 = 15');

  // Prize code validation + consumption.
  const code = hr.makeRaffleCode();
  ok(/^RAFFLE-[A-Z2-9]{6}$/.test(code), 'prize code format is RAFFLE-XXXXXX');
  const wid = db.newId();
  await db.insert('holiday_raffle_winners', {
    id: wid, raffle_id: raffleId, user_id: u2, entries_snapshot: 15,
    code, drawn_at: db.now(),
  });
  await db.insert('holiday_raffle_codes', {
    id: db.newId(), code, raffle_id: raffleId, winner_id: wid,
    consumed: 0, consumed_at: null, created_at: db.now(),
  });
  const v1 = await hr.validatePrizeCode(code.toLowerCase());
  ok(v1.ok, 'prize code validates (case-insensitive)');
  ok((await hr.validatePrizeCode('RAFFLE-ZZZZZZ')).ok === false, 'unknown code rejected');
  const c1 = await hr.consumePrizeCode(code, 'order-123');
  ok(c1.ok, 'prize code consumed');
  const v2 = await hr.validatePrizeCode(code);
  ok(!v2.ok && v2.reason === 'consumed', 'consumed code rejected');

  // Drawing math: floor(total / 100) winners, weighted by entries.
  const drawRaffle = await mkRaffle('Draw Test');
  const da = await mkUser(`hrd-a-${randomUUID().slice(0, 8)}@test.local`);
  const dbb = await mkUser(`hrd-b-${randomUUID().slice(0, 8)}@test.local`);
  // 150 entries for A (3 source refs), 100 for B (2 refs) = 250 total -> 2 winners.
  for (let i = 0; i < 3; i += 1) {
    await hr.awardEntries({ raffleId: drawRaffle, userId: da, entries: 50, source: 'direct', sourceRef: `da:${i}` });
  }
  for (let i = 0; i < 2; i += 1) {
    await hr.awardEntries({ raffleId: drawRaffle, userId: dbb, entries: 50, source: 'direct', sourceRef: `db:${i}` });
  }
  ok((await hr.totalEntries(drawRaffle)) === 250, 'draw test raffle has 250 entries');
  const drawn = await hr.drawWinners(drawRaffle);
  ok(drawn.winners.length === 2, '250 entries -> 2 winners');
  ok(new Set(drawn.winners.map((w) => w.userId)).size === 2, 'winners are distinct users');
  ok(drawn.winners.every((w) => /^RAFFLE-[A-Z2-9]{6}$/.test(w.code)), 'winners get RAFFLE-XXXXXX codes');
  const codes = await db.all('SELECT code FROM holiday_raffle_codes WHERE raffle_id = ?', [drawRaffle]);
  ok(codes.length === 2 && new Set(codes.map((c) => c.code)).size === 2, 'prize codes stored and unique');
  const after = await hr.getRaffleById(drawRaffle);
  ok(after.status === 'drawn', 'raffle marked drawn');
  let drawAgain = null;
  try { await hr.drawWinners(drawRaffle); } catch (e) { drawAgain = e.message; }
  ok(/already drawn/.test(drawAgain || ''), 'double draw rejected');
  // Too few entries -> no winners.
  const smallRaffle = await mkRaffle('Small Test');
  const su = await mkUser(`hrs-${randomUUID().slice(0, 8)}@test.local`);
  await hr.awardEntries({ raffleId: smallRaffle, userId: su, entries: 50, source: 'direct', sourceRef: 's:1' });
  let smallErr = null;
  try { await hr.drawWinners(smallRaffle); } catch (e) { smallErr = e.message; }
  ok(/Not enough entries/.test(smallErr || ''), 'under-100 entries cannot draw');

  // Clean up test raffles so getOpenRaffle stays deterministic for later tests.
  await db.query('DELETE FROM holiday_raffle_entries WHERE raffle_id IN (?,?,?)', [raffleId, drawRaffle, smallRaffle]);
  await db.query('DELETE FROM holiday_raffle_codes WHERE raffle_id IN (?,?,?)', [raffleId, drawRaffle, smallRaffle]);
  await db.query('DELETE FROM holiday_raffle_winners WHERE raffle_id IN (?,?,?)', [raffleId, drawRaffle, smallRaffle]);
  await db.query('DELETE FROM holiday_raffles WHERE id IN (?,?,?)', [raffleId, drawRaffle, smallRaffle]);
}

async function runHttpTests(ok, req) {
  console.log('holiday-raffle (http):');
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

  // Seed one open raffle for the HTTP phase.
  const raffleId = randomUUID();
  sdb.prepare(`INSERT INTO holiday_raffles (id, name, ends_at, status, created_at)
    VALUES (?, 'Holiday Doodle Raffle', ?, 'open', ?)`)
    .run(raffleId, Date.now() + 86400000, Date.now());

  // Public page renders.
  let r = await req('GET', '/holiday-raffle');
  ok(r.status === 200 && r.text.includes('Holiday Doodle Raffle'), 'GET /holiday-raffle 200');
  ok(r.text.includes('1 for $1') || r.text.includes('entry packs'), 'page describes entry packs');
  // Kid-safe: the raffle's own copy (main content) never mentions tattoos.
  const main = (r.text.match(/<main[^>]*>([\s\S]*)<\/main>/) || [])[1] || r.text;
  const mainNoBrand = main.replace(/Tattoo Art Customs™?/g, '');
  ok(!/tattoo/i.test(mainNoBrand), 'raffle copy is kid-safe (no tattoo mention)');

  // Sitemap includes the page.
  r = await req('GET', '/sitemap.xml');
  ok(r.status === 200 && r.text.includes('/holiday-raffle'), 'sitemap lists /holiday-raffle');

  // Guest /enter bounces to login.
  const guest = makeClient();
  r = await guest('GET', '/holiday-raffle/enter', { follow: false });
  ok(r.status === 302 && (r.location || '').startsWith('/login'), 'guest GET /enter -> login');

  // Signed-in user sees the packs.
  const user = makeClient();
  const email = `hruser-${randomUUID().slice(0, 8)}@test.local`;
  r = await user('POST', '/signup', { ...form({ display_name: 'Raffle Fan', email, password: 'password123' }), follow: false });
  ok(r.status === 302, 'signup redirects');
  r = await user('GET', '/holiday-raffle/enter');
  ok(r.status === 200 && r.text.includes('pack10') && r.text.includes('pack25'), 'enter page shows packs');

  // Buying a pack creates a raffle_entries order (PayPal stub -> manual page).
  r = await user('POST', '/holiday-raffle/enter', { ...form({ pack: 'pack10' }), follow: false });
  ok(r.status === 302 && /^\/orders\/(manual\/)?[a-zA-Z0-9-]+$/.test(r.location || ''),
    'pack POST -> order redirect, got ' + r.location);
  const packOrderId = (r.location || '').split('/').pop();
  const po = sdb.prepare('SELECT order_type, amount_cents, fee_cents, raffle_entries_bought FROM orders WHERE id = ?').get(packOrderId);
  ok(po && po.order_type === 'raffle_entries' && po.raffle_entries_bought === 10,
    'entry-pack order stores bundle size');
  ok(po && po.amount_cents + po.fee_cents === 500, 'pack10 charges exactly $5.00');

  // Bad pack id is rejected.
  r = await user('POST', '/holiday-raffle/enter', { ...form({ pack: 'bogus' }), follow: false });
  ok(r.status === 302 && r.location === '/holiday-raffle/enter', 'bogus pack -> back to form');

  sdb.prepare('DELETE FROM holiday_raffle_entries WHERE raffle_id = ?').run(raffleId);
  sdb.prepare('DELETE FROM holiday_raffles WHERE id = ?').run(raffleId);
  sdb.close();
}

module.exports = { runDbTests, runHttpTests };
