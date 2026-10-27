// Guest bridge tests (owner ruling 2026-10-26 19:21 + refinement
// 19:23, contract §10, migration 113). The guest lanes stay,
// bridged: a completed guest DESIGN buy fires the §7 purchase claim
// at once (one email; the tap seats the buyer and attaches the
// order); a guest PAID-APP buy records a pending tie instead and
// stays a guest until the app goes live on the store, when the
// go-live trigger fires one claim per buyer. The coordinator
// (test/run.js) wires this in; do not run from here.
const BASE = 'http://localhost:4137';

async function seedOrder(db, id, email, type, amount = 7500) {
  await db.insert('orders', {
    id, buyer_id: '', design_id: null, order_type: type,
    amount_cents: amount, fee_cents: 0, status: 'paid', payment_method: 'paypal',
    paypal_order_id: `pp-${id}`, referral_code: '', guest_email: email, paid_at: Date.now(),
  });
  return db.get('SELECT * FROM orders WHERE id = ?', [id]);
}

async function runDbTests(ok) {
  console.log('guest bridge (purchase claims + pending ties):');
  const db = require('../src/db');
  const mail = require('../src/lib/mail');
  const guestCheckout = require('../src/lib/guestCheckout');
  const claims = require('../src/lib/seatClaims');
  const pendingTies = require('../src/lib/pendingTies');

  const sent = [];
  mail.__setTransporter({ sendMail: async (m) => { sent.push(m); return { messageId: 'test' }; } });
  const mailsTo = (email) => sent.filter((m) => m.to === email);
  const tokenFrom = (m) => {
    const mm = /token=([0-9a-f]{64})/.exec((m && m.text) || '');
    return mm && mm[1];
  };

  try {
    // --- Design lane: buy -> claim mailed once -> verify -> attached ---
    const dEmail = 'bridge-design@test.local';
    const d1 = await seedOrder(db, 'ord-bridge-design-1', dEmail, 'premade');
    const b1 = await guestCheckout.bridgeGuestPurchase(d1);
    ok(b1.ok === true && b1.mode === 'claim' && b1.mailed === true,
      'design bridge: a completed guest design buy fires the purchase claim');
    ok(mailsTo(dEmail).length === 1, 'design bridge: exactly one claim email is mailed');
    ok(mailsTo(dEmail)[0].subject.includes('tied to your OneMind seat'),
      'design bridge: the email is framed as the purchase tied to the seat');
    let claimRows = await db.all(
      "SELECT * FROM seat_claims WHERE email = ? AND surface = 'website'", [dEmail]);
    ok(claimRows.length === 1 && claimRows[0].status === 'pending'
      && claimRows[0].claim_source === 'guest-purchase',
      'design bridge: one pending guest-purchase claim on the website surface');

    // Repeat buy inside the window: no re-mail, no second claim.
    const d2 = await seedOrder(db, 'ord-bridge-design-2', dEmail, 'premade');
    const b2 = await guestCheckout.bridgeGuestPurchase(d2);
    ok(b2.ok === true && b2.mailed === false, 'design bridge: a repeat buy does not re-mail (dedupe)');
    ok(mailsTo(dEmail).length === 1, 'design bridge: still exactly one claim email after the repeat buy');
    claimRows = await db.all(
      "SELECT * FROM seat_claims WHERE email = ? AND surface = 'website'", [dEmail]);
    ok(claimRows.length === 1, 'design bridge: still exactly one claim after the repeat buy');

    const v = await claims.verifyClaim(tokenFrom(mailsTo(dEmail)[0]));
    ok(v.ok === true && v.created_account === true, 'design bridge: the tap seats the buyer');
    ok(v.linked_orders === 2, 'design bridge: the tap attaches both guest orders to the seat');
    const d1After = await db.get('SELECT buyer_id FROM orders WHERE id = ?', ['ord-bridge-design-1']);
    const d2After = await db.get('SELECT buyer_id FROM orders WHERE id = ?', ['ord-bridge-design-2']);
    ok(d1After.buyer_id === v.user.id && d2After.buyer_id === v.user.id,
      'design bridge: the orders carry the account reference after the tap');
    ok(v.seat.purchase_count === 2
      && v.seat.purchases.map((p) => p.order_id).includes('ord-bridge-design-1'),
      'design bridge: the seat summary reflects the purchases');

    // Existing account under the email: same seat, never a duplicate.
    const kEmail = 'bridge-known@test.local';
    const knownId = await db.insert('users', {
      email: kEmail, password_hash: 'x', role: 'customer', display_name: 'Known Buyer',
    });
    const k1 = await seedOrder(db, 'ord-bridge-known-1', kEmail, 'premade');
    const bk = await guestCheckout.bridgeGuestPurchase(k1);
    ok(bk.ok === true && bk.mailed === true, 'design bridge: a known email still gets its one claim');
    const vk = await claims.verifyClaim(tokenFrom(mailsTo(kEmail)[0]));
    ok(vk.ok === true && vk.created_account === false && vk.user.id === knownId,
      'design bridge: the tap resolves to the EXISTING seat (never a duplicate)');
    const kAfter = await db.get('SELECT buyer_id FROM orders WHERE id = ?', ['ord-bridge-known-1']);
    ok(kAfter.buyer_id === knownId, 'design bridge: the order attaches to the existing seat');
    const kUsers = await db.all('SELECT id FROM users WHERE email = ?', [kEmail]);
    ok(kUsers.length === 1, 'design bridge: no second account exists for the email');

    // --- Sideload lane: buy -> NO claim -> pending tie -> go-live fires ---
    const aEmail = 'bridge-app@test.local';
    const appKey = 'com.usefulappz.odometer';
    ok((await pendingTies.isAppLive(appKey)) === false, 'sideload bridge: the app starts sideload-only (not live)');
    const a1 = await seedOrder(db, 'ord-bridge-app-1', aEmail, 'sideload:com.usefulappz.odometer', 199);
    const s1 = await guestCheckout.bridgeGuestPurchase(a1, appKey);
    ok(s1.ok === true && s1.mode === 'pending_tie',
      'sideload bridge: a guest app buy records a pending tie instead of claiming');
    ok(mailsTo(aEmail).length === 0, 'sideload bridge: NO claim is mailed while sideload-only');
    const noClaims = await db.all('SELECT * FROM seat_claims WHERE email = ?', [aEmail]);
    ok(noClaims.length === 0, 'sideload bridge: no claim row exists while sideload-only');
    let ties = await db.all('SELECT * FROM guest_pending_ties WHERE app_key = ?', [appKey]);
    ok(ties.length === 1 && ties[0].status === 'pending' && ties[0].order_id === 'ord-bridge-app-1'
      && ties[0].email === aEmail,
      'sideload bridge: the pending tie records buyer email x app x order');
    const s1b = await guestCheckout.bridgeGuestPurchase(a1, appKey);
    ok(s1b.ok === true, 'sideload bridge: re-bridging the same order is harmless');
    ties = await db.all('SELECT * FROM guest_pending_ties WHERE app_key = ?', [appKey]);
    ok(ties.length === 1, 'sideload bridge: one pending tie per order (idempotent)');
    const a2 = await seedOrder(db, 'ord-bridge-app-2', aEmail, 'sideload:com.usefulappz.odometer', 199);
    await guestCheckout.bridgeGuestPurchase(a2, appKey);
    ties = await db.all('SELECT * FROM guest_pending_ties WHERE app_key = ?', [appKey]);
    ok(ties.length === 2 && mailsTo(aEmail).length === 0,
      'sideload bridge: a second buy adds a tie, still no email');

    // Go-live: the flag flip fires one claim per buyer.
    const fired = await pendingTies.firePendingTies(appKey);
    ok(fired.live === true && fired.buyers === 1 && fired.claims_mailed === 1 && fired.ties_fired === 2,
      'go-live: the trigger fires ONE claim for the buyer and stamps both ties fired');
    ok(mailsTo(aEmail).length === 1, 'go-live: exactly one claim email for two orders');
    ok((await pendingTies.isAppLive(appKey)) === true, 'go-live: the app is marked live');
    ties = await db.all('SELECT * FROM guest_pending_ties WHERE app_key = ?', [appKey]);
    ok(ties.every((t) => t.status === 'fired' && !!t.claim_id && !!t.fired_at),
      'go-live: the ties record the claim that carries them');

    const va = await claims.verifyClaim(tokenFrom(mailsTo(aEmail)[0]));
    ok(va.ok === true && va.linked_orders === 2,
      'go-live: the tap seats the buyer and attaches both app purchases');
    const a1After = await db.get('SELECT buyer_id FROM orders WHERE id = ?', ['ord-bridge-app-1']);
    const a2After = await db.get('SELECT buyer_id FROM orders WHERE id = ?', ['ord-bridge-app-2']);
    ok(a1After.buyer_id === va.user.id && a2After.buyer_id === va.user.id,
      'go-live: the app orders carry the account reference after the tap');
    ok(va.seat.purchase_count === 2, 'go-live: the seat summary reflects the app purchases');

    // After go-live, new guest buys of that app claim on buy.
    const a3Email = 'bridge-app2@test.local';
    const a3 = await seedOrder(db, 'ord-bridge-app-3', a3Email, 'sideload:com.usefulappz.odometer', 199);
    const s3 = await guestCheckout.bridgeGuestPurchase(a3, appKey);
    ok(s3.ok === true && s3.mode === 'claim' && s3.mailed === true,
      'go-live: a later guest buy of the live app bridges on buy, like designs');
  } finally {
    mail.__setTransporter(null);
  }
}

async function runHttpTests(ok) {
  console.log('guest bridge (route wiring + go-live endpoint):');
  const fs = require('fs');
  const path = require('path');
  const Database = require('better-sqlite3');
  const tdb = new Database(process.env.SQLITE_PATH);
  const updateTokens = require('../src/lib/updateTokens');
  const guestCheckout = require('../src/lib/guestCheckout');
  const TOKEN = process.env.MUSE_SERVICE_TOKEN;

  const anon = async (method, p, body) => {
    const res = await fetch(`${BASE}${p}`, {
      method, redirect: 'manual',
      headers: body ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
      body: body ? new URLSearchParams(body).toString() : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get('location') || '' };
  };
  const svc = async (method, p, body) => {
    const res = await fetch(`${BASE}${p}`, {
      method, redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, text, json };
  };

  // --- Design lane over the real routes: capture -> claim row exists ---
  const designId = 'testdesign-bridge1';
  const now = Date.now();
  tdb.prepare(`INSERT INTO designs (id, title, description, price_cents, status, color_path, linework_path, linework_wm_path, categories, sale_count, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(designId, 'Bridge Owl', 'desc', 7500, 'approved',
    'designs/color/bridge.jpg', 'designs/linework/bridge.jpg', 'designs/linework-wm/bridge-wm.jpg', '[]', 0, now);
  fs.mkdirSync(path.join(process.env.ASSET_DIR, 'designs', 'color'), { recursive: true });
  fs.mkdirSync(path.join(process.env.ASSET_DIR, 'designs', 'linework'), { recursive: true });
  fs.writeFileSync(path.join(process.env.ASSET_DIR, 'designs', 'color', 'bridge.jpg'), 'fake-color-bridge');
  fs.writeFileSync(path.join(process.env.ASSET_DIR, 'designs', 'linework', 'bridge.jpg'), 'fake-linework-bridge');

  const dEmail = 'bridge-http-design@test.local';
  let a = await anon('POST', `/orders/buy/${designId}`, { linework_only: '0', guest_email: dEmail });
  ok(a.status === 302 && !a.location.includes('/login'), 'http bridge: guest design buy never bounces to /login');
  const dOrder = tdb.prepare('SELECT * FROM orders WHERE guest_email = ? ORDER BY created_at DESC').get(dEmail);
  ok(!!dOrder, 'http bridge: the guest design order exists');
  const gt = updateTokens.issue(dOrder.id, 'guest-design-checkout');
  a = await anon('GET', `/orders/approve/${dOrder.id}?gt=${encodeURIComponent(gt)}`);
  ok(a.status === 302 && a.location.includes('/orders/download/'),
    'http bridge: the guest design capture completes');
  const dPaid = tdb.prepare('SELECT status FROM orders WHERE id = ?').get(dOrder.id);
  ok(dPaid && dPaid.status === 'paid', 'http bridge: the design order is paid');
  const dClaims = tdb.prepare(
    "SELECT * FROM seat_claims WHERE email = ? AND surface = 'website'").all(dEmail);
  ok(dClaims.length === 1 && dClaims[0].status === 'pending' && dClaims[0].claim_source === 'guest-purchase',
    'http bridge: completing the design buy fired exactly one guest-purchase claim');

  // --- Sideload lane over the real routes: capture -> pending tie, no claim ---
  const appEmail = 'bridge-http-app@test.local';
  const appKey = 'com.usefulappz.clipboardbar';
  tdb.prepare(`INSERT INTO orders
    (id, buyer_id, design_id, order_type, amount_cents, fee_cents, status, payment_method, paypal_order_id, referral_code, guest_email, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('ord-bridge-http-1', '', null,
    'sideload:com.usefulappz.clipboardbar', 0, 0, 'pending', 'paypal', 'pp-ord-bridge-http-1', '', appEmail, Date.now());
  const appGt = guestCheckout.guestToken('ord-bridge-http-1', appKey);
  a = await anon('GET', `/buy-app/clipboard-bar/approve/ord-bridge-http-1?gt=${encodeURIComponent(appGt)}`);
  ok(a.status === 302 && a.location.includes('/buy-app/clipboard-bar/download/ord-bridge-http-1'),
    'http bridge: the guest app capture completes');
  const appPaid = tdb.prepare('SELECT status FROM orders WHERE id = ?').get('ord-bridge-http-1');
  ok(appPaid && appPaid.status === 'paid', 'http bridge: the app order is paid');
  const appClaims = tdb.prepare('SELECT * FROM seat_claims WHERE email = ?').all(appEmail);
  ok(appClaims.length === 0, 'http bridge: NO claim is started for a sideload-only app buy');
  const appTies = tdb.prepare('SELECT * FROM guest_pending_ties WHERE order_id = ?').all('ord-bridge-http-1');
  ok(appTies.length === 1 && appTies[0].status === 'pending' && appTies[0].app_key === appKey
    && appTies[0].email === appEmail,
    'http bridge: the pending tie is recorded (buyer email x app x order)');

  // --- The go-live trigger: service-token gated, fires the ties ---
  let r = await fetch(`${BASE}/api/onemind/pending-ties/fire`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_key: appKey }),
  });
  ok(r.status === 401, 'go-live endpoint: refuses without the service token');
  r = await svc('POST', '/api/onemind/pending-ties/fire', { app_key: appKey });
  ok(r.status === 200 && r.json && r.json.ok === true && r.json.buyers === 1
    && r.json.claims_mailed === 1 && r.json.ties_fired === 1,
    'go-live endpoint: firing flips the app live and mails one claim for the buyer');
  const firedClaims = tdb.prepare(
    "SELECT * FROM seat_claims WHERE email = ? AND claim_source = 'guest-purchase'").all(appEmail);
  ok(firedClaims.length === 1 && firedClaims[0].status === 'pending',
    'go-live endpoint: exactly one guest-purchase claim now waits for the buyer');
  const firedTies = tdb.prepare('SELECT * FROM guest_pending_ties WHERE order_id = ?').all('ord-bridge-http-1');
  ok(firedTies.length === 1 && firedTies[0].status === 'fired' && !!firedTies[0].claim_id,
    'go-live endpoint: the tie is stamped fired with its claim');
  r = await svc('GET', '/api/onemind/pending-ties');
  ok(r.status === 200 && r.json && r.json.live && r.json.live[appKey]
    && r.json.live[appKey].live === true,
    'go-live endpoint: the book view shows the app live');

  tdb.close();
}

module.exports = { runDbTests, runHttpTests };
