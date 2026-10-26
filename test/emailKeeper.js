// Email Keeper live status tests (2026-10-26).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers the public contract: GET /api/email-keeper serves ONLY the
// whitelisted field set (addresses + states — never connector ids,
// doorway data, or tokens), and POST /api/email-keeper/ingest sits
// behind the Muse service token and validates its payload.
const BASE = 'http://localhost:4137';

async function runHttpTests(ok, req) {
  console.log('email keeper (live status endpoint):');
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

  const ALLOWED_KEYS = ['key', 'address', 'state', 'checked_at', 'last_success_at',
    'down_since', 'error_class', 'exposed'];
  const SIX = ['mk2', 'mk', 'mk4', 'littleinkersstudio', 'mk5', 'tac'];

  // GET before any ingest: sane all-unknown baseline, not a crash.
  const pre = await call('GET', '/api/email-keeper');
  ok(pre.status === 200 && pre.json && pre.json.ok === true, 'email-keeper responds ok before any ingest');
  const preAccounts = (pre.json && pre.json.accounts) || [];
  ok(preAccounts.length === 6 && preAccounts.map((a) => a.key).join(',') === SIX.join(','),
    'baseline carries all six mailboxes in board order');
  ok(preAccounts.every((a) => a.state === 'unknown' && a.exposed === null
    && a.checked_at === null && a.error_class === null),
    'baseline states are all unknown with null fields');

  // Ingest auth: the Muse service-token mechanism — 401 without/with a
  // wrong token, and nothing is stored by the rejected calls.
  const validBody = {
    generated_at: '2026-10-26T11:19:28Z',
    accounts: [
      { key: 'mk2', address: 'mikekelleyii.mk2@gmail.com', state: 'up', checked_at: '2026-10-26T11:19:28Z', last_success_at: '2026-10-26T11:19:28Z', down_since: null, error_class: null },
      { key: 'mk', address: 'mikekelleyii.mk@gmail.com', state: 'up', checked_at: '2026-10-26T11:19:28Z', last_success_at: '2026-10-26T11:19:28Z', down_since: null, error_class: null },
      { key: 'mk4', address: 'mikekelleyii.mk4@gmail.com', state: 'up', checked_at: '2026-10-26T11:19:28Z', last_success_at: '2026-10-26T11:19:28Z', down_since: null, error_class: null },
      { key: 'littleinkersstudio', address: 'littleinkersstudio@gmail.com', state: 'up', checked_at: '2026-10-26T11:19:28Z', last_success_at: '2026-10-26T11:19:28Z', down_since: null, error_class: null },
      { key: 'mk5', address: 'mikekelleyii.mk5@gmail.com', state: 'up', checked_at: '2026-10-26T11:19:28Z', last_success_at: '2026-10-26T11:19:28Z', down_since: null, error_class: null },
      // Deliberately carries the keeper's internal extras — the server
      // whitelist must strip them before storage/serving.
      { key: 'tac', address: 'tattoo.art.customs@gmail.com', state: 'down', checked_at: '2026-10-26T11:19:28Z', last_success_at: null, down_since: '2026-10-26T11:17:23Z', error_class: 'reauthorization_required', account_id: 'fd81fe76ae46435e857173f05cb2e1bd', fix: 'Owner phone sign-in', doorway_url: 'https://agent.meta.ai/connectors/reconnect/gmail/fd81fe76ae46435e857173f05cb2e1bd' },
    ],
    exposed: { mk2: true, mk: true, mk4: true, littleinkersstudio: true, mk5: true, tac: true },
  };
  const noTok = await call('POST', '/api/email-keeper/ingest', validBody);
  ok(noTok.status === 401, 'ingest rejects a missing Bearer token');
  const badTok = await call('POST', '/api/email-keeper/ingest', validBody, 'wrong-token');
  ok(badTok.status === 401, 'ingest rejects a wrong Bearer token');
  const stillPre = await call('GET', '/api/email-keeper');
  ok(((stillPre.json && stillPre.json.accounts) || []).every((a) => a.state === 'unknown'),
    'rejected ingests stored nothing');

  // Ingest validation: malformed payloads are 400, never stored.
  const junk1 = await call('POST', '/api/email-keeper/ingest', {}, TOKEN);
  ok(junk1.status === 400, 'ingest rejects a body with no accounts');
  const junk2 = await call('POST', '/api/email-keeper/ingest', { accounts: 'nope' }, TOKEN);
  ok(junk2.status === 400, 'ingest rejects non-array accounts');
  const junk3 = await call('POST', '/api/email-keeper/ingest',
    { accounts: [{ key: 'nope', address: 'a@b.com', state: 'up' }] }, TOKEN);
  ok(junk3.status === 400, 'ingest rejects an unknown mailbox key');
  const junk4 = await call('POST', '/api/email-keeper/ingest',
    { accounts: [{ key: 'mk2', address: 'mikekelleyii.mk2@gmail.com', state: 'sideways' }] }, TOKEN);
  ok(junk4.status === 400, 'ingest rejects a bad state value');
  const junk5 = await call('POST', '/api/email-keeper/ingest',
    { accounts: [{ key: 'mk2', address: 'not-an-email', state: 'up' }] }, TOKEN);
  ok(junk5.status === 400, 'ingest rejects a bad address');

  // Valid ingest: stored (all six mailboxes projected, extras stripped).
  const good = await call('POST', '/api/email-keeper/ingest', validBody, TOKEN);
  ok(good.status === 200 && good.json && good.json.ok === true && good.json.stored === 6,
    'valid ingest stores the six-mailbox snapshot');

  const post = await call('GET', '/api/email-keeper');
  const accounts = (post.json && post.json.accounts) || [];
  ok(post.status === 200 && accounts.length === 6, 'GET after ingest returns six mailboxes');
  ok(accounts.map((a) => a.key).join(',') === SIX.join(','), 'GET keeps board order');
  ok(accounts.every((a) => Object.keys(a).sort().join(',') === [...ALLOWED_KEYS].sort().join(',')),
    'GET accounts carry ONLY the whitelisted fields');
  const tac = accounts.find((a) => a.key === 'tac');
  ok(!!tac && tac.state === 'down' && tac.error_class === 'reauthorization_required'
    && tac.down_since === '2026-10-26T11:17:23Z' && tac.exposed === true,
    'TAC serves down + error class + exposed from the ingest');
  ok(accounts.filter((a) => a.state === 'up').length === 5
    && accounts.every((a) => a.exposed === true),
    'the other five serve up, all exposed flags ride along');
  ok(post.json.generated_at === '2026-10-26T11:19:28Z'
    && typeof post.json.ingested_at === 'string' && post.json.ingested_at.length > 0,
    'GET carries the keeper generated_at and a server ingested_at');

  // Leak check on the raw bytes: no connector ids, no doorway data, no
  // fix text, no service token — nothing beyond addresses + states.
  ok(!post.text.includes('account_id') && !post.text.includes('fd81fe76')
    && !post.text.includes('doorway') && !post.text.includes('reconnect')
    && !post.text.includes('Owner phone sign-in')
    && !post.text.includes(TOKEN),
    'GET response leaks no connector ids, doorway data, fix text, or token');
}

module.exports = { runHttpTests };
