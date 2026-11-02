// Chorvix verification layer tests (migration 122, 2026-11-01).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers the contract (src/routes/onemindVerify.js + lib/seatVerify):
// short-lived sessions over the one seat, verified from two platform
// contexts; refresh rotation and reuse lockdown; revocation;
// entitlements computed from server truth only (orders, bindings,
// verified Play rows); claim checks that record unproven claims;
// unlock-code redemption binding to a seat, with replay rejected.
const crypto = require('crypto');
const BASE = 'http://localhost:4137';

// Cross-phase stash: the account, its orders and its minted code are
// created in the db phase and exercised over HTTP in the http phase
// (same test DB file, spawned server).
const stash = {};

async function runDbTests(ok) {
  console.log('chorvix verify (sessions, entitlements, the watch):');
  const db = require('../src/db');
  const seatVerify = require('../src/lib/seatVerify');
  const bf = require('../src/lib/brambleforce');

  const apiToken = 'chorvix-test-seat-key';
  const uid = await db.insert('users', {
    email: 'chorvix-verify@test.local', password_hash: 'x', role: 'customer',
    display_name: 'Verify', api_token: apiToken,
  });
  stash.uid = uid;
  stash.apiToken = apiToken;
  const user = await db.get('SELECT * FROM users WHERE id = ?', [uid]);

  // --- sessions -----------------------------------------------------
  const opened = await seatVerify.openSession(user, {
    surface: 'brambleforce-game', platform: 'android',
    clientRoot: true, clientBuild: '1.3.0',
  });
  ok(opened.ok === true, 'session opens for a seated account');
  ok(/^cxs_[0-9a-f]{64}$/.test(opened.session_token), 'session token is a cxs_ token');
  ok(/^cxr_[0-9a-f]{64}$/.test(opened.refresh_token), 'refresh token is a cxr_ token');
  const row = await db.get('SELECT * FROM seat_sessions WHERE id = ?', [opened.session_id]);
  ok(row && row.token_hash === seatVerify.hashToken(opened.session_token), 'only the token hash is stored');
  ok(row && row.token_hash !== opened.session_token, 'the raw session token is never at rest');
  // The root checker's record: declared, stored, never judged.
  ok(row && row.client_root === 'root', 'a declared root configuration is recorded as root');
  ok(row && row.platform === 'android', 'the platform context is recorded');

  const v = await seatVerify.verifySessionToken(opened.session_token);
  ok(v.ok === true && v.user.id === uid, 'a live session verifies — root and all (root is welcome)');
  const bad = await seatVerify.verifySessionToken('cxs_' + '0'.repeat(64));
  ok(bad.ok === false && bad.error === 'session_unknown', 'a forged session token is refused as unknown');
  const failEvents = await db.all("SELECT * FROM verify_events WHERE kind = 'verify_fail'");
  ok(failEvents.length >= 1, 'the refused verify is written to the watch');

  // Kids' surfaces can never hold a session either (registry law).
  const kid = await seatVerify.openSession(user, { surface: 'little-inkers-app', platform: 'android' });
  ok(kid.ok === false && kid.error === 'surface_not_tieable', 'a kids surface seats no session');

  // --- refresh rotation + reuse lockdown -----------------------------
  const s2 = await seatVerify.openSession(user, { surface: 'brambleforce-game', platform: 'ios' });
  const rotated = await seatVerify.refreshSession(s2.refresh_token);
  ok(rotated.ok === true && rotated.session_token !== s2.session_token, 'refresh rotates to a fresh pair');
  const oldAfterRotate = await seatVerify.verifySessionToken(s2.session_token);
  ok(oldAfterRotate.ok === false && oldAfterRotate.error === 'session_revoked', 'the rotated-away session is dead');
  const reuse = await seatVerify.refreshSession(s2.refresh_token);
  ok(reuse.ok === false && reuse.error === 'refresh_reused', 'reusing a rotated refresh token is refused');
  const freshAfterReuse = await seatVerify.verifySessionToken(rotated.session_token);
  ok(freshAfterReuse.ok === false && freshAfterReuse.error === 'session_revoked',
    'refresh reuse revokes every live session of the seat');
  const reuseEvents = await db.all("SELECT * FROM verify_events WHERE kind = 'refresh_reuse' AND user_id = ?", [uid]);
  ok(reuseEvents.length === 1, 'the reuse is recorded in the watch exactly once');

  // --- revocation + expiry -------------------------------------------
  const s3 = await seatVerify.openSession(user, { platform: 'firetv' });
  const rv = await seatVerify.revokeSession({ sessionToken: s3.session_token });
  ok(rv.ok === true, 'revoke by session token works');
  const vRevoked = await seatVerify.verifySessionToken(s3.session_token);
  ok(vRevoked.ok === false && vRevoked.error === 'session_revoked', 'a revoked session no longer verifies');
  const expToken = 'cxs_' + crypto.randomBytes(32).toString('hex');
  const expRefresh = 'cxr_' + crypto.randomBytes(32).toString('hex');
  const past = db.now() - 1000;
  await db.insert('seat_sessions', {
    user_id: uid, token_hash: seatVerify.hashToken(expToken), refresh_hash: seatVerify.hashToken(expRefresh),
    surface: null, platform: 'web', client_root: 'unknown', client_build: null,
    created_at: past - 10000, expires_at: past, refresh_expires_at: past + 10000, last_seen_at: past,
    revoked_at: null, revoke_reason: null,
  });
  const vExpired = await seatVerify.verifySessionToken(expToken);
  ok(vExpired.ok === false && vExpired.error === 'session_expired', 'an expired session is refused as expired');

  // --- entitlements from server truth ---------------------------------
  await db.insert('orders', {
    buyer_id: uid, order_type: 'brambleforce:fighter_zola', amount_cents: 199,
    fee_cents: 0, status: 'paid', payment_method: 'paypal', paid_at: db.now(),
  });
  const bundleOrderId = await db.insert('orders', {
    buyer_id: uid, order_type: 'brambleforce:everything_bundle', amount_cents: 2799,
    fee_cents: 0, status: 'paid', payment_method: 'paypal', paid_at: db.now(),
  });
  await db.insert('orders', {
    buyer_id: uid, order_type: 'brambleforce:skin_tor', amount_cents: 99,
    fee_cents: 0, status: 'pending', payment_method: 'paypal', paid_at: null,
  });
  await db.insert('play_purchases', {
    product_id: 'bf_play_skin_test', purchase_token: 'chorvix-test-purchase-token',
    purchase_type: 'inapp', status: 'verified', email: '', user_id: uid, verified_at: db.now(),
  });
  const truth = await seatVerify.entitlementsFor(user);
  ok(truth.products.includes('fighter_zola'), 'a paid website order entitles its product');
  ok(truth.products.includes('everything_bundle'), 'the bundle order entitles the bundle');
  ok(truth.products.includes('skin_tor'), 'the bundle grant set entitles launch skins');
  ok(!truth.products.includes('skin_tor_frostpine'), 'a monthly-drop skin is NEVER in the bundle grant set');
  ok(truth.products.includes('bf_play_skin_test'), 'a verified Play purchase entitles under its Play id');
  const skinTor = truth.entitlements.find((e) => e.product === 'skin_tor');
  ok(skinTor && skinTor.source === 'order_bundle',
    'an unpaid direct order does not shadow the bundle grant (truth is paid records only)');

  // The unproven claim is a monthly-drop skin: in the catalogue,
  // owned by nobody, and NEVER in the bundle grant set — so even a
  // bundle owner cannot hold it. (queens_hunt would be a false
  // example here: the bundle legitimately grants it.)
  const check = await seatVerify.checkClaims(user, ['fighter_zola', 'skin_tor_frostpine']);
  ok(check.results[0].entitled === true && check.results[0].source === 'order', 'a true claim checks out');
  ok(check.results[1].entitled === false && check.results[1].source === null, 'an unproven claim is answered entitled:false');
  const mismatch = await db.all(
    "SELECT * FROM verify_events WHERE kind = 'claim_mismatch' AND user_id = ? AND detail = 'skin_tor_frostpine'", [uid]);
  ok(mismatch.length === 1, 'the unproven claim is recorded in the watch');

  // --- code binding at the lib level -----------------------------------
  // The code's order belongs to a GUEST ('' buyer sentinel) and the
  // product is a monthly-drop skin — the one class the bundle can
  // never grant (asserted unproven above). So after the binding,
  // the ONLY possible source of the entitlement is the code: a claim
  // that was false becomes true exactly when a real code binds.
  const codeOrderId = await db.insert('orders', {
    buyer_id: '', order_type: 'brambleforce:skin_tor_frostpine', amount_cents: 99,
    fee_cents: 0, status: 'paid', payment_method: 'paypal', paid_at: db.now(),
    guest_email: 'guest@test.local',
  });
  const codeOrder = await db.get('SELECT * FROM orders WHERE id = ?', [codeOrderId]);
  const issued = await bf.issueCodeForOrder(codeOrder, 'skin_tor_frostpine');
  ok(!!issued.code, 'an unlock code mints for the paid order');
  stash.code = issued.code;
  const codeRow = await db.get('SELECT * FROM brambleforce_codes WHERE order_id = ?', [codeOrderId]);
  await seatVerify.bindCodeRedemption(user, codeRow, 'skin_tor_frostpine', null);
  const truth2 = await seatVerify.entitlementsFor(user);
  ok(truth2.products.includes('skin_tor_frostpine'), 'a bound redemption entitles the seat durably');
  const boundRow = truth2.entitlements.find((e) => e.product === 'skin_tor_frostpine');
  ok(boundRow && boundRow.source === 'code' && boundRow.ref === codeRow.id,
    'the binding names its source (the code) — server truth, not a client claim');

  // A second code, left unbound + unspent, is redeemed over HTTP in
  // the http phase to prove the route-level binding + replay refusal.
  const codeOrder2Id = await db.insert('orders', {
    buyer_id: '', order_type: 'brambleforce:crt_filter', amount_cents: 99,
    fee_cents: 0, status: 'paid', payment_method: 'paypal', paid_at: db.now(),
    guest_email: 'guest@test.local',
  });
  const codeOrder2 = await db.get('SELECT * FROM orders WHERE id = ?', [codeOrder2Id]);
  const issued2 = await bf.issueCodeForOrder(codeOrder2, 'crt_filter');
  stash.code2 = issued2.code;

  // === CADENCE PASS fixtures (2026-11-01 20:34 + thief trap 20:40) ==
  // user2: the trap-proof seat — owns exactly one product by paid
  // order, nothing else. Its code (code3) is redeemed/replayed over
  // HTTP to spring the replay trap through the real door.
  const apiToken2 = 'cadence-test-seat-key';
  const uid2 = await db.insert('users', {
    email: 'cadence-trap@test.local', password_hash: 'x', role: 'customer',
    display_name: 'Cadence', api_token: apiToken2,
  });
  stash.uid2 = uid2;
  stash.apiToken2 = apiToken2;
  await db.insert('orders', {
    buyer_id: uid2, order_type: 'brambleforce:fighter_dane', amount_cents: 199,
    fee_cents: 0, status: 'paid', payment_method: 'paypal', paid_at: db.now(),
  });
  const codeOrder3Id = await db.insert('orders', {
    buyer_id: '', order_type: 'brambleforce:weapon_tracers', amount_cents: 99,
    fee_cents: 0, status: 'paid', payment_method: 'paypal', paid_at: db.now(),
    guest_email: 'guest2@test.local',
  });
  const codeOrder3 = await db.get('SELECT * FROM orders WHERE id = ?', [codeOrder3Id]);
  const issued3 = await bf.issueCodeForOrder(codeOrder3, 'weapon_tracers');
  stash.code3 = issued3.code;

  // user3: the sweep fixture — a code binding whose order is about
  // to be REFUNDED (source dies after the grant), a verified Play
  // row Google is about to disown, and one healthy binding that
  // must survive every sweep untouched.
  const uid3 = await db.insert('users', {
    email: 'cadence-sweep@test.local', password_hash: 'x', role: 'customer',
    display_name: 'Sweep', api_token: 'cadence-sweep-seat-key',
  });
  stash.uid3 = uid3;
  const user3 = await db.get('SELECT * FROM users WHERE id = ?', [uid3]);
  const refundOrderId = await db.insert('orders', {
    buyer_id: '', order_type: 'brambleforce:skin_dane', amount_cents: 99,
    fee_cents: 0, status: 'paid', payment_method: 'paypal', paid_at: db.now(),
    guest_email: 'guest3@test.local',
  });
  const refundOrder = await db.get('SELECT * FROM orders WHERE id = ?', [refundOrderId]);
  await bf.issueCodeForOrder(refundOrder, 'skin_dane');
  const refundCodeRow = await db.get('SELECT * FROM brambleforce_codes WHERE order_id = ?', [refundOrderId]);
  await seatVerify.bindCodeRedemption(user3, refundCodeRow, 'skin_dane', null);
  const keepOrderId = await db.insert('orders', {
    buyer_id: '', order_type: 'brambleforce:skin_mara', amount_cents: 99,
    fee_cents: 0, status: 'paid', payment_method: 'paypal', paid_at: db.now(),
    guest_email: 'guest3@test.local',
  });
  const keepOrder = await db.get('SELECT * FROM orders WHERE id = ?', [keepOrderId]);
  await bf.issueCodeForOrder(keepOrder, 'skin_mara');
  const keepCodeRow = await db.get('SELECT * FROM brambleforce_codes WHERE order_id = ?', [keepOrderId]);
  await seatVerify.bindCodeRedemption(user3, keepCodeRow, 'skin_mara', null);
  await db.insert('play_purchases', {
    product_id: 'bf_play_doomed', purchase_token: 'cadence-doomed-token',
    purchase_type: 'inapp', status: 'verified', email: '', user_id: uid3, verified_at: db.now(),
  });
  await db.insert('play_purchases', {
    product_id: 'bf_play_healthy', purchase_token: 'cadence-healthy-token',
    purchase_type: 'inapp', status: 'verified', email: '', user_id: uid3, verified_at: db.now(),
  });
  const truth3 = await seatVerify.entitlementsFor(user3);
  ok(truth3.products.includes('skin_dane') && truth3.products.includes('bf_play_doomed'),
    'sweep fixture: the seat holds the soon-to-die entitlements before the source dies');

  // The refund lands: the source of truth changes underneath the
  // granted entitlements. Nothing has pulled anything yet.
  await db.update('orders', refundOrderId, { status: 'refunded' });

  // (c) THE SWEEP catches the source-side change: a stub Google
  // that stands behind the healthy token and disowns the doomed one.
  const { runSweep } = require('../src/lib/entitlementSweep');
  const stubVerify = async ({ purchaseToken }) => (purchaseToken === 'cadence-doomed-token'
    ? { verified: false, reason: 'product not purchased' }
    : { verified: true });
  const sweep1 = await runSweep({ verifyFn: stubVerify });
  ok(sweep1.bindings_pulled >= 1, 'sweep: a binding whose order was refunded is pulled');
  ok(sweep1.play_revoked >= 1, 'sweep: a Play purchase Google disowns is revoked');
  const boundAfter = await db.get(
    "SELECT * FROM seat_entitlements WHERE user_id = ? AND product = 'skin_dane'", [uid3]);
  ok(boundAfter && boundAfter.revoked_at && boundAfter.revoke_reason === 'source_refunded',
    'sweep: the pulled binding records why (source_refunded)');
  const doomedRow = await db.get(
    "SELECT * FROM play_purchases WHERE purchase_token = 'cadence-doomed-token'");
  ok(doomedRow && doomedRow.status === 'revoked', 'sweep: the disowned Play row flips to revoked');
  const healthyRow = await db.get(
    "SELECT * FROM play_purchases WHERE purchase_token = 'cadence-healthy-token'");
  ok(healthyRow && healthyRow.status === 'verified' && healthyRow.recheck_at,
    'sweep: the healthy Play row stays verified and its recheck cursor moves');
  const truth3b = await seatVerify.entitlementsFor(user3);
  ok(!truth3b.products.includes('skin_dane') && !truth3b.products.includes('bf_play_doomed'),
    'sweep: pulled entitlements no longer verify for the seat');
  ok(truth3b.products.includes('skin_mara') && truth3b.products.includes('bf_play_healthy'),
    'sweep: honestly-backed entitlements are untouched');
  const pullEvents = await db.all(
    "SELECT * FROM verify_events WHERE user_id = ? AND kind IN ('entitlement_pulled','play_purchase_revoked')", [uid3]);
  ok(pullEvents.length >= 2, 'sweep: every pull is written to the watch');

  // The pulls spring the thief trap on the seat (entitlement held
  // with no living source) — and this same run does NOT lift it.
  const trapAfterPull = await seatVerify.trapStateFor(uid3);
  ok(trapAfterPull.active === true && trapAfterPull.reason === 'unbacked_entitlement',
    'trap: a sweep pull springs the thief trap on the seat');
  const trapSetEvents = await db.all(
    "SELECT * FROM verify_events WHERE user_id = ? AND kind = 'trap_set'", [uid3]);
  ok(trapSetEvents.length >= 1, 'trap: the springing is written to the watch with its trigger');

  // A weather failure at Google (not a verdict) revokes NOTHING:
  // re-run with an erroring stub — statuses and cursors hold. (This
  // run pulls nothing for the trapped seat either, and everything
  // it still holds is backed — so this is also the first clean pass
  // after the pull, and the trap lifts on it: reconciliation, not
  // the calendar, is what ends a trap.)
  const sweepErr = await runSweep({ verifyFn: async () => ({ verified: false, reason: 'socket hang up' }) });
  ok(sweepErr.play_revoked === 0, 'sweep: a transient Google error revokes nothing');
  const healthyRow2 = await db.get(
    "SELECT * FROM play_purchases WHERE purchase_token = 'cadence-healthy-token'");
  ok(healthyRow2 && healthyRow2.status === 'verified', 'sweep: honest purchases survive an outage');
  ok(sweepErr.traps_lifted >= 1, 'trap: the first clean sweep after the pull lifts the trap');

  // A further clean sweep changes nothing — the seat simply
  // verifies clean, no ban, no permanent state, resume play.
  const sweep2 = await runSweep({ verifyFn: stubVerify });
  const trapAfterClean = await seatVerify.trapStateFor(uid3);
  ok(trapAfterClean.active === false, 'trap: the seat verifies clean again after reconciliation');
  const liftEvents = await db.all(
    "SELECT * FROM verify_events WHERE user_id = ? AND kind = 'trap_lifted'", [uid3]);
  ok(liftEvents.length >= 1, 'trap: the lift is written to the watch');

  // Strike path at the lib level, in the trap's NARROWED class
  // (owner scope lock 2026-11-01 20:58 — PAID content only):
  // forged claims on FREE / base / never-sold items are answered
  // and recorded but are NOT strikes and can never trap; forged
  // claims on PAID items strike, and the third springs the trap;
  // one fully clean claim check lifts it.
  const uid4 = await db.insert('users', {
    email: 'cadence-strikes@test.local', password_hash: 'x', role: 'customer',
    display_name: 'Strikes', api_token: 'cadence-strikes-seat-key',
  });
  const user4 = await db.get('SELECT * FROM users WHERE id = ?', [uid4]);
  await db.insert('orders', {
    buyer_id: uid4, order_type: 'brambleforce:fighter_zola', amount_cents: 199,
    fee_cents: 0, status: 'paid', payment_method: 'paypal', paid_at: db.now(),
  });
  ok(seatVerify.isPaidProduct('skin_tor') === true && seatVerify.isPaidProduct('base_skin_tor') === false,
    'scope lock: the paid catalogue defines the trap\'s jurisdiction');
  await seatVerify.checkClaims(user4, ['base_skin_tor']);
  await seatVerify.checkClaims(user4, ['free_emote_wave']);
  await seatVerify.checkClaims(user4, ['starter_tracer']);
  const freeStrikes = await seatVerify.strikeCountFor(uid4);
  ok(freeStrikes === 0, 'scope lock: forged claims on FREE items are not strikes');
  const trapAfterFree = await seatVerify.trapStateFor(uid4);
  ok(trapAfterFree.active === false, 'scope lock: a forged claim on a FREE item does NOT trap');
  const freeMismatchEvents = await db.all(
    "SELECT * FROM verify_events WHERE user_id = ? AND kind = 'claim_mismatch'", [uid4]);
  ok(freeMismatchEvents.length === 3, 'scope lock: free claims are still answered + recorded in the watch');
  await seatVerify.checkClaims(user4, ['skin_tor']);
  await seatVerify.checkClaims(user4, ['crt_filter']);
  const trapBefore3 = await seatVerify.trapStateFor(uid4);
  ok(trapBefore3.active === false, 'trap: two forged PAID claims are strikes, not yet a trap (asking is recorded, not punished)');
  await seatVerify.checkClaims(user4, ['war_bond']);
  const trapAt3 = await seatVerify.trapStateFor(uid4);
  ok(trapAt3.active === true && trapAt3.reason === 'repeated_forged_claims',
    'scope lock: a forged claim on a PAID item traps — the third paid strike springs it');
  const strikeEvents = await db.all(
    "SELECT * FROM verify_events WHERE user_id = ? AND kind = 'claim_strike'", [uid4]);
  ok(strikeEvents.length === 3, 'trap audit: every strike is in the watch as evidence (seat, product, time)');
  await seatVerify.checkClaims(user4, ['fighter_zola']);
  const trapAfterCleanCheck = await seatVerify.trapStateFor(uid4);
  ok(trapAfterCleanCheck.active === false, 'trap: a fully clean claim check lifts the trap');

  // === FALSE-POSITIVE GUARD fixtures (owner guardrail 2026-11-01
  // 20:57): user5 is the honest odd-setup seat — sideload buyer
  // (paid 'game' via a sideload order), one paid fighter, one
  // unspent unlock code, an EXPIRED session row (ambiguous signal),
  // and a root declaration on every session it opens (db phase
  // mints the code + the expired row; the HTTP phase runs it
  // through the full event table).
  const apiToken5 = 'cadence-guard-seat-key';
  const uid5 = await db.insert('users', {
    email: 'cadence-guard@test.local', password_hash: 'x', role: 'customer',
    display_name: 'Guard', api_token: apiToken5,
  });
  stash.uid5 = uid5;
  stash.apiToken5 = apiToken5;
  await db.insert('orders', {
    buyer_id: uid5, order_type: 'sideload:com.usefulappz.game2runandgun', amount_cents: 699,
    fee_cents: 0, status: 'paid', payment_method: 'paypal', paid_at: db.now(),
  });
  // A second gated download (the cadence-gate fixture package) for
  // the guard's download-token leg of the event table.
  await db.insert('orders', {
    buyer_id: uid5, order_type: 'sideload:com.usefulappz.cadencegate', amount_cents: 699,
    fee_cents: 0, status: 'paid', payment_method: 'paypal', paid_at: db.now(),
  });
  await db.insert('orders', {
    buyer_id: uid5, order_type: 'brambleforce:fighter_otto', amount_cents: 199,
    fee_cents: 0, status: 'paid', payment_method: 'paypal', paid_at: db.now(),
  });
  const codeOrder5Id = await db.insert('orders', {
    buyer_id: '', order_type: 'brambleforce:skin_selene', amount_cents: 99,
    fee_cents: 0, status: 'paid', payment_method: 'paypal', paid_at: db.now(),
    guest_email: 'guest5@test.local',
  });
  const codeOrder5 = await db.get('SELECT * FROM orders WHERE id = ?', [codeOrder5Id]);
  const issued5 = await bf.issueCodeForOrder(codeOrder5, 'skin_selene');
  stash.code5 = issued5.code;
  const expToken5 = 'cxs_' + crypto.randomBytes(32).toString('hex');
  const expRefresh5 = 'cxr_' + crypto.randomBytes(32).toString('hex');
  const past5 = db.now() - 1000;
  await db.insert('seat_sessions', {
    user_id: uid5, token_hash: seatVerify.hashToken(expToken5), refresh_hash: seatVerify.hashToken(expRefresh5),
    surface: null, platform: 'android', client_root: 'root', client_build: 'sideload-1.3.0',
    created_at: past5 - 10000, expires_at: past5, refresh_expires_at: past5 + 10000, last_seen_at: past5,
    revoked_at: null, revoke_reason: null,
  });
  stash.expiredToken5 = expToken5;
}

async function runHttpTests(ok) {
  console.log('chorvix verify (over HTTP, two platforms, redeem binding):');
  const TOKEN = process.env.MUSE_SERVICE_TOKEN;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, text, json, headers: res.headers };
  };

  let r = await call('GET', '/api/onemind/verify/health');
  ok(r.status === 200 && r.json && r.json.ok === true && r.json.db === true && r.json.service === 'chorvix-verify',
    'the verify layer answers its own health door');

  // (d) the same seat verifies from two platform contexts.
  r = await call('POST', '/api/onemind/session',
    { surface: 'brambleforce-game', platform: 'android', client: { root: true, build: '1.3.0' } },
    { 'x-api-token': stash.apiToken });
  ok(r.status === 200 && r.json && r.json.ok === true, 'session opens over HTTP with the seat key');
  const android = r.json;
  ok(android.seat && /^om_[0-9a-f]{24}$/.test(android.seat.onemind_id || ''), 'the seat carries its canonical om_ id');
  r = await call('POST', '/api/onemind/verify', {}, { authorization: `Bearer ${android.session_token}` });
  ok(r.status === 200 && r.json && r.json.ok === true && r.json.seat.onemind_id === android.seat.onemind_id,
    'the android session verifies');
  ok(r.json.session && r.json.session.client_root === 'root', 'the verify answer carries the recorded root declaration');

  r = await call('POST', '/api/onemind/session',
    { surface: 'brambleforce-game', platform: 'ios' },
    { 'x-api-token': stash.apiToken });
  ok(r.status === 200 && r.json && r.json.ok === true, 'a second session opens from the ios context');
  const ios = r.json;
  ok(ios.seat.onemind_id === android.seat.onemind_id, 'both platforms resolve to the SAME seat');
  r = await call('POST', '/api/onemind/verify', {}, { 'x-session-token': ios.session_token });
  ok(r.status === 200 && r.json && r.json.ok === true && r.json.session.platform === 'ios',
    'the ios session verifies as its own platform row');

  r = await call('POST', '/api/onemind/verify', {}, { authorization: `Bearer cxs_${'f'.repeat(64)}` });
  ok(r.status === 401 && r.json && r.json.error === 'session_unknown', 'a forged session token is refused over HTTP');
  r = await call('POST', '/api/onemind/session', { platform: 'android' }, {});
  ok(r.status === 401, 'session open without a seat proof is refused');

  // (a) real seat + real entitlement verifies.
  r = await call('GET', '/api/onemind/entitlements', undefined, { authorization: `Bearer ${android.session_token}` });
  ok(r.status === 200 && r.json && r.json.products.includes('fighter_zola'),
    'entitlements answer from server truth (paid order)');
  ok(r.json.products.includes('skin_tor_frostpine'), 'entitlements include the db-phase code binding');
  r = await call('POST', '/api/onemind/entitlements/check',
    { claims: ['fighter_zola', 'skin_mara_holly'] }, { authorization: `Bearer ${android.session_token}` });
  ok(r.status === 200 && r.json.results[0].entitled === true && r.json.results[1].entitled === false,
    'claim check separates the proven from the unproven');

  // (b)+(c) redeem with a seat proof binds; replay and forgery are
  // rejected and recorded. The legacy no-proof response shape is
  // pinned by test/brambleforce.js; here the proof is presented.
  r = await call('POST', '/api/brambleforce/redeem', { code: stash.code2 }, { 'x-api-token': stash.apiToken });
  ok(r.status === 200 && r.json && r.json.product === 'crt_filter' && r.json.bound === true,
    'redeem with a seat proof returns the product AND binds it');
  r = await call('GET', '/api/onemind/entitlements', undefined, { 'x-api-token': stash.apiToken });
  ok(r.status === 200 && r.json.products.includes('crt_filter'), 'the bound unlock now verifies on the seat');
  r = await call('POST', '/api/brambleforce/redeem', { code: stash.code2 }, { 'x-api-token': stash.apiToken });
  ok(r.status === 200 && r.json && r.json.error === 'spent', 'a replayed code is rejected as spent');
  r = await call('POST', '/api/brambleforce/redeem', { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' }, { 'x-api-token': stash.apiToken });
  ok(r.status === 200 && r.json && r.json.error === 'unknown', 'a forged code is rejected as unknown');

  // Refresh + revoke over HTTP.
  r = await call('POST', '/api/onemind/session/refresh', { refresh_token: ios.refresh_token });
  ok(r.status === 200 && r.json && r.json.ok === true && r.json.session_token !== ios.session_token,
    'refresh over HTTP rotates the pair');
  const ios2 = r.json;
  r = await call('POST', '/api/onemind/session/revoke', { session_token: ios2.session_token });
  ok(r.status === 200 && r.json && r.json.revoked === true, 'revoke over HTTP lands');
  r = await call('POST', '/api/onemind/verify', {}, { authorization: `Bearer ${ios2.session_token}` });
  ok(r.status === 401 && r.json && r.json.error === 'session_revoked', 'the revoked session stops verifying at once');

  // === CADENCE + THIEF TRAP over HTTP (user2, the trap seat) =======
  // (d) honest traffic first: a real seat with a root declaration
  // opens, verifies, reads its truth — and its trap is OFF.
  r = await call('POST', '/api/onemind/session',
    { surface: 'brambleforce-game', platform: 'android', client: { root: true, build: '1.3.0' } },
    { 'x-api-token': stash.apiToken2 });
  ok(r.status === 200 && r.json && r.json.ok === true, 'cadence: the trap seat opens a session');
  const u2 = r.json;
  ok(u2.trap && u2.trap.active === false, 'trap: an honest seat opens with the trap OFF (root declared, never judged)');
  r = await call('POST', '/api/onemind/verify', {}, { authorization: `Bearer ${u2.session_token}` });
  ok(r.status === 200 && r.json.trap && r.json.trap.active === false, 'trap: verify shows the trap OFF for honest traffic');

  // (a) MID-SESSION FORGERY: the valid session presents forged
  // entitlement claims. Each is refused + recorded; the third
  // springs the trap, visible in the NEXT verify response.
  r = await call('POST', '/api/onemind/entitlements/check',
    { claims: ['fighter_zola'] }, { authorization: `Bearer ${u2.session_token}` });
  ok(r.status === 200 && r.json.results[0].entitled === false, 'cadence: a forged claim mid-session is refused at the claim event');
  await call('POST', '/api/onemind/entitlements/check',
    { claims: ['skin_mara'] }, { authorization: `Bearer ${u2.session_token}` });
  await call('POST', '/api/onemind/entitlements/check',
    { claims: ['everything_bundle'] }, { authorization: `Bearer ${u2.session_token}` });
  r = await call('POST', '/api/onemind/verify', {}, { authorization: `Bearer ${u2.session_token}` });
  ok(r.status === 200 && r.json.trap && r.json.trap.active === true && r.json.trap.reason === 'repeated_forged_claims',
    'trap: forged claims spring the trap — the next verify response shows it ON with its reason class');

  // Clean reconciliation lifts it: a claim check where everything
  // claimed is truly owned (fighter_dane, by paid order).
  r = await call('POST', '/api/onemind/entitlements/check',
    { claims: ['fighter_dane'] }, { authorization: `Bearer ${u2.session_token}` });
  ok(r.status === 200 && r.json.results[0].entitled === true, 'cadence: the seat\'s real entitlement still checks out while trapped');
  r = await call('POST', '/api/onemind/verify', {}, { authorization: `Bearer ${u2.session_token}` });
  ok(r.status === 200 && r.json.trap && r.json.trap.active === false,
    'trap: clean reconciliation lifts it — the next verify response shows it OFF');

  // (b) REPLAYED UNLOCK springs the trap through the redeem door
  // itself: first redeem binds (trap field rides the response),
  // the replay is rejected AND the response carries the trap.
  r = await call('POST', '/api/brambleforce/redeem', { code: stash.code3 }, { 'x-api-token': stash.apiToken2 });
  ok(r.status === 200 && r.json && r.json.product === 'weapon_tracers' && r.json.bound === true
    && r.json.trap && r.json.trap.active === false,
    'trap: a first redeem binds, trap OFF in the redeem response');
  r = await call('POST', '/api/brambleforce/redeem', { code: stash.code3 }, { 'x-api-token': stash.apiToken2 });
  ok(r.status === 200 && r.json && r.json.error === 'spent' && r.json.trap && r.json.trap.active === true
    && r.json.trap.reason === 'replayed_unlock',
    'trap: the replayed unlock is rejected AND the redeem response carries the sprung trap');

  // (b) REPLAY AFTER REVOCATION: the seat's session is revoked,
  // then the dead session is presented at the claim door — refused
  // at the event, and the refusal is in the watch.
  r = await call('POST', '/api/onemind/session/revoke', { session_token: u2.session_token });
  ok(r.status === 200 && r.json.revoked === true, 'cadence: the trap seat\'s session revokes');
  r = await call('POST', '/api/onemind/entitlements/check',
    { claims: ['fighter_dane'] }, { authorization: `Bearer ${u2.session_token}` });
  ok(r.status === 401, 'cadence: a claim presented with a revoked session is refused at the event');

  // The sweep door (house token) reconciles: user2's holdings are
  // all backed (the tracers binding traces to a paid order), so
  // this clean run lifts the replay trap.
  r = await call('POST', '/api/onemind/sweep', undefined, { authorization: `Bearer ${TOKEN}` });
  ok(r.status === 200 && r.json && r.json.ok === true && r.json.sweep && typeof r.json.sweep.bindings_checked === 'number',
    'cadence: the sweep runs on demand for the house token');
  r = await call('POST', '/api/onemind/session',
    { surface: 'brambleforce-game', platform: 'android' }, { 'x-api-token': stash.apiToken2 });
  ok(r.status === 200 && r.json.trap && r.json.trap.active === false,
    'trap: after the clean sweep the session opens with the trap OFF (lifted, never banned)');

  // (b) DOWNLOAD REPLAY AFTER REFUND: an update token minted for a
  // paid sideload order works while the order stands; the moment
  // the order is refunded the same token is refused at the gate —
  // and the refusal lands in the watch.
  {
    const db = require('../src/db');
    await db.init(); // the unit phase closed the handle (run.js); HTTP fixtures re-open it
    const fs = require('fs');
    const path = require('path');
    const crypto2 = require('crypto');
    const updateTokens = require('../src/lib/updateTokens');
    // Seed a dedicated gated package into the test registry (merged
    // with whatever is already there) + its tiny APK — the same
    // production flow the appUpdates tests use.
    const pkg = 'com.usefulappz.cadencegate';
    const apkBytes = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('fake-apk-bytes-for-the-cadence-gate-test'),
    ]);
    let registry = {};
    try { registry = JSON.parse(fs.readFileSync(process.env.APP_UPDATES_REGISTRY, 'utf8')); } catch (e) { /* fresh */ }
    registry[pkg] = {
      versionCode: 1, versionName: '1.0.0', notes: 'cadence gate fixture',
      sha256: crypto2.createHash('sha256').update(apkBytes).digest('hex'),
      sizeBytes: apkBytes.length, publishedAt: 1760000000000, gated: true,
    };
    fs.writeFileSync(process.env.APP_UPDATES_REGISTRY, JSON.stringify(registry, null, 2));
    const uploadDir = process.env.UPLOAD_DIR || path.join(process.env.ASSET_DIR, 'uploads');
    const apkDir = path.join(uploadDir, 'app-updates');
    fs.mkdirSync(apkDir, { recursive: true });
    fs.writeFileSync(path.join(apkDir, `${pkg}.apk`), apkBytes);
    const dlOrderId = await db.insert('orders', {
      buyer_id: stash.uid2, order_type: `sideload:${pkg}`, amount_cents: 699,
      fee_cents: 0, status: 'paid', payment_method: 'paypal', paid_at: db.now(),
    });
    const dlToken = updateTokens.issue(dlOrderId, pkg);
    r = await call('GET', `/api/apps/${pkg}/apk?t=${encodeURIComponent(dlToken)}`);
    ok(r.status !== 401, 'cadence: a paid order\'s download token passes the gate while the order stands');
    await db.update('orders', dlOrderId, { status: 'refunded' });
    r = await call('GET', `/api/apps/${pkg}/apk?t=${encodeURIComponent(dlToken)}`);
    ok(r.status === 401, 'cadence: the same token replayed after the refund is refused at the gate');
    const gateEvents = await db.all(
      "SELECT * FROM verify_events WHERE kind = 'download_gate_rejected' AND detail LIKE ?", [`${pkg}:%`]);
    ok(gateEvents.length >= 1, 'cadence: the gate refusal is written to the watch');
    // A forged token (valid shape, wrong HMAC) is refused + logged.
    r = await call('GET', `/api/apps/${pkg}/apk?t=${encodeURIComponent(dlOrderId + '.' + '0'.repeat(32))}`);
    ok(r.status === 401, 'cadence: a forged download token is refused at the gate');
  }

  // A refused seat check at the relay's door is in the watch too.
  r = await call('GET', '/api/onemind/seat', undefined, { 'x-api-token': 'forged-relay-token' });
  ok(r.status === 401, 'cadence: a forged seat token is refused at the relay\'s check door');
  {
    const db = require('../src/db');
    const seatFails = await db.all(
      "SELECT * FROM verify_events WHERE kind = 'seat_check_fail'");
    ok(seatFails.length >= 1, 'cadence: the refused seat check is written to the watch');
    const seatDoor = await call('GET', '/api/onemind/seat', undefined, { 'x-api-token': stash.apiToken2 });
    ok(seatDoor.status === 200 && Array.isArray(seatDoor.json.entitled_products)
      && seatDoor.json.entitled_products.includes('fighter_dane'),
    'cadence: the seat door carries the seat\'s entitled products for the relay\'s claim enforcement');
  }

  // === FALSE-POSITIVE GUARD (owner guardrail 2026-11-01 20:57) ===
  // User5 is an honest player with an odd-but-legit setup: ROOT
  // declared on every session, a SIDELOAD install (the game bought
  // direct, not through a store), a controller-era build string —
  // and only legitimate claims. It runs the FULL event table. The
  // trap must NEVER spring: not on its configuration, not on
  // ambiguous signals (an expired session, a mistyped token), not
  // on honest use of every door.
  r = await call('POST', '/api/onemind/session',
    { surface: 'brambleforce-game', platform: 'android', client: { root: true, build: 'sideload-1.3.0-controller' } },
    { 'x-api-token': stash.apiToken5 });
  ok(r.status === 200 && r.json && r.json.ok === true && r.json.trap && r.json.trap.active === false,
    'false-positive guard: root-declared sideload seat opens a session, trap OFF');
  const u5 = r.json;
  r = await call('POST', '/api/onemind/verify', {}, { authorization: `Bearer ${u5.session_token}` });
  ok(r.status === 200 && r.json.session.client_root === 'root' && r.json.trap.active === false,
    'false-positive guard: verify records the root declaration and does not judge it');
  r = await call('POST', '/api/onemind/session/refresh', { refresh_token: u5.refresh_token });
  ok(r.status === 200 && r.json.trap && r.json.trap.active === false,
    'false-positive guard: refresh rotates cleanly, trap OFF');
  const u5b = r.json;
  r = await call('GET', '/api/onemind/entitlements', undefined, { authorization: `Bearer ${u5b.session_token}` });
  ok(r.status === 200 && r.json.products.includes('game') && r.json.products.includes('fighter_otto'),
    'false-positive guard: sideload purchase + paid fighter read back as entitlements');
  r = await call('POST', '/api/onemind/entitlements/check',
    { claims: ['game', 'fighter_otto'] }, { authorization: `Bearer ${u5b.session_token}` });
  ok(r.status === 200 && r.json.results.every((x) => x.entitled),
    'false-positive guard: claiming only what it owns checks out clean');
  r = await call('POST', '/api/brambleforce/redeem', { code: stash.code5 }, { 'x-api-token': stash.apiToken5 });
  ok(r.status === 200 && r.json && r.json.product === 'skin_selene' && r.json.bound === true
    && r.json.trap && r.json.trap.active === false,
    'false-positive guard: a first-use unlock code redeems + binds, trap OFF');
  {
    const db = require('../src/db');
    const updateTokens = require('../src/lib/updateTokens');
    const guardOrder = await db.get(
      "SELECT * FROM orders WHERE buyer_id = ? AND order_type = 'sideload:com.usefulappz.cadencegate'", [stash.uid5]);
    const guardToken = updateTokens.issue(guardOrder.id, 'com.usefulappz.cadencegate');
    r = await call('GET', `/api/apps/com.usefulappz.cadencegate/apk?t=${encodeURIComponent(guardToken)}`);
    ok(r.status !== 401, 'false-positive guard: the sideload buyer\'s download token passes the gate');
  }
  r = await call('GET', '/api/onemind/seat', undefined, { 'x-api-token': stash.apiToken5 });
  ok(r.status === 200 && r.json.entitled_products.includes('skin_selene'),
    'false-positive guard: the relay\'s seat check validates the honest seat (bound skin now in its truth)');
  // Ambiguous signals, thrown at the same seat: an EXPIRED session
  // and a FORGED token are refused as doors — and spring nothing.
  r = await call('POST', '/api/onemind/verify', {}, { authorization: `Bearer ${stash.expiredToken5}` });
  ok(r.status === 401 && r.json.error === 'session_expired',
    'false-positive guard: an expired session is refused as expired (ambiguous signal, not theft)');
  r = await call('POST', '/api/onemind/verify', {}, { authorization: `Bearer cxs_${'a'.repeat(64)}` });
  ok(r.status === 401 && r.json.error === 'session_unknown',
    'false-positive guard: a forged token is refused as unknown (no seat, no trap)');
  r = await call('POST', '/api/onemind/verify', {}, { authorization: `Bearer ${u5b.session_token}` });
  ok(r.status === 200 && r.json.trap && r.json.trap.active === false,
    'false-positive guard: after the full event table the honest odd-setup seat is STILL untrapped');
  {
    const db = require('../src/db');
    const seatVerify = require('../src/lib/seatVerify');
    const guardTrapEvents = await db.all(
      "SELECT * FROM verify_events WHERE user_id = ? AND kind = 'trap_set'", [stash.uid5]);
    const guardState = await seatVerify.trapStateFor(stash.uid5);
    ok(guardTrapEvents.length === 0 && guardState.active === false,
      'false-positive guard: no trap was ever set on the honest seat — zero trap_set events in the watch');
  }

  // The audit door: service token only, and the record is real.
  r = await call('GET', '/api/onemind/watch');
  ok(r.status === 401, 'the watch refuses anonymous readers');
  r = await call('GET', '/api/onemind/watch?limit=200', undefined, { authorization: `Bearer ${TOKEN}` });
  ok(r.status === 200 && r.json && r.json.ok === true, 'the watch opens for the house service token');
  const kinds = (r.json.events || []).map((e) => e.kind);
  ok(kinds.includes('redeem_bound') && kinds.includes('redeem_rejected') && kinds.includes('claim_mismatch'),
    'the watch holds the redemption + claim record');
  ok(typeof r.json.active_sessions === 'number' && r.json.active_by_platform.length >= 1,
    'the watch reports live sessions by platform');
  // Cadence surface: anomalies are ON the watch, not buried — sweep
  // status, pull counts, flagged + trapped seats.
  ok(r.json.anomalies && typeof r.json.anomalies.entitlements_pulled_24h === 'number'
    && Array.isArray(r.json.anomalies.flagged_seats) && Array.isArray(r.json.anomalies.trapped_seats),
    'cadence: the watch surfaces anomalies (pulls, flagged seats, trapped seats)');
  ok(r.json.sweep && typeof r.json.sweep.bindings_checked === 'number',
    'cadence: the watch carries the last sweep\'s summary');
  ok(kinds.includes('trap_set') && kinds.includes('trap_lifted') && kinds.includes('sweep_run'),
    'cadence: trap springs, trap lifts, and sweep runs are all in the watch record');
}

module.exports = { runDbTests, runHttpTests };
