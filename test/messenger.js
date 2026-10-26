// AI-to-AI Messenger slice 1 tests (Registry + 1:1, migration
// 109). The coordinator (test/run.js) wires this in; do not run
// from here.
//
// DB phase: the worker's messenger routing rule in-process — a
// send settles against the RECIPIENT's seat with no failover: a
// configured seat answers in its own envelope; an unconfigured
// seat posts its honest absence block as a failure (never limbo,
// never a substitute).
// HTTP phase: the full owner flow over the real routes — two
// devices claim listings, the AI CODE connects them (approval
// policy), sends flow both directions and settle in the shared
// record, a non-member is refused, an ended pairing refuses and
// RECORDS the refusal.
const crypto = require('crypto');
const db = require('../src/db');
const apiLane = require('../src/worker/apiLane');

const BASE = 'http://localhost:4137';

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    headers: { get: () => null },
  };
}
function mockFetch(calls) {
  return async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.includes('generativelanguage.googleapis.com')) {
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'Hello from Gemini!' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 },
        modelVersion: 'gemini-test-1',
      });
    }
    throw new Error('unexpected fetch in messenger tests: ' + url);
  };
}

async function insertDevice(deviceId, pairingCode) {
  await db.query(
    'INSERT INTO ai_devices (device_id, pairing_code, key_hash, created_at, registered_at) VALUES (?, ?, ?, ?, ?)',
    [deviceId, pairingCode, null, db.now(), db.now()]
  );
}
async function insertListing(deviceId, handle, code, aiName) {
  const id = await db.insert('ai_listings', {
    owner_device_id: deviceId, owner_user_id: null, handle, code,
    display_name: handle + ' AI', ai_name: aiName, owner_display_name: null,
    about: null, findability: 'unlisted', connect_policy: 'approval',
    open_1to1: 1, updated_at: db.now(),
  });
  return db.get('SELECT * FROM ai_listings WHERE id = ?', [id]);
}

async function runDbTests(ok) {
  console.log('messenger worker routing (recipient seat, no failover):');
  await insertDevice('msgr-db-a', 'MSGRDBA1');
  await insertDevice('msgr-db-b', 'MSGRDBB1');
  const la = await insertListing('msgr-db-a', 'msgr_db_a', 'MSGRAC01', 'DeepSeek');
  const lb = await insertListing('msgr-db-b', 'msgr_db_b', 'MSGRBC01', 'Gemini');
  const pairingId = await db.insert('ai_pairings', {
    listing_a_id: la.id, listing_b_id: lb.id, seat_a: 'DeepSeek', seat_b: 'Gemini',
    status: 'active', consent_a_at: db.now(), consent_b_at: db.now(),
    closed_at: null, closed_by: null,
  });

  // A → B: B's seat is Gemini; with a Gemini key the recipient's
  // OWN seat answers — addressed with the sender's identity.
  const cmdId = crypto.randomUUID();
  await db.insert('ai_commands', {
    id: cmdId, device_id: 'msgr-db-b', text: 'messenger framing',
    status: 'queued', answer: null, delivered_at: null, completed_at: null,
    origin: 'device', lane: 'api', claimed_by: null, claimed_at: null,
    attempts: 0, messenger_pairing_id: pairingId,
  });
  await db.insert('messenger_messages', {
    pairing_id: pairingId, command_id: cmdId,
    from_listing_id: la.id, to_listing_id: lb.id, seat_member: 'Gemini',
    text: 'Hi — what are you best at?', status: 'sent', refusal_reason: null,
  });
  const calls = [];
  const keyed = apiLane.createWorker({
    env: { GEMINI_API_KEY: 'test-gemini-key-not-real' },
    fetchImpl: mockFetch(calls), retryDelayMs: 0, workerId: 'msgr-test-worker',
  });
  await keyed.drain();
  const row = await db.get('SELECT * FROM ai_commands WHERE id = ?', [cmdId]);
  ok(row.status === 'done' && row.answer === '[FROM Gemini]\nHello from Gemini!\n[END]',
    'messenger: the recipient seat (Gemini) answers in its own envelope');
  const gemCall = calls.find((c) => c.url.includes('generativelanguage.googleapis.com'));
  const sentBody = gemCall ? JSON.stringify(gemCall.opts.body || '') : '';
  ok(!!gemCall && sentBody.includes('msgr_db_a') && sentBody.includes('what are you best at'),
    'messenger: the run carries the sender identity + the verbatim message to the seat');
  const hop = await db.get(
    "SELECT * FROM ai_runs WHERE command_id = ? AND member = 'Gemini' AND lane = 'api'", [cmdId]);
  ok(!!hop && hop.status === 'done' && hop.finish_reason === 'STOP',
    'messenger: the hop gauge (finish_reason) is retained on ai_runs');

  // B → A: A's seat is DeepSeek, NOT configured in this worker —
  // the send settles FAILED with DeepSeek's own absence block.
  // No failover to the configured Gemini (a substitute would lie
  // about whose AI answered).
  const cmd2 = crypto.randomUUID();
  await db.insert('ai_commands', {
    id: cmd2, device_id: 'msgr-db-a', text: 'messenger framing',
    status: 'queued', answer: null, delivered_at: null, completed_at: null,
    origin: 'device', lane: 'api', claimed_by: null, claimed_at: null,
    attempts: 0, messenger_pairing_id: pairingId,
  });
  await db.insert('messenger_messages', {
    pairing_id: pairingId, command_id: cmd2,
    from_listing_id: lb.id, to_listing_id: la.id, seat_member: 'DeepSeek',
    text: 'And what about you?', status: 'sent', refusal_reason: null,
  });
  await keyed.drain();
  const row2 = await db.get('SELECT * FROM ai_commands WHERE id = ?', [cmd2]);
  ok(row2.status === 'failed' && row2.answer.includes('[FROM DeepSeek]')
    && row2.answer.includes('not configured'),
    'messenger: an unconfigured seat settles failed with its OWN absence block (no failover)');
  ok(!row2.answer.includes('Hello from Gemini'),
    'messenger: the configured seat never substitutes for the named seat');
  const dsHop = await db.get(
    "SELECT * FROM ai_runs WHERE command_id = ? AND member = 'DeepSeek' AND lane = 'api'", [cmd2]);
  ok(!!dsHop && dsHop.status === 'skipped' && dsHop.error === 'NO_KEY',
    'messenger: ai_runs records the unconfigured hop as skipped / NO_KEY');
}

async function runHttpTests(ok) {
  console.log('messenger http (registry + code connect + 1:1 record):');
  const PIPE = process.env.MUSE_SERVICE_TOKEN;
  const call = (method, p, body, token) => fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const keyA = 'test-device-key-msgr-a';
  const keyB = 'test-device-key-msgr-b';
  const keyC = 'test-device-key-msgr-c';
  const codeOf = (k) => crypto.createHash('sha256').update(k, 'utf8').digest('hex').slice(0, 8).toUpperCase();
  for (const [key, dev] of [[keyA, 'msgr-http-a'], [keyB, 'msgr-http-b'], [keyC, 'msgr-http-c']]) {
    const r = await call('POST', '/api/muse/ai-commands/register', { pairing_code: codeOf(key), device_id: dev }, PIPE);
    ok(r.status === 200, `messenger http: register device ${dev}`);
  }
  const M = '/api/muse/messenger';

  // Claims. A = Gemini (unlisted by default), B = DeepSeek.
  let r = await call('POST', `${M}/listings`, { handle: 'msgr_http_a', display_name: 'Aria of A', ai_name: 'Gemini', about: 'Answers questions.' }, keyA);
  let j = await r.json();
  ok(r.status === 200 && j.ok && /^[A-Z2-9]{8}$/.test(j.listing.code) && j.listing.findability === 'unlisted',
    'messenger http: A claims a listing and is issued an 8-char AI code (unlisted by default)');
  const aCode = j.listing.code;
  r = await call('POST', `${M}/listings`, { handle: 'msgr_http_b', display_name: 'Buddy of B', ai_name: 'DeepSeek' }, keyB);
  j = await r.json();
  ok(r.status === 200 && j.ok, 'messenger http: B claims a listing');
  const bCode = j.listing.code;
  r = await call('POST', `${M}/listings`, { handle: 'msgr_http_a', display_name: 'Squatter', ai_name: 'Claude' }, keyC);
  ok(r.status === 409, 'messenger http: a claimed handle cannot be taken by another device');

  // Directory honors findability: B is unlisted → invisible; the
  // CODE door still resolves B (the code is the primary path).
  r = await call('GET', `${M}/directory?q=msgr_http_b`, undefined, keyA);
  j = await r.json();
  ok(r.status === 200 && j.listings.length === 0, 'messenger http: an unlisted listing never appears in the Directory');
  r = await call('GET', `${M}/by-code/${bCode}`, undefined, keyA);
  j = await r.json();
  ok(r.status === 200 && j.listing.handle === 'msgr_http_b' && !('code' in j.listing) && !('owner_device_id' in j.listing),
    'messenger http: the AI code resolves an unlisted listing (and leaks neither code nor device)');
  r = await call('PATCH', `${M}/listings/me`, { findability: 'public' }, keyB);
  j = await r.json();
  ok(r.status === 200 && j.listing.findability === 'public', 'messenger http: B flips its listing public');
  r = await call('GET', `${M}/directory?q=msgr_http_b`, undefined, keyA);
  j = await r.json();
  ok(r.status === 200 && j.listings.length === 1 && j.listings[0].seat_state === 'not configured',
    'messenger http: a public listing is searchable, with its seat state told honestly');

  // Connect BY CODE (the primary path). Approval policy → pending.
  r = await call('POST', `${M}/requests`, { code: bCode }, keyA);
  j = await r.json();
  ok(r.status === 200 && j.ok && j.request && j.request.status === 'pending',
    'messenger http: A connects by B\'s AI code → a pending request (approval policy)');
  const reqId = j.request.id;
  r = await call('POST', `${M}/requests`, { code: bCode }, keyA);
  ok(r.status === 409, 'messenger http: a duplicate open request is refused');
  r = await call('POST', `${M}/requests`, { code: aCode }, keyA);
  ok(r.status === 400, 'messenger http: your own code is refused');
  r = await call('GET', `${M}/requests`, undefined, keyB);
  j = await r.json();
  ok(r.status === 200 && j.incoming.length === 1 && j.incoming[0].from_listing.handle === 'msgr_http_a',
    'messenger http: B sees the incoming request with the requester\'s listing');
  r = await call('POST', `${M}/requests/${reqId}/approve`, { seat: 'DeepSeek' }, keyA);
  ok(r.status === 404, 'messenger http: the requester cannot approve their own request');
  r = await call('POST', `${M}/requests/${reqId}/approve`, {}, keyB);
  j = await r.json();
  ok(r.status === 200 && j.ok && j.pairing.status === 'active'
    && j.pairing.my_seat === 'DeepSeek' && j.pairing.their_seat === 'Gemini',
    'messenger http: B approves → pairing active, seats fixed at pairing');
  const pairingId = j.pairing.id;

  // Sends both directions. The spawned server runs no worker
  // (NODE_ENV=test), so the sends settle when this process drains
  // the lane with an empty env — every seat unconfigured, every
  // send an honest failure in the record. Never limbo.
  r = await call('POST', `${M}/pairings/${pairingId}/messages`, { text: 'Hello from A — what are you best at?' }, keyA);
  j = await r.json();
  ok(r.status === 200 && j.ok && j.status === 'queued' && !!j.command_id,
    'messenger http: A sends into the channel (queued on the pipeline)');
  const cmdA = j.command_id;
  r = await call('POST', `${M}/pairings/${pairingId}/messages`, { text: 'Reply from B — and you?' }, keyB);
  j = await r.json();
  ok(r.status === 200 && j.ok, 'messenger http: B sends back into the channel');
  const cmdB = j.command_id;

  // A non-member cannot send into (or read) the channel.
  await call('POST', `${M}/listings`, { handle: 'msgr_http_c', display_name: 'Third wheel', ai_name: 'Claude' }, keyC);
  r = await call('POST', `${M}/pairings/${pairingId}/messages`, { text: 'let me in' }, keyC);
  ok(r.status === 403, 'messenger http: unpaired send rejected (non-member)');
  r = await call('GET', `${M}/pairings/${pairingId}/messages`, undefined, keyC);
  ok(r.status === 403, 'messenger http: the record is readable by its two owners only');

  // Settle the two sends: the suite's in-process db handle is
  // closed for the HTTP phase (the spawned server owns the file),
  // so re-open it, drain the lane in-process with an empty env
  // (no seat configured → honest failures), and close it again —
  // the same re-open pattern other phases use.
  await db.init();
  const drainer = apiLane.createWorker({
    env: {}, fetchImpl: async () => { throw new Error('no network in tests'); },
    retryDelayMs: 0, workerId: 'msgr-http-drainer',
  });
  try {
    await drainer.drain();
  } catch (e) {
    if (!/locked/i.test(e.message)) throw e;
    await new Promise((r2) => setTimeout(r2, 300));
    await drainer.drain();
  }
  await db.close();
  r = await call('GET', `${M}/pairings/${pairingId}/messages`, undefined, keyA);
  j = await r.json();
  ok(r.status === 200 && j.messages.length === 2, 'messenger http: the record holds both sends');
  const mA = j.messages.find((m) => m.command_id === cmdA);
  const mB = j.messages.find((m) => m.command_id === cmdB);
  ok(!!mA && mA.command_status === 'failed' && mA.answer.includes('[FROM DeepSeek]')
    && mA.answer.includes('not configured') && mA.hops.length === 1 && mA.hops[0].member === 'DeepSeek',
    'messenger http: A\'s send settled as DeepSeek\'s honest not-configured block, hop gauge attached');
  ok(!!mB && mB.command_status === 'failed' && mB.answer.includes('[FROM Gemini]')
    && mB.text === 'Reply from B — and you?',
    'messenger http: B\'s send settled against A\'s Gemini seat; sender text verbatim in the record');

  // Pause stops sends; end closes; a send after end is refused AND
  // recorded as refused in the record.
  r = await call('POST', `${M}/pairings/${pairingId}/pause`, {}, keyB);
  j = await r.json();
  ok(r.status === 200 && j.pairing.status === 'paused', 'messenger http: either owner can pause the pairing');
  r = await call('POST', `${M}/pairings/${pairingId}/messages`, { text: 'while paused' }, keyA);
  j = await r.json();
  ok(r.status === 409 && j.recorded === true, 'messenger http: a send while paused is refused and recorded');
  r = await call('POST', `${M}/pairings/${pairingId}/end`, {}, keyB);
  j = await r.json();
  ok(r.status === 200 && j.pairing.status === 'closed', 'messenger http: either owner can end the pairing');
  r = await call('POST', `${M}/pairings/${pairingId}/messages`, { text: 'after the end' }, keyA);
  j = await r.json();
  ok(r.status === 409 && j.recorded === true, 'messenger http: a send after end is refused and recorded');
  r = await call('GET', `${M}/pairings/${pairingId}/messages`, undefined, keyB);
  j = await r.json();
  const refused = j.messages.filter((m) => m.status === 'refused');
  ok(j.messages.length === 4 && refused.length === 2
    && refused.every((m) => !!m.refusal_reason),
    'messenger http: the record keeps both refusals, each with its reason — nothing silently dropped');
}

module.exports = { runDbTests, runHttpTests };
