// AI Master Button API lane (slice 1) tests. The coordinator
// (test/run.js) wires this in; do not run from here.
//
// DB phase: the worker module runs in-process against the suite's temp
// SQLite DB with provider HTTP replaced by a mock fetch — no network,
// no real API keys (the "keys" below are throwaway test strings used
// only to prove header placement and the configured/unconfigured
// branches). HTTP phase: the enqueue lane contract + the guarantee
// that the device poll never claims an API-lane command.
const crypto = require('crypto');
const db = require('../src/db');
const apiLane = require('../src/worker/apiLane');

const BASE = 'http://localhost:4137';
const TEST_GEMINI_KEY = 'test-gemini-key-not-real';
const TEST_DEEPSEEK_KEY = 'test-deepseek-key-not-real';
const TEST_OPENAI_KEY = 'test-openai-key-not-real';
const TEST_ANTHROPIC_KEY = 'test-anthropic-key-not-real';
const TEST_XAI_KEY = 'test-xai-key-not-real';
const TEST_PERPLEXITY_KEY = 'test-perplexity-key-not-real';
const TEST_META_KEY = 'test-meta-key-not-real';

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
        candidates: [{ content: { parts: [{ text: 'Hello from Gemini!' }] } }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 },
        modelVersion: 'gemini-test-1',
      });
    }
    if (url.includes('api.deepseek.com')) {
      return jsonResponse(200, {
        choices: [{ message: { content: 'Ready.' } }],
        usage: { prompt_tokens: 100, completion_tokens: 5 },
        model: 'deepseek-flash',
      });
    }
    if (url.includes('api.openai.com')) {
      return jsonResponse(200, {
        choices: [{ message: { content: 'Hello from ChatGPT!' } }],
        usage: { prompt_tokens: 200, completion_tokens: 40 },
        model: 'gpt-6.1-sol',
      });
    }
    if (url.includes('api.anthropic.com')) {
      return jsonResponse(200, {
        content: [{ type: 'text', text: 'Hello from Claude!' }],
        usage: { input_tokens: 180, output_tokens: 25 },
        model: 'claude-sonnet-5-5',
      });
    }
    if (url.includes('api.x.ai')) {
      return jsonResponse(200, {
        choices: [{ message: { content: 'Hello from Grok!' } }],
        usage: { prompt_tokens: 150, completion_tokens: 20 },
        model: 'grok-4.3',
      });
    }
    if (url.includes('api.perplexity.ai')) {
      return jsonResponse(200, {
        choices: [{ message: { content: 'Hello from Perplexity!' } }],
        usage: { prompt_tokens: 100, completion_tokens: 5 },
        model: 'sonar',
      });
    }
    if (url.includes('api.meta.ai')) {
      return jsonResponse(200, {
        choices: [{ message: { content: 'Hello from Muse!' } }],
        usage: { prompt_tokens: 160, completion_tokens: 30 },
        model: 'muse-spark-1.3',
      });
    }
    throw new Error(`mock fetch: unexpected URL ${url}`);
  };
}

async function insertCmd(text, lane = 'api', extra = {}) {
  const id = crypto.randomUUID();
  await db.insert('ai_commands', {
    id, device_id: 'api-lane-test', text, status: 'queued', answer: null,
    delivered_at: null, completed_at: null,
    origin: 'hq', lane, claimed_by: null, claimed_at: null, attempts: 0,
    ...extra,
  });
  return id;
}

async function runDbTests(ok) {
  console.log('api lane grammar:');
  const p1 = apiLane.parseCommand('Have Gemini say the word ready');
  ok(p1.type === 'route' && p1.member === 'Gemini' && p1.task === 'say the word ready',
    'parse: "Have Gemini say the word ready" routes to Gemini with the task intact');
  const p2 = apiLane.parseCommand('Have Meta AI write a caption');
  ok(p2.type === 'route' && p2.member === 'Muse' && p2.task === 'write a caption',
    'parse: "Meta AI" resolves to Muse (longest alias wins)');
  ok(apiLane.parseCommand('run the hello loop').type === 'hello_loop', 'parse: hello loop');
  ok(apiLane.parseCommand('HELLO LOOP').type === 'hello_loop', 'parse: HELLO LOOP is case-insensitive');
  ok(apiLane.parseCommand('sing me a song').type === 'unsupported', 'parse: unknown command is unsupported');
  ok(apiLane.resolveMember('gpt') === 'ChatGPT' && apiLane.resolveMember('xai') === 'Grok',
    'parse: member aliases resolve');
  ok(apiLane.costMicroUsd('DeepSeek', 100, 5) === 18, 'cost: DeepSeek 100 in / 5 out = 18 micro-USD at design rates');
  ok(apiLane.costMicroUsd('ChatGPT', 200, 40) === 800, 'cost: ChatGPT 200 in / 40 out = 800 micro-USD at design rates');
  ok(apiLane.costMicroUsd('Claude', 180, 25) === 610, 'cost: Claude 180 in / 25 out = 610 micro-USD at design rates');
  ok(apiLane.costMicroUsd('Perplexity', 100, 5) === 5105,
    'cost: Perplexity 100 in / 5 out = 105 token micro-USD + the 5000 micro-USD per-request fee');

  console.log('api lane worker (both adapters configured, mocked HTTP):');
  const calls = [];
  const keyedEnv = {};
  keyedEnv['GEMINI' + '_API_KEY'] = TEST_GEMINI_KEY;
  keyedEnv['DEEPSEEK' + '_API_KEY'] = TEST_DEEPSEEK_KEY;
  const keyed = apiLane.createWorker({
    env: keyedEnv,
    fetchImpl: mockFetch(calls),
    retryDelayMs: 0,
    workerId: 'test-worker',
  });

  const routeId = await insertCmd('Have DeepSeek say the word ready');
  ok((await keyed.drain()) === 1, 'worker drains one queued API-lane command');
  const routeRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [routeId]);
  ok(routeRow.status === 'done' && routeRow.answer === '[FROM DeepSeek]\nReady.\n[END]',
    'route: DeepSeek answer posted back as a [FROM DeepSeek] envelope');
  ok(routeRow.attempts === 1 && routeRow.claimed_by === 'test-worker' && !!routeRow.completed_at,
    'route: claim bookkeeping recorded (attempts, claimed_by, completed_at)');
  const routeRuns = await db.all('SELECT * FROM ai_runs WHERE command_id = ? ORDER BY started_at ASC, member ASC', [routeId]);
  const routeHop = routeRuns.find((r) => r.member === 'DeepSeek');
  ok(routeRuns.length === 2 && !!routeHop && routeHop.status === 'done'
    && routeHop.prompt_tokens === 100 && routeHop.completion_tokens === 5 && routeHop.cost_microusd === 18,
  'route: ai_runs holds the root run + the hop with measured tokens and estimated cost');
  const dsCall = calls.find((c) => c.url.includes('api.deepseek.com'));
  ok(!!dsCall && dsCall.opts.headers.authorization === `Bearer ${TEST_DEEPSEEK_KEY}`
    && !dsCall.url.includes(TEST_DEEPSEEK_KEY),
  'route: DeepSeek key travels as a header only, never in the URL');

  const gemId = await insertCmd('Have Gemini say the word ready');
  await keyed.drain();
  const gemRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [gemId]);
  ok(gemRow.status === 'done' && gemRow.answer === '[FROM Gemini]\nHello from Gemini!\n[END]',
    'route: Gemini answer posted back as a [FROM Gemini] envelope');
  const gemCall = calls.find((c) => c.url.includes('generativelanguage.googleapis.com'));
  ok(!!gemCall && gemCall.opts.headers['x-goog-api-key'] === TEST_GEMINI_KEY
    && !gemCall.url.includes(TEST_GEMINI_KEY),
  'route: Gemini key travels as a header only, never in the URL');

  const loopId = await insertCmd('run the hello loop');
  await keyed.drain();
  const loopRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [loopId]);
  ok(loopRow.status === 'done', 'hello loop: completes when at least one member answers');
  ok(loopRow.answer.includes('[FROM Gemini]\nHello from Gemini!\n[END]')
    && loopRow.answer.includes('[FROM DeepSeek]\nReady.\n[END]'),
  'hello loop: real hops land as envelope blocks');
  ok(loopRow.answer.indexOf('[FROM Gemini]') < loopRow.answer.indexOf('[FROM DeepSeek]'),
    'hello loop: hops report in roster order');
  ok(loopRow.answer.includes('[FROM Copilot]') && loopRow.answer.includes('has no API'),
    'hello loop: Copilot is named as having no API — never faked, never skipped silently');
  const loopRuns = await db.all('SELECT * FROM ai_runs WHERE command_id = ?', [loopId]);
  const loopHops = loopRuns.filter((r) => r.member);
  ok(loopRuns.length === 9 && loopHops.length === 8
    && loopHops.filter((r) => r.status === 'done').length === 2
    && loopHops.filter((r) => r.status === 'skipped').length === 6,
  'hello loop: ai_runs records all 8 hops (2 done, 6 skipped with reasons)');

  const gptId = await insertCmd('Have ChatGPT say the word ready');
  await keyed.drain();
  const gptRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [gptId]);
  ok(gptRow.status === 'failed' && gptRow.answer.includes('not configured on the server (no API key set)'),
    'route: a member with an adapter but no key (slice 2) fails honestly as not configured, by name');
  ok(!/paste/i.test(gptRow.answer),
    'route: the not-configured failure never hands the user a copy-paste chore (owner law)');

  const unsupId = await insertCmd('sing me a song');
  await keyed.drain();
  const unsupRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [unsupId]);
  ok(unsupRow.status === 'failed' && unsupRow.answer.includes('cannot run that command yet'),
    'grammar: an unsupported command fails honestly instead of sitting queued');

  console.log('api lane worker (slice 2 — every API member configured, mocked HTTP):');
  const calls2 = [];
  const fullEnv = {};
  fullEnv['OPENAI' + '_API_KEY'] = TEST_OPENAI_KEY;
  fullEnv['ANTHROPIC' + '_API_KEY'] = TEST_ANTHROPIC_KEY;
  fullEnv['XAI' + '_API_KEY'] = TEST_XAI_KEY;
  fullEnv['PERPLEXITY' + '_API_KEY'] = TEST_PERPLEXITY_KEY;
  fullEnv['META_MODEL' + '_API_KEY'] = TEST_META_KEY;
  fullEnv['GEMINI' + '_API_KEY'] = TEST_GEMINI_KEY;
  fullEnv['DEEPSEEK' + '_API_KEY'] = TEST_DEEPSEEK_KEY;
  const full = apiLane.createWorker({
    env: fullEnv, fetchImpl: mockFetch(calls2), retryDelayMs: 0, workerId: 'test-worker-2',
  });

  const oaiId = await insertCmd('Have ChatGPT say the word ready');
  await full.drain();
  const oaiRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [oaiId]);
  ok(oaiRow.status === 'done' && oaiRow.answer === '[FROM ChatGPT]\nHello from ChatGPT!\n[END]',
    'route: ChatGPT answer posted back as a [FROM ChatGPT] envelope');
  const oaiCall = calls2.find((c) => c.url.includes('api.openai.com'));
  ok(!!oaiCall && oaiCall.url.includes('/v1/chat/completions')
    && oaiCall.opts.headers.authorization === `Bearer ${TEST_OPENAI_KEY}`
    && !oaiCall.url.includes(TEST_OPENAI_KEY)
    && JSON.parse(oaiCall.opts.body).model === 'gpt-6.1-sol',
  'route: ChatGPT key travels as a Bearer header only; default model is gpt-6.1-sol (design §3.1)');
  const oaiHop = await db.get("SELECT * FROM ai_runs WHERE command_id = ? AND member = 'ChatGPT'", [oaiId]);
  ok(!!oaiHop && oaiHop.status === 'done' && oaiHop.prompt_tokens === 200
    && oaiHop.completion_tokens === 40 && oaiHop.cost_microusd === 800,
  'route: ai_runs records the ChatGPT hop with measured tokens and estimated cost');

  const clId = await insertCmd('Have Claude say the word ready');
  await full.drain();
  const clRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [clId]);
  ok(clRow.status === 'done' && clRow.answer === '[FROM Claude]\nHello from Claude!\n[END]',
    'route: Claude answer (Messages format) posted back as a [FROM Claude] envelope');
  const clCall = calls2.find((c) => c.url.includes('api.anthropic.com'));
  const clBody = clCall ? JSON.parse(clCall.opts.body) : {};
  ok(!!clCall && clCall.url.includes('/v1/messages')
    && clCall.opts.headers['x-api-key'] === TEST_ANTHROPIC_KEY
    && clCall.opts.headers['anthropic-version'] === '2023-06-01'
    && !clCall.url.includes(TEST_ANTHROPIC_KEY)
    && clBody.model === 'claude-sonnet-5-5' && typeof clBody.system === 'string'
    && Array.isArray(clBody.messages) && clBody.messages[0].role === 'user',
  'route: Claude key travels as the x-api-key header only; Messages shape (system field + messages) with the design default model');
  const clHop = await db.get("SELECT * FROM ai_runs WHERE command_id = ? AND member = 'Claude'", [clId]);
  ok(!!clHop && clHop.status === 'done' && clHop.prompt_tokens === 180
    && clHop.completion_tokens === 25 && clHop.cost_microusd === 610,
  'route: ai_runs records the Claude hop (input/output tokens mapped) with estimated cost');

  const grId = await insertCmd('Have Grok say the word ready');
  await full.drain();
  const grRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [grId]);
  ok(grRow.status === 'done' && grRow.answer === '[FROM Grok]\nHello from Grok!\n[END]',
    'route: Grok answer posted back as a [FROM Grok] envelope');
  const grCall = calls2.find((c) => c.url.includes('api.x.ai'));
  ok(!!grCall && grCall.opts.headers.authorization === `Bearer ${TEST_XAI_KEY}`
    && !grCall.url.includes(TEST_XAI_KEY) && JSON.parse(grCall.opts.body).model === 'grok-4.3',
  'route: Grok key travels as a Bearer header only; default model is grok-4.3 (design §4)');

  const pxId = await insertCmd('Have Perplexity say the word ready');
  await full.drain();
  const pxRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [pxId]);
  ok(pxRow.status === 'done' && pxRow.answer === '[FROM Perplexity]\nHello from Perplexity!\n[END]',
    'route: Perplexity answer posted back as a [FROM Perplexity] envelope');
  const pxCall = calls2.find((c) => c.url.includes('api.perplexity.ai'));
  ok(!!pxCall && pxCall.opts.headers.authorization === `Bearer ${TEST_PERPLEXITY_KEY}`
    && !pxCall.url.includes(TEST_PERPLEXITY_KEY) && JSON.parse(pxCall.opts.body).model === 'sonar',
  'route: Perplexity key travels as a Bearer header only; default model is sonar');
  const pxHop = await db.get("SELECT * FROM ai_runs WHERE command_id = ? AND member = 'Perplexity'", [pxId]);
  ok(!!pxHop && pxHop.status === 'done' && pxHop.cost_microusd === 5105,
    'route: ai_runs records the Perplexity hop cost including the per-request fee');

  const muId = await insertCmd('Have Muse say the word ready');
  await full.drain();
  const muRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [muId]);
  ok(muRow.status === 'done' && muRow.answer === '[FROM Muse]\nHello from Muse!\n[END]',
    'route: Muse answer (Meta Model API) posted back as a [FROM Muse] envelope');
  const muCall = calls2.find((c) => c.url.includes('api.meta.ai'));
  ok(!!muCall && muCall.opts.headers.authorization === `Bearer ${TEST_META_KEY}`
    && !muCall.url.includes(TEST_META_KEY) && JSON.parse(muCall.opts.body).model === 'muse-spark-1.3',
  'route: Muse key travels as a Bearer header only; default model is muse-spark-1.3 (standard tier, never contributor)');

  const copId = await insertCmd('Have Copilot say the word ready');
  await full.drain();
  const copRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [copId]);
  ok(copRow.status === 'failed' && copRow.answer.includes('has no API'),
    'route: Copilot still fails honestly as NO_API even with every key set — no substitute product is ever called under its name');
  const copHop = await db.get("SELECT * FROM ai_runs WHERE command_id = ? AND member = 'Copilot'", [copId]);
  ok(!!copHop && copHop.status === 'skipped' && copHop.error === 'NO_API',
    'route: ai_runs records the Copilot hop as skipped with error NO_API');

  const fullLoopId = await insertCmd('run the hello loop');
  await full.drain();
  const fullLoopRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [fullLoopId]);
  ok(fullLoopRow.status === 'done', 'hello loop (slice 2): completes with the full API team configured');
  ok(['[FROM Muse]\nHello from Muse!\n[END]', '[FROM ChatGPT]\nHello from ChatGPT!\n[END]',
    '[FROM Claude]\nHello from Claude!\n[END]', '[FROM Gemini]\nHello from Gemini!\n[END]',
    '[FROM Perplexity]\nHello from Perplexity!\n[END]', '[FROM Grok]\nHello from Grok!\n[END]',
    '[FROM DeepSeek]\nReady.\n[END]'].every((b) => fullLoopRow.answer.includes(b)),
  'hello loop (slice 2): all seven reachable members land real envelope blocks');
  ok(fullLoopRow.answer.indexOf('[FROM Muse]') < fullLoopRow.answer.indexOf('[FROM ChatGPT]')
    && fullLoopRow.answer.indexOf('[FROM Grok]') < fullLoopRow.answer.indexOf('[FROM DeepSeek]'),
  'hello loop (slice 2): hops still report in roster order');
  const fullLoopRuns = await db.all('SELECT * FROM ai_runs WHERE command_id = ?', [fullLoopId]);
  const fullLoopHops = fullLoopRuns.filter((r) => r.member);
  ok(fullLoopRuns.length === 9 && fullLoopHops.filter((r) => r.status === 'done').length === 7
    && fullLoopHops.filter((r) => r.status === 'skipped').length === 1,
  'hello loop (slice 2): ai_runs records 7 done hops + Copilot skipped (NO_API)');

  console.log('api lane hello-loop summary accuracy (configured member errors):');
  const errFetch = async (url) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      return jsonResponse(503, { error: { code: 503, message: 'This model is currently experiencing high demand.' } });
    }
    throw new Error(`err fetch: unexpected URL ${url}`);
  };
  const env503 = {};
  env503['GEMINI' + '_API_KEY'] = TEST_GEMINI_KEY;
  const w503 = apiLane.createWorker({ env: env503, fetchImpl: errFetch, retryDelayMs: 0 });
  const id503 = await insertCmd('run the hello loop');
  await w503.drain();
  const row503 = await db.get('SELECT * FROM ai_commands WHERE id = ?', [id503]);
  ok(row503.status === 'failed' && row503.answer.includes('No member of the team could answer'),
    'summary: a loop with zero answers still fails and says so');
  ok(row503.answer.includes('1 configured member tried and failed'),
    'summary: a configured member that errored (HTTP 503) is counted as configured-but-failed');
  ok(row503.answer.includes('7 members are not configured'),
    'summary: the unconfigured members are counted separately and accurately');
  ok(!row503.answer.includes('nobody is configured'),
    'summary: never claims "nobody is configured" when a configured member errored (slice-1 wart)');
  const hop503 = await db.get("SELECT * FROM ai_runs WHERE command_id = ? AND member = 'Gemini'", [id503]);
  ok(!!hop503 && hop503.status === 'failed' && hop503.error === 'HTTP_503',
    'summary: ai_runs records the errored hop as failed with error HTTP_503');

  console.log('api lane worker (no keys configured — honest failure):');
  const unkeyed = apiLane.createWorker({ env: {}, fetchImpl: mockFetch([]), retryDelayMs: 0 });
  const nkId = await insertCmd('Have Gemini say the word ready');
  await unkeyed.drain();
  const nkRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [nkId]);
  ok(nkRow.status === 'failed' && nkRow.answer.includes('not configured'),
    'missing key: the run fails honestly with a "not configured" result — never a fake answer');
  ok(!/paste/i.test(nkRow.answer),
    'missing key: the failure never hands the user a copy-paste chore (owner law)');
  const nkHop = await db.get("SELECT * FROM ai_runs WHERE command_id = ? AND member = 'Gemini'", [nkId]);
  ok(!!nkHop && nkHop.status === 'skipped' && nkHop.error === 'NO_KEY',
    'missing key: ai_runs records the hop as skipped with error NO_KEY');
  const nkLoopId = await insertCmd('run the hello loop');
  await unkeyed.drain();
  const nkLoopRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [nkLoopId]);
  ok(nkLoopRow.status === 'failed' && nkLoopRow.answer.includes('No member of the team could answer'),
    'missing keys: a hello loop with nobody configured fails and says so');

  console.log('api lane claim lifecycle + watchdog:');
  const devId = await insertCmd('Have Gemini say the word ready', 'device');
  ok((await keyed.claimNext()) === null, 'claim: device-lane commands are never claimed by the worker');
  const claimId = await insertCmd('Have Gemini say the word ready');
  const claimed = await keyed.claimNext();
  ok(!!claimed && claimed.id === claimId && claimed.status === 'claimed' && claimed.attempts === 1,
    'claim: oldest queued API-lane command claims atomically with attempts incremented');
  ok((await keyed.claimNext()) === null, 'claim: a claimed command cannot be claimed twice');
  await db.update('ai_commands', claimId, { claimed_at: Date.now() - 10 * 60 * 1000 });
  await keyed.watchdog();
  const reRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [claimId]);
  ok(reRow.status === 'queued' && reRow.claimed_by === null,
    'watchdog: a stuck claim under the attempt cap is re-queued');
  await keyed.drain();
  const reDone = await db.get('SELECT * FROM ai_commands WHERE id = ?', [claimId]);
  ok(reDone.status === 'done', 'watchdog: the re-queued command then executes to done');
  const stuckId = await insertCmd('Have Gemini say the word ready', 'api', {
    status: 'running', claimed_by: 'dead-worker', claimed_at: Date.now() - 10 * 60 * 1000, attempts: 3,
  });
  await keyed.watchdog();
  const stuckRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [stuckId]);
  ok(stuckRow.status === 'failed' && stuckRow.answer.includes('interrupted 3 times'),
    'watchdog: a command out of attempts fails with the reason in plain words');
  const devRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [devId]);
  ok(devRow.status === 'queued', 'lifecycle: the device-lane row was left untouched throughout');
}

async function runHttpTests(ok) {
  console.log('api lane enqueue contract (HTTP):');
  const PIPE = process.env.MUSE_SERVICE_TOKEN;
  const call = (method, p, body, token) => fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const deviceKey = 'test-device-key-apilane-http';
  const code = crypto.createHash('sha256').update(deviceKey, 'utf8').digest('hex').slice(0, 8).toUpperCase();
  let r = await call('POST', '/api/muse/ai-commands/register', { pairing_code: code, device_id: 'api-lane-http' }, PIPE);
  ok(r.status === 200, 'api lane http: register device (service)');

  r = await call('POST', '/api/muse/ai-commands', { text: 'Have Gemini say the word ready', device_id: 'api-lane-http', lane: 'api', origin: 'hq' }, PIPE);
  let j = await r.json();
  ok(r.status === 200 && j.ok && j.lane === 'api' && j.origin === 'hq',
    'api lane http: enqueue accepts lane=api + origin=hq and echoes them');
  const apiCmdId = j.id;

  r = await call('POST', '/api/muse/ai-commands', { text: 'device lane default', device_id: 'api-lane-http' }, PIPE);
  j = await r.json();
  ok(r.status === 200 && j.lane === 'device' && j.origin === 'hq',
    'api lane http: enqueue without a lane defaults to device (today\'s behavior preserved)');
  const devCmdId = j.id;

  r = await call('GET', '/api/muse/ai-commands', undefined, deviceKey);
  j = await r.json();
  ok(r.status === 200 && j.commands.length === 1 && j.commands[0].id === devCmdId,
    'api lane http: device poll returns ONLY the device-lane command — the API-lane row is never handed to the phone');

  r = await call('GET', '/api/muse/ai-commands?device_id=api-lane-http', undefined, PIPE);
  j = await r.json();
  const apiRow = (j.commands || []).find((c) => c.id === apiCmdId);
  ok(!!apiRow && apiRow.lane === 'api' && apiRow.status === 'queued',
    'api lane http: the API-lane command stays queued for the backend worker (worker is off under the test harness)');
}

module.exports = { runDbTests, runHttpTests };
