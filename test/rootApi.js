// Root AI API tests (root tier, Slice 1, 2026-10-26).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers the root lane's laws as executable assertions:
//  - every route is Muse service-token guarded (state included);
//  - door registration is metadata-only: credential material smuggled
//    in any field is a hard 400, unknown fields are a hard 400;
//  - credential seats register / rotate / revoke by sha256 FINGERPRINT
//    ONLY through the write-only vault — a canary secret is refused
//    (400), and its raw bytes never appear in any response afterwards,
//    including the GET state route (which also never echoes a storage
//    reference);
//  - proof reads proxy to the lane that can run them: the Play door
//    answers honestly in the test env (no Play credential configured
//    -> ok:false + not_configured, machinery exercised, no fake
//    success), a Gmail door answers from the Email Keeper's recorded
//    read-test state, a connector door answers no_backend_lane with
//    its documented proof text, an unknown door is a 404;
//  - writes are POST-only: GET on every write route is a 404;
//  - the operation log records each operation (actor, door, operation,
//    result, timestamp) and serves on the state route.
const BASE = 'http://localhost:4137';

async function runHttpTests(ok, req) {
  console.log('root ai api (root lane over the codex doors):');
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

  const CANARY = 'CANARY-ROOT-SECRET-51aa90-never-served';
  const FP1 = 'b'.repeat(64);
  const FP2 = 'c'.repeat(64);

  // ---- Auth: the whole lane is service-token guarded ----
  const stateNoTok = await call('GET', '/api/root-api/state');
  ok(stateNoTok.status === 401, 'root state rejects a missing Bearer <redacted>');
  const stateBadTok = await call('GET', '/api/root-api/state', undefined, 'wrong-token');
  ok(stateBadTok.status === 401, 'root state rejects a wrong Bearer <redacted>');
  const doorNoTok = await call('POST', '/api/root-api/doors/register', { name: 'X door' });
  ok(doorNoTok.status === 401, 'root door register rejects a missing Bearer <redacted>');

  // ---- Door registration: metadata-only, whitelist-enforced ----
  const doorFixture = {
    name: 'Root Fixture Doorway',
    kind: 'door',
    platform: 'fixture-platform',
    account: 'fixture account',
    state: 'built — suite fixture',
    playbook: 'playbook-fixture.md v1',
    proof_read: 'fixture proof: one read of the fixture registry',
    last_verified: '2026-10-26',
    actor: 'suite',
  };
  const doorGood = await call('POST', '/api/root-api/doors/register', doorFixture, TOKEN);
  ok(doorGood.status === 200 && doorGood.json && doorGood.json.ok === true
    && doorGood.json.registered === doorFixture.name,
    'root door register accepts a metadata-only door record');
  const doorMaterial = await call('POST', '/api/root-api/doors/register',
    { ...doorFixture, proof_read: `proof -----BEGIN PRIVATE KEY----- ${CANARY}` }, TOKEN);
  ok(doorMaterial.status === 400, 'root door register refuses key material hidden in a text field');
  const doorUnknown = await call('POST', '/api/root-api/doors/register',
    { ...doorFixture, bogus_field: 'x' }, TOKEN);
  ok(doorUnknown.status === 400, 'root door register refuses an unknown field');
  const doorBadSlug = await call('POST', '/api/root-api/doors/register',
    { ...doorFixture, platform: 'Not A Slug!' }, TOKEN);
  ok(doorBadSlug.status === 400, 'root door register refuses a bad platform slug');

  // ---- Credential seats: fingerprint-only, through the vault ----
  const seatFixture = {
    name: 'Root Fixture Credential Seat',
    platform: 'google-play',
    account: 'fixture developer account',
    credential_class: 'service_account_json_key',
    fingerprint_sha256: FP1,
    storage_ref: 'vm-file:~/fixture/root-key.json',
    scope_granted: 'tracks read',
    scope_not_granted: 'financial data',
    seated_at: '2026-10-26',
    playbook: 'playbook-google-play.md v1',
    status: 'operating — suite fixture',
    actor: 'suite',
  };
  const seatGood = await call('POST', '/api/root-api/credentials/register', seatFixture, TOKEN);
  ok(seatGood.status === 200 && seatGood.json && seatGood.json.ok === true
    && seatGood.json.registered === seatFixture.name
    && seatGood.json.fingerprint_sha256 === FP1,
    'root credential register accepts a fingerprint-only seat');
  ok(!/vm-file|storage_ref/.test(seatGood.text), 'root register ack does not echo the storage reference');
  const seatCanary = await call('POST', '/api/root-api/credentials/register',
    { ...seatFixture, private_key: CANARY }, TOKEN);
  ok(seatCanary.status === 400, 'root credential register refuses a private_key field (hard 400)');
  const seatPem = await call('POST', '/api/root-api/credentials/register',
    { ...seatFixture, scope_granted: `read -----BEGIN PRIVATE KEY----- ${CANARY}` }, TOKEN);
  ok(seatPem.status === 400, 'root credential register refuses a PEM block hidden in a text field');
  const seatBadFp = await call('POST', '/api/root-api/credentials/register',
    { ...seatFixture, fingerprint_sha256: CANARY }, TOKEN);
  ok(seatBadFp.status === 400, 'root credential register refuses a malformed fingerprint');

  // Rotation = re-registration with the new fingerprint.
  const rotated = await call('POST', '/api/root-api/credentials/rotate',
    { ...seatFixture, fingerprint_sha256: FP2 }, TOKEN);
  ok(rotated.status === 200 && rotated.json && rotated.json.ok === true
    && rotated.json.fingerprint_sha256 === FP2,
    'root credential rotate lands the new fingerprint');

  // Revocation = a status flip; an unknown seat is a 404.
  const revokeUnknown = await call('POST', '/api/root-api/credentials/revoke',
    { name: 'No Such Seat', actor: 'suite' }, TOKEN);
  ok(revokeUnknown.status === 404, 'root credential revoke of an unknown seat is a 404');
  const revoked = await call('POST', '/api/root-api/credentials/revoke',
    { name: seatFixture.name, actor: 'suite' }, TOKEN);
  ok(revoked.status === 200 && revoked.json && revoked.json.ok === true
    && revoked.json.revoked === seatFixture.name
    && revoked.json.fingerprint_sha256 === FP2,
    'root credential revoke flips the seat status');

  // ---- Proof reads: proxied to the lane that can run them ----
  const proofPlay = await call('POST', '/api/root-api/proof',
    { door: 'Google Play Developer API doorway', actor: 'suite' }, TOKEN);
  ok(proofPlay.status === 200 && proofPlay.json && proofPlay.json.ok === false
    && proofPlay.json.error_class === 'not_configured',
    'root proof proxies the Play door proof read (honest not_configured in the test env)');
  const proofGmail = await call('POST', '/api/root-api/proof',
    { door: 'Gmail — TAC (tattoo.art.customs@gmail.com)', actor: 'suite' }, TOKEN);
  ok(proofGmail.status === 200 && proofGmail.json
    && proofGmail.json.proof === 'email-keeper-read-test'
    && typeof proofGmail.json.ok === 'boolean'
    && typeof proofGmail.json.state === 'string',
    'root proof answers a Gmail door from the Email Keeper read-test state');
  const proofSocial = await call('POST', '/api/root-api/proof',
    { door: 'Instagram — @mikeyii.mk2_', actor: 'suite' }, TOKEN);
  ok(proofSocial.status === 200 && proofSocial.json && proofSocial.json.ok === false
    && proofSocial.json.error_class === 'no_backend_lane'
    && typeof proofSocial.json.proof === 'string' && proofSocial.json.proof.length > 0,
    'root proof answers a connector door honestly (no_backend_lane + documented proof)');
  const proofPaypal = await call('POST', '/api/root-api/proof',
    { door: 'PayPal REST API — mk4 business door', actor: 'suite' }, TOKEN);
  ok(proofPaypal.status === 200 && proofPaypal.json && proofPaypal.json.ok === false
    && proofPaypal.json.error_class === 'awaiting_credential_registration',
    'root proof answers the PayPal door honestly while its credential is unregistered');
  const proofUnknown = await call('POST', '/api/root-api/proof',
    { door: 'No Such Door', actor: 'suite' }, TOKEN);
  ok(proofUnknown.status === 404, 'root proof of an unknown door is a 404');
  const proofNoTok = await call('POST', '/api/root-api/proof', { door: 'Google Play Developer API doorway' });
  ok(proofNoTok.status === 401, 'root proof rejects a missing Bearer <redacted>');

  // ---- POST-only enforcement: no write surface answers GET ----
  for (const p of ['/api/root-api/doors/register', '/api/root-api/credentials/register',
    '/api/root-api/credentials/rotate', '/api/root-api/credentials/revoke', '/api/root-api/proof']) {
    const g = await call('GET', p, undefined, TOKEN);
    ok(g.status === 404, `no GET surface at ${p} (404)`);
  }

  // ---- State: registry + seat index + operation log, no material ----
  const state = await call('GET', '/api/root-api/state', undefined, TOKEN);
  ok(state.status === 200 && state.json && state.json.ok === true, 'root state answers behind the service token');
  ok(state.json.door_count >= 27, 'root state serves the full Codex door registry (27 doors)');
  const fixtureDoor = (state.json.doors || []).find((d) => d.name === doorFixture.name);
  ok(!!fixtureDoor && fixtureDoor.source === 'root', 'root state carries the root-registered door');
  const playDoor = (state.json.doors || []).find((d) => d.name === 'Google Play Developer API doorway');
  ok(!!playDoor && playDoor.source === 'codex', 'root state carries the Codex Play doorway');
  const seat = (state.json.seats || []).find((s) => s.name === seatFixture.name);
  ok(!!seat && seat.status === 'revoked' && seat.fingerprint_sha256 === FP2,
    'root state seat index reflects register -> rotate -> revoke');
  const ops = (state.json.oplog || []).map((e) => e.operation);
  for (const op of ['door_register', 'credential_register', 'credential_rotate', 'credential_revoke', 'proof']) {
    ok(ops.includes(op), `operation log records ${op}`);
  }
  const proofEntry = (state.json.oplog || []).find((e) => e.operation === 'proof');
  ok(!!proofEntry && proofEntry.actor === 'suite' && !!proofEntry.door && !!proofEntry.ts,
    'operation log entries carry actor, door, result, timestamp');
  ok(!state.text.includes(CANARY) && !/BEGIN [A-Z ]*PRIVATE KEY/.test(state.text)
    && !/vm-file|storage_ref/.test(state.text),
    'root state carries no credential material and no storage references (raw bytes)');
}

module.exports = { runHttpTests };
