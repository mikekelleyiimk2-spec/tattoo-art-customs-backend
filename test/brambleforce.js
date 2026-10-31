// Brambleforce website sale door tests (owner orders 2026-10-30):
// landing + buy pages for the game and all 13 IAPs, guest checkout with
// no account wall, unlock-code issuance at capture, and the game's
// redeem contract (POST /api/brambleforce/redeem: {product} once, then
// {error:"spent"}; unknown and BFTEST-style codes -> {error:"unknown"}).
// Capture is the run.js $0.00 stub, so seeded orders carry 0/0 amounts
// (same trick as test/guestAppCheckout.js). The coordinator
// (test/run.js) wires this in; do not run from here.
async function runHttpTests(ok, req, areq) {
  console.log('brambleforce sale door (http):');
  const Database = require('better-sqlite3');
  const tdb = new Database(process.env.SQLITE_PATH);
  const guestCheckout = require('../src/lib/guestCheckout');

  const anon = async (method, p, body, headers) => {
    const res = await fetch(`http://localhost:4137${p}`, {
      method, redirect: 'manual',
      headers: {
        ...(body && typeof body === 'object' && body.__json
          ? { 'content-type': 'application/json' }
          : body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(headers || {}),
      },
      body: body
        ? (body.__json ? JSON.stringify(body.__json) : new URLSearchParams(body).toString())
        : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get('location') || '', headers: res.headers };
  };

  // 1. Landing + buy pages render with the struck catalogue.
  let a = await anon('GET', '/brambleforce');
  ok(a.status === 200, 'bf: landing page 200');
  ok(a.text.includes('$6.99') && a.text.includes('/brambleforce/buy/game'), 'bf: landing carries the $6.99 game door');
  ok(a.text.includes('/brambleforce/buy/everything_bundle') && a.text.includes('/brambleforce/buy/war_bond'),
    'bf: landing lists the extras doors');
  for (const p of ['/brambleforce/buy/game', '/brambleforce/buy/crt_filter', '/brambleforce/buy/everything_bundle']) {
    const r = await anon('GET', p);
    ok(r.status === 200, `bf: ${p} page 200`);
    ok(r.text.includes('name="guest_email"'), `bf: ${p} has the guest delivery-email field`);
  }
  a = await anon('GET', '/brambleforce/buy/crt_filter');
  ok(a.text.includes('$0.99'), 'bf: crt_filter page shows the struck $0.99');
  a = await anon('GET', '/brambleforce/buy/not_a_product');
  ok(a.status === 404, 'bf: unknown product 404s');

  // 1b. Stall watchdog (regression for the 2026-10-30 owner hang): a
  // submission whose navigation never completes (deploy restart,
  // dropped connection) must restore the form instead of sitting on
  // "Working…" forever. The house layout carries it with a visible
  // stall notice (asserted on the homepage, a house-layout page); the
  // buy page must carry a restore watchdog in whichever skin serves
  // it (house layout's tacRestoreForm, or the Brambleforce layout's
  // bfRestoreForm when that skin is active).
  a = await anon('GET', '/');
  ok(a.text.includes('TAC_STALL_LABEL') && a.text.includes('may not have gone through'),
    'bf: house layout carries the stall-recovery label + notice');
  ok(a.text.includes('function tacRestoreForm') && a.text.includes("addEventListener('pageshow'"),
    'bf: house layout carries the form-restore watchdog + pageshow restore');
  a = await anon('GET', '/brambleforce/buy/crt_filter');
  ok((a.text.includes('function tacRestoreForm') || a.text.includes('function bfRestoreForm'))
    && a.text.includes("addEventListener('submit'"),
    'bf: buy page carries a stall-restore watchdog');

  // 2. Guest buy: no email bounces to the buy page (never /login);
  // with an email the order row exists (PayPal create is unconfigured
  // in the harness, so the handoff falls back — same invariant as the
  // other paid-app flows).
  a = await anon('POST', '/brambleforce/buy/crt_filter/buy', {});
  ok(a.status === 302 && a.location.includes('/brambleforce/buy/crt_filter') && !a.location.includes('/login'),
    'bf: buy without email returns to the buy page (no login bounce)');
  a = await anon('POST', '/brambleforce/buy/crt_filter/buy', { guest_email: 'bfguest@test.local' });
  ok(a.status === 302 && !a.location.includes('/login'), 'bf: buy with email never bounces to /login');
  const pending = tdb.prepare('SELECT * FROM orders WHERE guest_email = ? ORDER BY created_at DESC').get('bfguest@test.local');
  ok(pending && pending.buyer_id === '' && pending.order_type === 'brambleforce:crt_filter' && pending.status === 'pending',
    'bf: IAP order is a pending brambleforce order with the guest sentinel buyer');

  // 2b. Checkout idempotency (buy-button hang recurrence, 2026-10-31):
  // the buy page carries a per-render checkout key; a POST replaying a
  // key whose checkout already completed redirects to the SAME PayPal
  // approve URL and mints NO second order; a key whose create failed
  // leaves no marker behind, so a genuine retry starts fresh.
  a = await anon('GET', '/brambleforce/buy/crt_filter');
  ok(a.text.includes('name="ck"'), 'bf: buy page carries the checkout idempotency key');
  const ordersBefore = tdb.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  tdb.prepare('INSERT INTO site_kv (name, val, updated_at) VALUES (?,?,?)')
    .run('bfck:testkey0001', JSON.stringify({ orderId: 'ord-seeded', approve: 'https://www.paypal.com/checkoutnow?token=SEEDED', ts: Date.now() }), Date.now());
  a = await anon('POST', '/brambleforce/buy/crt_filter/buy', { guest_email: 'bfdupe@test.local', ck: 'testkey0001' });
  ok(a.status === 200 && a.text.includes('https://www.paypal.com/checkoutnow?token=SEEDED'),
    'bf: replayed checkout key hands off to the original PayPal checkout');
  ok(tdb.prepare('SELECT COUNT(*) AS n FROM orders').get().n === ordersBefore,
    'bf: replayed checkout key mints no second order');
  a = await anon('POST', '/brambleforce/buy/crt_filter/buy', { guest_email: 'bfdupe@test.local', ck: 'testkey0002' });
  ok(a.status === 302 && a.location.includes('/brambleforce/buy/crt_filter'),
    'bf: fresh key with PayPal down still falls back to the buy page');
  ok(!tdb.prepare('SELECT name FROM site_kv WHERE name = ?').get('bfck:testkey0002'),
    'bf: failed checkout clears its idempotency marker (retry starts fresh)');

  const seedGuest = (id, type, email) => tdb.prepare(`INSERT INTO orders
    (id, buyer_id, design_id, order_type, amount_cents, fee_cents, status, payment_method, paypal_order_id, referral_code, guest_email, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, '', null, type, 0, 0, 'pending', 'paypal', `pp-${id}`, '', email, Date.now());

  // 3. IAP capture: approve is HMAC-gated; the real token captures,
  // pays, mints ONE code, and the success render shows it.
  seedGuest('ord-bf-crt-1', 'brambleforce:crt_filter', 'bfcrt@test.local');
  a = await anon('GET', '/brambleforce/buy/crt_filter/approve/ord-bf-crt-1');
  ok(a.status === 403, 'bf: approve without the checkout token is 403');
  const crtGt = guestCheckout.guestToken('ord-bf-crt-1', 'brambleforce:crt_filter');
  a = await anon('GET', `/brambleforce/buy/crt_filter/approve/ord-bf-crt-1?gt=${encodeURIComponent(crtGt)}`);
  ok(a.status === 200, 'bf: approve with the real token renders the success page');
  const codeMatch = a.text.match(/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/);
  ok(!!codeMatch, 'bf: success page shows the unlock code, grouped XXXX-XXXX-XXXX-XXXX');
  const code = codeMatch && codeMatch[0];
  let row = tdb.prepare('SELECT status FROM orders WHERE id = ?').get('ord-bf-crt-1');
  ok(row && row.status === 'paid', 'bf: IAP order is paid after capture');
  const codeRow = tdb.prepare('SELECT * FROM brambleforce_codes WHERE order_id = ?').get('ord-bf-crt-1');
  ok(!!codeRow && codeRow.product === 'crt_filter' && Number(codeRow.spent) === 0,
    'bf: exactly one unspent code row minted for the order');
  ok(codeRow && !JSON.stringify(codeRow).includes(code), 'bf: the raw code is never stored (hash only)');

  // 4. The redeem contract, exactly as the game calls it.
  let r = await anon('POST', '/api/brambleforce/redeem', { __json: { code } }, { origin: 'null' });
  ok(r.status === 200, 'bf: redeem answers 200');
  ok(r.headers.get('access-control-allow-origin') === '*', 'bf: redeem carries its scoped CORS header');
  let j = null; try { j = JSON.parse(r.text); } catch (e) { /* asserted below */ }
  ok(j && j.product === 'crt_filter', 'bf: redeem returns {product} for a fresh code');
  const spentRow = tdb.prepare('SELECT spent FROM brambleforce_codes WHERE order_id = ?').get('ord-bf-crt-1');
  ok(spentRow && Number(spentRow.spent) === 1, 'bf: the code is marked spent at redemption');
  r = await anon('POST', '/api/brambleforce/redeem', { __json: { code } });
  j = null; try { j = JSON.parse(r.text); } catch (e) { /* asserted below */ }
  ok(j && j.error === 'spent', 'bf: a second redeem answers {error:"spent"}');
  r = await anon('POST', '/api/brambleforce/redeem', { __json: { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' } });
  j = null; try { j = JSON.parse(r.text); } catch (e) { /* asserted below */ }
  ok(j && j.error === 'unknown', 'bf: an unknown code answers {error:"unknown"}');
  r = await anon('POST', '/api/brambleforce/redeem', { __json: { code: 'BFTEST-crt_filter' } });
  j = null; try { j = JSON.parse(r.text); } catch (e) { /* asserted below */ }
  ok(j && j.error === 'unknown', 'bf: BFTEST test codes are NOT honored server-side');
  r = await anon('POST', '/api/brambleforce/redeem', { __json: {} });
  j = null; try { j = JSON.parse(r.text); } catch (e) { /* asserted below */ }
  ok(r.status === 200 && j && j.error === 'unknown', 'bf: a missing code answers {error:"unknown"}, never a 500');
  const pre = await fetch('http://localhost:4137/api/brambleforce/redeem', {
    method: 'OPTIONS',
    headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*',
    'bf: redeem preflight (the game WebView fetch) is answered with CORS');

  // 5. Game capture: approve redirects to the durable success page,
  // which serves the gated app-updates download token.
  seedGuest('ord-bf-game-1', 'sideload:com.usefulappz.game2runandgun', 'bfgame@test.local');
  const gameGt = guestCheckout.guestToken('ord-bf-game-1', 'brambleforce:game');
  a = await anon('GET', `/brambleforce/buy/game/approve/ord-bf-game-1?gt=${encodeURIComponent(gameGt)}`);
  ok(a.status === 302 && a.location.includes('/brambleforce/buy/game/success/ord-bf-game-1'),
    'bf: game approve redirects to the success/download page');
  a = await anon('GET', `/brambleforce/buy/game/success/ord-bf-game-1?gt=${encodeURIComponent(gameGt)}`);
  ok(a.status === 200 && a.text.includes('/api/apps/com.usefulappz.game2runandgun/apk?t='),
    'bf: game success page serves the gated APK download token link');
  a = await anon('GET', '/brambleforce/buy/game/success/ord-bf-game-1');
  ok(a.status === 403, 'bf: game success page without the token is 403');

  // 6. Re-approving a paid IAP order never mints a second code.
  a = await anon('GET', `/brambleforce/buy/crt_filter/approve/ord-bf-crt-1?gt=${encodeURIComponent(crtGt)}`);
  const codeCount = tdb.prepare('SELECT COUNT(*) AS n FROM brambleforce_codes WHERE order_id = ?').get('ord-bf-crt-1');
  ok(codeCount && codeCount.n === 1, 'bf: re-approve mints no second code (one code per paid order)');

  // 7. Fighter products (added 2026-10-30): three new fighters at the
  // struck $1.99, same catalogue pattern — IAP kind, orders carry
  // brambleforce:<id>, capture mints exactly one code, redeem returns
  // the fighter product.
  const bfLib = require('../src/lib/brambleforce');
  const fighters = [
    ['fighter_zola', 'Zola', 'Adeyemi'],
    ['fighter_otto', 'Otto', 'Fenn'],
    ['fighter_yusuf', 'Yusuf', 'Barakat'],
  ];
  for (const [fid, first, last] of fighters) {
    const fp = bfLib.product(fid);
    ok(!!fp && fp.priceCents === 199 && fp.kind === 'iap', `bf: ${fid} is a $1.99 IAP in the catalogue`);
    ok(bfLib.orderType(fid) === `brambleforce:${fid}`, `bf: ${fid} orders carry brambleforce:${fid}`);
    const r = await anon('GET', `/brambleforce/buy/${fid}`);
    ok(r.status === 200, `bf: /brambleforce/buy/${fid} page 200`);
    ok(r.text.includes('$1.99') && r.text.includes(first) && r.text.includes(last),
      `bf: ${fid} page shows the fighter name and the struck $1.99`);
    ok(r.text.includes('name="guest_email"'), `bf: ${fid} has the guest delivery-email field`);
  }
  a = await anon('GET', '/brambleforce');
  ok(a.text.includes('/brambleforce/buy/fighter_zola') && a.text.includes('/brambleforce/buy/fighter_otto')
    && a.text.includes('/brambleforce/buy/fighter_yusuf'), 'bf: landing lists the three fighter doors');

  // 8. Fighter stub-capture E2E (PayPal $0.00 stub, no real money):
  // guest checkout -> capture mints exactly one code -> redeem returns
  // {product:"fighter_zola"} -> second redeem is spent.
  a = await anon('POST', '/brambleforce/buy/fighter_zola/buy', { guest_email: 'bfzola-buyer@test.local' });
  ok(a.status === 302 && !a.location.includes('/login'), 'bf: fighter_zola buy with email never bounces to /login');
  const zolaPending = tdb.prepare('SELECT * FROM orders WHERE guest_email = ? ORDER BY created_at DESC').get('bfzola-buyer@test.local');
  ok(zolaPending && zolaPending.buyer_id === '' && zolaPending.order_type === 'brambleforce:fighter_zola'
    && zolaPending.status === 'pending',
    'bf: fighter_zola order is a pending brambleforce:fighter_zola order with the guest sentinel buyer');
  seedGuest('ord-bf-zola-1', 'brambleforce:fighter_zola', 'bfzola@test.local');
  a = await anon('GET', '/brambleforce/buy/fighter_zola/approve/ord-bf-zola-1');
  ok(a.status === 403, 'bf: fighter_zola approve without the checkout token is 403');
  const zolaGt = guestCheckout.guestToken('ord-bf-zola-1', 'brambleforce:fighter_zola');
  a = await anon('GET', `/brambleforce/buy/fighter_zola/approve/ord-bf-zola-1?gt=${encodeURIComponent(zolaGt)}`);
  ok(a.status === 200, 'bf: fighter_zola approve with the real token renders the success page');
  const zolaCodeMatch = a.text.match(/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/);
  ok(!!zolaCodeMatch, 'bf: fighter_zola success page shows the unlock code, grouped XXXX-XXXX-XXXX-XXXX');
  const zolaCode = zolaCodeMatch && zolaCodeMatch[0];
  row = tdb.prepare('SELECT status FROM orders WHERE id = ?').get('ord-bf-zola-1');
  ok(row && row.status === 'paid', 'bf: fighter_zola order is paid after capture');
  const zolaRows = tdb.prepare('SELECT * FROM brambleforce_codes WHERE order_id = ?').all('ord-bf-zola-1');
  ok(zolaRows.length === 1 && zolaRows[0].product === 'fighter_zola' && Number(zolaRows[0].spent) === 0,
    'bf: capture mints exactly one unspent code for fighter_zola');
  ok(zolaRows[0] && !JSON.stringify(zolaRows[0]).includes(zolaCode), 'bf: fighter_zola raw code is never stored (hash only)');
  r = await anon('POST', '/api/brambleforce/redeem', { __json: { code: zolaCode } });
  j = null; try { j = JSON.parse(r.text); } catch (e) { /* asserted below */ }
  ok(r.status === 200 && j && j.product === 'fighter_zola', 'bf: redeem returns {product:"fighter_zola"} for the fighter code');
  r = await anon('POST', '/api/brambleforce/redeem', { __json: { code: zolaCode } });
  j = null; try { j = JSON.parse(r.text); } catch (e) { /* asserted below */ }
  ok(j && j.error === 'spent', 'bf: a second fighter_zola redeem answers {error:"spent"}');

  // 9. Everything Bundle ruling (owner, 2026-10-30): price $27.99, and
  // a bundle code grants ALL 15 extras — the original 12 plus the three
  // fighters — via the redeem-side grant mapping. (bfLib is required
  // once in section 7 above and reused here.)
  ok(bfLib.product('everything_bundle').priceCents === 2799, 'bf: everything_bundle is struck at $27.99');
  ok(bfLib.BUNDLE_GRANTS.length === 15
    && ['fighter_zola', 'fighter_otto', 'fighter_yusuf', 'iron_garden_expansion', 'war_bond']
      .every((id) => bfLib.BUNDLE_GRANTS.includes(id))
    && !bfLib.BUNDLE_GRANTS.includes('game') && !bfLib.BUNDLE_GRANTS.includes('everything_bundle'),
    'bf: bundle grant set is exactly the 15 extras (12 + 3 fighters)');
  const extrasTotal = bfLib.BUNDLE_GRANTS.reduce((sum, id) => sum + bfLib.product(id).priceCents, 0);
  ok(extrasTotal === 2885, 'bf: the 15 extras total $28.85 bought separately (bundle sits ~$1 under)');
  a = await anon('GET', '/brambleforce/buy/everything_bundle');
  ok(a.status === 200 && a.text.includes('$27.99'), 'bf: bundle buy page shows $27.99');
  seedGuest('ord-bf-bundle-1', 'brambleforce:everything_bundle', 'bfbundle@test.local');
  const bundleGt = guestCheckout.guestToken('ord-bf-bundle-1', 'brambleforce:everything_bundle');
  a = await anon('GET', `/brambleforce/buy/everything_bundle/approve/ord-bf-bundle-1?gt=${encodeURIComponent(bundleGt)}`);
  ok(a.status === 200, 'bf: bundle approve with the real token renders the success page');
  const bundleCodeMatch = a.text.match(/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/);
  ok(!!bundleCodeMatch, 'bf: bundle success page shows the unlock code');
  const bundleCode = bundleCodeMatch && bundleCodeMatch[0];
  r = await anon('POST', '/api/brambleforce/redeem', { __json: { code: bundleCode } });
  j = null; try { j = JSON.parse(r.text); } catch (e) { /* asserted below */ }
  ok(r.status === 200 && j && j.product === 'everything_bundle', 'bf: bundle redeem returns {product:"everything_bundle"}');
  ok(j && Array.isArray(j.grants) && j.grants.length === 15
    && ['fighter_zola', 'fighter_otto', 'fighter_yusuf'].every((id) => j.grants.includes(id)),
    'bf: bundle redeem carries the full 15-extra grant set incl. all three fighters');
  r = await anon('POST', '/api/brambleforce/redeem', { __json: { code: bundleCode } });
  j = null; try { j = JSON.parse(r.text); } catch (e) { /* asserted below */ }
  ok(j && j.error === 'spent', 'bf: a second bundle redeem answers {error:"spent"}');

  // 10. Rotation system (owner order + bundle-boundary ruling,
  // 2026-10-31): dated availability windows gate PURCHASE only, drops
  // group limited products on the storefront, and the Everything
  // Bundle grants the LAUNCH 15 forever — drop/limited products are
  // excluded by drop membership, never granted, even when they share
  // a product class with launch items.
  // -- window state machine (bounds inclusive, America/Chicago dates)
  const win = { availableFrom: '2026-12-01', availableTo: '2026-12-31' };
  ok(bfLib.windowState(win, '2026-11-30') === 'before', 'bf-rot: day before the window is "before"');
  ok(bfLib.windowState(win, '2026-12-01') === 'open', 'bf-rot: first window day is "open" (inclusive start)');
  ok(bfLib.windowState(win, '2026-12-31') === 'open', 'bf-rot: last window day is "open" (inclusive end)');
  ok(bfLib.windowState(win, '2027-01-01') === 'after', 'bf-rot: day after the window is "after"');
  ok(bfLib.windowState({}, '2026-10-31') === 'open', 'bf-rot: a product with no window is always open');
  ok(bfLib.windowState(bfLib.PRODUCTS.war_bond, '2031-05-05') === 'open',
    'bf-rot: launch products carry no window and never expire');
  ok(bfLib.isPurchasable(bfLib.PRODUCTS.game) && bfLib.isPurchasable(bfLib.PRODUCTS.skin_tor),
    'bf-rot: launch products are purchasable today');
  ok(bfLib.purchasableIds().length === 17
    && bfLib.purchasableIds().every((id) => bfLib.LAUNCH_PRODUCT_IDS.includes(id)),
    'bf-rot: exactly the 17 launch products are purchasable today (seeded drop is dark)');
  // -- the seeded December proof drop: shape only, never stock
  const proofIds = ['skin_tor_frostpine', 'skin_mara_holly', 'tracer_snowfall', 'weapon_fx_frostbite'];
  for (const pid of proofIds) {
    const pp = bfLib.PRODUCTS[pid];
    ok(!!pp && pp.disabled === true && pp.drop === '2026-12-winter'
      && pp.availableFrom === '2026-12-01' && pp.availableTo === '2026-12-31' && pp.priceCents === 99,
      `bf-rot: seeded drop member ${pid} is disabled, windowed Dec 2026, $0.99-class`);
    ok(!bfLib.isPurchasable(pp, '2026-12-15'), `bf-rot: ${pid} is not purchasable even inside its window while disabled`);
  }
  ok(bfLib.DROPS['2026-12-winter'] && /Kringle/.test(bfLib.DROPS['2026-12-winter'].label),
    'bf-rot: the proof drop is a named drop in the DROPS registry');
  // -- bundle boundary: launch 15 only, gated on drop membership
  ok(bfLib.BUNDLE_GRANTS.length === 15
    && bfLib.BUNDLE_GRANTS.every((id) => bfLib.LAUNCH_PRODUCT_IDS.includes(id) && !bfLib.PRODUCTS[id].drop),
    'bf-rot: bundle grants are exactly launch products with no drop member among them');
  ok(proofIds.every((id) => !bfLib.BUNDLE_GRANTS.includes(id)),
    'bf-rot: no drop product is in the bundle grant set (limited editions sell separately)');
  // -- drop lifecycle at the lib level (time travel; the seeded
  // members are flipped live IN THIS PROCESS ONLY — the HTTP server
  // is a separate process and keeps them disabled, asserted below)
  ok(bfLib.dropInfo() === null, 'bf-rot: no drop is active today (the seeded drop is disabled)');
  ok(bfLib.dropInfo('2026-12-15') === null, 'bf-rot: a fully disabled drop renders nothing even inside its window');
  const savedDisabled = proofIds.map((id) => bfLib.PRODUCTS[id].disabled);
  try {
    proofIds.forEach((id) => { bfLib.PRODUCTS[id].disabled = false; });
    const active = bfLib.dropInfo('2026-12-15');
    ok(!!active && active.mode === 'active' && active.id === '2026-12-winter'
      && active.productIds.length === 4 && active.endsLabel === 'Dec 31',
      'bf-rot: an enabled in-window drop is active and states its end ("Dec 31")');
    const ended = bfLib.dropInfo('2027-01-10');
    ok(!!ended && ended.mode === 'ended' && ended.productIds.length === 4 && ended.endedLabel === 'Dec 31',
      'bf-rot: a drop whose window passed within 30 days reads as ended/retired');
    ok(bfLib.dropInfo('2027-03-15') === null, 'bf-rot: the retired section is gone 30+ days after the drop ends');
  } finally {
    proofIds.forEach((id, i) => { bfLib.PRODUCTS[id].disabled = savedDisabled[i]; });
  }
  // -- HTTP: the dark drop stays dark end to end
  a = await anon('GET', '/brambleforce');
  ok(!a.text.includes("This Month's Drop") && !a.text.includes('drop has ended')
    && !a.text.includes('/brambleforce/buy/skin_tor_frostpine') && !a.text.includes('Frostpine'),
    'bf-rot: landing shows no drop section and no seeded-drop product while the drop is disabled');
  a = await anon('GET', '/brambleforce/buy/skin_tor_frostpine');
  ok(a.status === 404, 'bf-rot: a disabled product buy page 404s');
  const ordersBeforeRot = tdb.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  a = await anon('POST', '/brambleforce/buy/skin_tor_frostpine/buy', { guest_email: 'bfrot@test.local' });
  ok(a.status === 404, 'bf-rot: a disabled product buy POST is refused (404)');
  ok(tdb.prepare('SELECT COUNT(*) AS n FROM orders').get().n === ordersBeforeRot,
    'bf-rot: a refused buy POST mints no order (checkout cannot mint an unpurchasable product)');
  // -- redemption is never window-gated: the crt_filter code redeemed
  // in section 4 was spent on first use; a fresh paid code for a
  // launch product still redeems — and bundle grants stayed the
  // launch 15 through every catalogue addition above (section 9 ran
  // against the same code path; the grant set is pinned there too).
}

module.exports = { runHttpTests };
