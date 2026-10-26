// OneMind Root tests (the table's own root, 2026-10-26).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers the lane's laws as executable assertions:
//  - every route is Muse service-token guarded (state included);
//  - seat + plug-point registration is metadata-only: credential
//    material smuggled in any field is a hard 400, unknown fields are
//    a hard 400, an unknown plug_class is a hard 400;
//  - the plug-in charge is COMPUTED per the Price of the Plug and
//    served next to every plug point: fleet = zero (house into
//    house), outside-with-subscription = the maker's own subscription
//    price carried in the bundle, outside-no-subscription = pays in
//    people;
//  - seat credentials register / rotate / revoke by sha256
//    FINGERPRINT ONLY through the write-only Service Plug vault — a
//    canary secret is refused (400) and its raw bytes never appear in
//    any response afterwards, including the GET state route (which
//    also never echoes a storage reference);
//  - writes are POST-only: GET on every write route is a 404;
//  - state serves the table's root view: the Codex seats registry
//    (>= 13 seats), the Codex plug points (>= 10), the settled price
//    entries (incl. the OneMind Team subscription at $9.99/mo), the
//    Price of the Plug law, the seat index, and the operation log
//    recording every root operation.
const BASE = 'http://localhost:4137';

async function runHttpTests(ok, req) {
  console.log('onemind root (root lane over the table):');
  const TOKEN = process.env.MUSE_SERVICE_TOKEN;
  const call = async (method, p, body, token) => {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, text, json };
  };

  const CANARY = 'CANARY-ONEMIND-ROOT-SECRET-77c21f-never-served';
  const FP1 = 'a1b2c3d4'.repeat(8);
  const FP2 = 'e5f6a7b8'.repeat(8);
  const SEAT_NAME = 'Root Table Fixture Seat';
  const CRED_NAME = 'Root Table Fixture Seat Credential';
  const OUT_SEAT = 'Fixture Outside Sub Seat';
  const PEOPLE_SEAT = 'Fixture People Payer Seat';
  const seen = [];
  const tracked = async (...args) => { const r = await call(...args); seen.push(r); return r; };

  // ---- Auth: the whole lane is service-token guarded ----
  ok((await tracked('GET', '/api/onemind-root/state')).status === 401,
    'onemind-root state rejects a missing token (401)');
  ok((await tracked('GET', '/api/onemind-root/state', undefined, 'wrong-token')).status === 401,
    'onemind-root state rejects a wrong token (401)');
  ok((await tracked('POST', '/api/onemind-root/seats/register', { name: SEAT_NAME })).status === 401,
    'onemind-root seat register rejects a missing token (401)');
  ok((await tracked('POST', '/api/onemind-root/credentials/register', {})).status === 401,
    'onemind-root credential register rejects a missing token (401)');

  // ---- Seat registration: whitelist + material discipline ----
  const seat = await tracked('POST', '/api/onemind-root/seats/register', {
    name: SEAT_NAME, seat_ai: 'Fixture AI',
    state: 'fixture seat — seated for the suite', availability: 'test',
    last_verified: '2026-10-26', actor: 'suite',
  }, TOKEN);
  ok(seat.status === 200 && seat.json.registered === SEAT_NAME,
    'seat register succeeds with the whitelist fields');
  const seatMaterial = await tracked('POST', '/api/onemind-root/seats/register', {
    name: 'Material Seat', about: `smuggled -----BEGIN PRIVATE KEY----- ${CANARY}`,
  }, TOKEN);
  ok(seatMaterial.status === 400, 'seat record carrying credential material -> 400');
  const seatUnknown = await tracked('POST', '/api/onemind-root/seats/register', {
    name: 'Unknown Field Seat', api_key: 'x',
  }, TOKEN);
  ok(seatUnknown.status === 400, 'seat record with an unknown field -> 400');

  // ---- Plug points: the charge is computed, never assumed ----
  const ppFleet = await tracked('POST', '/api/onemind-root/plugpoints/register', {
    name: SEAT_NAME + ' Plug Point', actor: 'suite',
  }, TOKEN);
  ok(ppFleet.status === 200 && ppFleet.json.registered === SEAT_NAME + ' Plug Point',
    'fleet plug point registers (default class fleet)');
  const ppSub = await tracked('POST', '/api/onemind-root/plugpoints/register', {
    name: OUT_SEAT, plug_class: 'outside_subscription',
    subscription_price: '$20/mo', actor: 'suite',
  }, TOKEN);
  ok(ppSub.status === 200, 'outside-subscription plug point registers');
  const ppPeople = await tracked('POST', '/api/onemind-root/plugpoints/register', {
    name: PEOPLE_SEAT, plug_class: 'outside_no_subscription', actor: 'suite',
  }, TOKEN);
  ok(ppPeople.status === 200, 'no-subscription plug point registers');
  const ppBadClass = await tracked('POST', '/api/onemind-root/plugpoints/register', {
    name: 'Bad Class Plug', plug_class: 'free_forever',
  }, TOKEN);
  ok(ppBadClass.status === 400, 'unknown plug_class -> 400');

  // ---- Credentials: fingerprint-only, through the vault ----
  const cred = await tracked('POST', '/api/onemind-root/credentials/register', {
    name: CRED_NAME, platform: 'fixture-platform', account: 'fixture seat account',
    credential_class: 'long_lived_api_key', fingerprint_sha256: FP1,
    storage_ref: 'suite-fixture-label', seated_at: '2026-10-26',
    seat: SEAT_NAME, actor: 'suite',
  }, TOKEN);
  ok(cred.status === 200 && cred.json.registered === CRED_NAME
    && cred.json.fingerprint_sha256 === FP1,
    'seat credential registers by fingerprint');
  ok(!('storage_ref' in (cred.json || {})), 'register ack echoes no storage reference');
  const credMaterial = await tracked('POST', '/api/onemind-root/credentials/register', {
    name: 'Material Cred', credential_class: 'long_lived_api_key',
    fingerprint_sha256: FP1, private_key: CANARY,
  }, TOKEN);
  ok(credMaterial.status === 400, 'raw private key at the registrar -> 400');
  const credPem = await tracked('POST', '/api/onemind-root/credentials/register', {
    name: 'PEM Cred', credential_class: 'service_account_json_key',
    fingerprint_sha256: FP1, scope_granted: 'read -----BEGIN PRIVATE KEY-----',
  }, TOKEN);
  ok(credPem.status === 400, 'PEM block in a metadata field -> 400');
  const credBadFp = await tracked('POST', '/api/onemind-root/credentials/register', {
    name: 'Bad FP Cred', credential_class: 'long_lived_api_key',
    fingerprint_sha256: 'not-a-fingerprint',
  }, TOKEN);
  ok(credBadFp.status === 400, 'malformed fingerprint -> 400');
  const credRotate = await tracked('POST', '/api/onemind-root/credentials/rotate', {
    name: CRED_NAME, platform: 'fixture-platform', account: 'fixture seat account',
    credential_class: 'long_lived_api_key', fingerprint_sha256: FP2,
    storage_ref: 'suite-fixture-label', seated_at: '2026-10-26',
    seat: SEAT_NAME, actor: 'suite',
  }, TOKEN);
  ok(credRotate.status === 200 && credRotate.json.fingerprint_sha256 === FP2,
    'seat credential rotates by fingerprint');

  // ---- POST-only: no operation rides a GET ----
  ok((await tracked('GET', '/api/onemind-root/seats/register', undefined, TOKEN)).status === 404,
    'no GET surface at /api/onemind-root/seats/register (404)');
  ok((await tracked('GET', '/api/onemind-root/plugpoints/register', undefined, TOKEN)).status === 404,
    'no GET surface at /api/onemind-root/plugpoints/register (404)');
  ok((await tracked('GET', '/api/onemind-root/credentials/register', undefined, TOKEN)).status === 404,
    'no GET surface at /api/onemind-root/credentials/register (404)');
  ok((await tracked('GET', '/api/onemind-root/credentials/rotate', undefined, TOKEN)).status === 404,
    'no GET surface at /api/onemind-root/credentials/rotate (404)');
  ok((await tracked('GET', '/api/onemind-root/credentials/revoke', undefined, TOKEN)).status === 404,
    'no GET surface at /api/onemind-root/credentials/revoke (404)');

  // ---- State: the table's root view ----
  const st = await tracked('GET', '/api/onemind-root/state', undefined, TOKEN);
  ok(st.status === 200 && st.json.table === 'OneMind', 'state serves the table root view');
  ok(st.json.seat_count >= 13, 'state serves the Codex seats registry (>= 13 seats)');
  ok(st.json.plug_point_count >= 10, 'state serves the Codex plug points (>= 10 plugs)');
  ok(Array.isArray(st.json.prices) && st.json.prices.length >= 9,
    'state serves the settled price entries');
  const teamPrice = st.json.prices.find((p) => p.name === 'OneMind (Team subscription)');
  ok(teamPrice && teamPrice.state.includes('$9.99/mo'),
    'OneMind Team subscription price is the settled $9.99/mo');
  ok(typeof st.json.plug_law === 'string' && st.json.plug_law.includes('PRICE OF THE PLUG'),
    'state serves the Price of the Plug law');
  const gemini = st.json.seats.find((s) => s.name === 'Gemini');
  ok(gemini && gemini.source === 'codex' && gemini.state.includes('seated'),
    'Codex seats flow into the root view');
  const fixtureSeat = st.json.seats.find((s) => s.name === SEAT_NAME);
  ok(fixtureSeat && fixtureSeat.source === 'root' && fixtureSeat.seat_ai === 'Fixture AI',
    'lane-registered seat appears in the root view');
  const rootPlug = st.json.plug_points.find((p) => p.name === 'Root AI API');
  ok(rootPlug && rootPlug.charge.model === 'fleet_zero'
    && rootPlug.charge.plug_in.includes('zero')
    && rootPlug.settled_price && rootPlug.settled_price.state.includes('$149'),
    'fleet plug point shows the zero house charge + its settled $149 price record');
  const fleetFixture = st.json.plug_points.find((p) => p.name === SEAT_NAME + ' Plug Point');
  ok(fleetFixture && fleetFixture.charge.model === 'fleet_zero',
    'registered fleet plug point carries the zero charge');
  const subFixture = st.json.plug_points.find((p) => p.name === OUT_SEAT);
  ok(subFixture && subFixture.charge.model === 'outside_subscription'
    && subFixture.charge.plug_in.includes('$20/mo')
    && subFixture.charge.plug_in.includes('carried in the bundle'),
    'outside plug point charges the maker’s own subscription, carried in the bundle');
  const peopleFixture = st.json.plug_points.find((p) => p.name === PEOPLE_SEAT);
  ok(peopleFixture && peopleFixture.charge.model === 'outside_no_subscription'
    && peopleFixture.charge.plug_in.includes('pays in people'),
    'no-subscription plug point pays in people');

  // ---- Revoke: seat index + status ----
  const revokeUnknown = await tracked('POST', '/api/onemind-root/credentials/revoke', {
    name: 'Never Was A Seat', actor: 'suite',
  }, TOKEN);
  ok(revokeUnknown.status === 404, 'revoking an unknown credential seat -> 404');
  const revoke = await tracked('POST', '/api/onemind-root/credentials/revoke', {
    name: CRED_NAME, seat: SEAT_NAME, actor: 'suite',
  }, TOKEN);
  ok(revoke.status === 200 && revoke.json.revoked === CRED_NAME,
    'seat credential revokes');
  const st2 = await tracked('GET', '/api/onemind-root/state', undefined, TOKEN);
  const idx = st2.json.seat_index.find((s) => s.name === CRED_NAME);
  ok(idx && idx.status === 'revoked' && idx.fingerprint_sha256 === FP2
    && idx.seat === SEAT_NAME,
    'seat index shows the revoked credential at the rotated fingerprint');
  const ops = st2.json.oplog.map((o) => `${o.operation}:${o.result}`);
  ok(ops.includes('seat_register:ok') && ops.includes('plugpoint_register:ok')
    && ops.includes('credential_register:ok') && ops.includes('credential_rotate:ok')
    && ops.includes('credential_revoke:ok'),
    'operation log records every root operation on the table');

  // ---- Cleanliness: nothing sensitive ever left the lane ----
  const raw = seen.map((r) => r.text).join('\n');
  ok(!raw.includes(CANARY), 'no canary secret material in any response (raw bytes)');
  ok(!raw.includes('BEGIN PRIVATE KEY'), 'no key material in any response (raw bytes)');
  ok(!raw.includes('storage_ref'), 'no storage reference in any response (raw bytes)');
  ok(!raw.includes('vm-file') && !raw.includes('file:'), 'no vault storage location in any response (raw bytes)');
}

module.exports = { runHttpTests };
