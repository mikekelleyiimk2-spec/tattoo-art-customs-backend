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
}

module.exports = { runDbTests, runHttpTests };
