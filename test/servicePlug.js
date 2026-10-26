// AI API Service Plug tests (Slice 1, 2026-10-26).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers the plug laws as executable assertions:
//  - the vault is WRITE-ONLY: no GET surface exists under
//    /api/service-plug, and registration is service-token guarded;
//  - credential material is REFUSED at the registrar (a canary secret
//    smuggled as a field, and a PEM block hidden in a text field, both
//    400) — and the canary's raw bytes never appear in ANY response
//    afterwards, including the public Codex projection;
//  - the operation endpoint is token-guarded, validates the package,
//    and answers honestly when no Play credential is configured
//    (the test env seats none): ok:false + error_class, never a fake
//    success, never key material in the raw response.
const BASE = 'http://localhost:4137';

async function runHttpTests(ok, req) {
  console.log('service plug (write-only vault + play operation):');
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

  const FP = 'a'.repeat(64);
  const cleanRecord = {
    name: 'Test doorway — suite fixture',
    platform: 'google-play',
    account: 'test developer account',
    credential_class: 'service_account_json_key',
    fingerprint_sha256: FP,
    storage_ref: 'vm-file:~/fixture/key.json',
    scope_granted: 'tracks read',
    scope_not_granted: 'financial data',
    seated_at: '2026-10-26',
    playbook: 'playbook-google-play.md v1',
    status: 'operating',
  };

  // ---- Registrar auth: the Muse service-token mechanism ----
  const noTok = await call('POST', '/api/service-plug/vault/register', cleanRecord);
  ok(noTok.status === 401, 'vault register rejects a missing Bearer <redacted>');
  const badTok = await call('POST', '/api/service-plug/vault/register', cleanRecord, 'wrong-token');
  ok(badTok.status === 401, 'vault register rejects a wrong Bearer <redacted>');

  // ---- A clean metadata-only registration lands; the ack carries
  // name + fingerprint ONLY (no storage ref, no record echo) ----
  const good = await call('POST', '/api/service-plug/vault/register', cleanRecord, TOKEN);
  ok(good.status === 200 && good.json && good.json.ok === true
    && good.json.registered === cleanRecord.name
    && good.json.fingerprint_sha256 === FP,
    'vault register accepts a metadata-only record');
  ok(!/vm-file|storage_ref/.test(good.text), 'register ack does not echo the storage reference');

  // ---- Credential material is refused, in every hiding place ----
  const CANARY = 'CANARY-SECRET-9f3b7d-never-served';
  const asField = await call('POST', '/api/service-plug/vault/register',
    { ...cleanRecord, private_key: CANARY }, TOKEN);
  ok(asField.status === 400, 'vault register refuses a private_key field');
  const asValue = await call('POST', '/api/service-plug/vault/register',
    { ...cleanRecord, scope_granted: `tracks read -----BEGIN PRIVATE KEY----- ${CANARY}` }, TOKEN);
  ok(asValue.status === 400, 'vault register refuses key material hidden in a text field');
  const asNested = await call('POST', '/api/service-plug/vault/register',
    { ...cleanRecord, key: { client_email: 'x@y', private_key: CANARY } }, TOKEN);
  ok(asNested.status === 400, 'vault register refuses a nested service-account JSON dump');
  const badFp = await call('POST', '/api/service-plug/vault/register',
    { ...cleanRecord, fingerprint_sha256: 'not-a-fingerprint' }, TOKEN);
  ok(badFp.status === 400, 'vault register refuses a malformed fingerprint');
  const badClass = await call('POST', '/api/service-plug/vault/register',
    { ...cleanRecord, credential_class: 'browser_cookie' }, TOKEN);
  ok(badClass.status === 400, 'vault register refuses a non-durable credential class (no session replay)');

  // ---- Write-only means write-only: no read surface exists ----
  for (const p of ['/api/service-plug/vault', '/api/service-plug/vault/register', '/api/service-plug/play/tracks']) {
    const g = await call('GET', p, undefined, TOKEN);
    ok(g.status === 404, `no GET surface at ${p} (404)`);
  }

  // ---- The operation endpoint: guarded, validating, honest ----
  const opNoTok = await call('POST', '/api/service-plug/play/tracks', { package: 'com.tattooartcustoms.app' });
  ok(opNoTok.status === 401, 'play tracks rejects a missing Bearer <redacted>');
  const opBadPkg = await call('POST', '/api/service-plug/play/tracks', { package: 'not a package!' }, TOKEN);
  ok(opBadPkg.status === 400, 'play tracks rejects a malformed package name');
  const op = await call('POST', '/api/service-plug/play/tracks', { package: 'com.tattooartcustoms.app' }, TOKEN);
  ok(op.status === 200 && op.json && op.json.ok === false && op.json.error_class === 'not_configured',
    'play tracks answers honestly when no Play credential is configured (no fake success)');

  // ---- Raw bytes: the canary (and any key material) never appears
  // in ANY response — not the operation's, not the Codex's ----
  ok(!op.text.includes(CANARY) && !/BEGIN [A-Z ]*PRIVATE KEY/.test(op.text),
    'operation response carries no credential material (raw bytes)');
  const codex = await call('GET', '/api/codex');
  ok(codex.status === 200 && !codex.text.includes(CANARY) && !/BEGIN [A-Z ]*PRIVATE KEY/.test(codex.text),
    'codex projection carries no credential material (raw bytes)');
  const plugEntry = ((codex.json || {}).plugs || []).find((p) => p.name === 'AI API Service Plug');
  ok(!!plugEntry && /live/.test(plugEntry.state || ''), 'the Service Plug itself is written into the Codex');
}

module.exports = { runHttpTests };
