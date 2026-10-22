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

// Copilot phone-lane bridge fixtures: created in the DB phase (the
// HTTP phase has no live db handle), consumed over HTTP.
let httpFixtureParentId = null;
let httpFixtureChildId = null;

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

// Slice 3: a settled (done) API-lane command already sitting in a
// device's persistent log — the "last answer" / "current loop" the
// share / check / compare / summarize grammar reads.
async function seedSettled(deviceId, text, answer, at) {
  const id = crypto.randomUUID();
  await db.insert('ai_commands', {
    id, device_id: deviceId, text, status: 'done', answer,
    delivered_at: null, completed_at: at + 1,
    origin: 'device', lane: 'api', claimed_by: 'seed', claimed_at: at, attempts: 1,
    created_at: at,
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
  ok(loopRow.answer.includes('[FROM Copilot]') && loopRow.answer.includes('asked through the phone')
    && loopRow.answer.includes('Copilot has no API'),
  'hello loop: Copilot is asked through the phone (it has no API) — its block says so, never a fake answer');
  const loopRuns = await db.all('SELECT * FROM ai_runs WHERE command_id = ?', [loopId]);
  const loopHops = loopRuns.filter((r) => r.member);
  ok(loopRuns.length === 9 && loopHops.length === 8
    && loopHops.filter((r) => r.status === 'done').length === 2
    && loopHops.filter((r) => r.status === 'skipped').length === 5
    && loopHops.filter((r) => r.status === 'delegated' && r.lane === 'device').length === 1,
  'hello loop: ai_runs records all 8 hops (2 done, 5 skipped with reasons, Copilot delegated on the device lane)');
  const keyedLoopChild = await db.get('SELECT * FROM ai_commands WHERE parent_id = ?', [loopId]);
  ok(!!keyedLoopChild && keyedLoopChild.lane === 'device' && keyedLoopChild.status === 'queued'
    && keyedLoopChild.text.startsWith('Have Copilot'),
  'hello loop: a linked device-lane child carries the Copilot greeting for the phone');

  const gptId = await insertCmd('Have ChatGPT say the word ready');
  await keyed.drain();
  const gptRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [gptId]);
  ok(gptRow.status === 'done' && gptRow.answer.includes('[FROM ChatGPT]')
    && gptRow.answer.includes('not configured on the server (no API key set)')
    && gptRow.answer.includes('failed over to Gemini')
    && gptRow.answer.includes('[FROM Gemini]\nHello from Gemini!\n[END]'),
  'route failover (slice 3): an unconfigured target (adapter, no key) fails over to the next configured member — the target\'s absence block names the failover and the winner answers');
  ok(!/paste/i.test(gptRow.answer),
    'route failover: the failover never hands the user a copy-paste chore (owner law)');
  const gptRuns = await db.all('SELECT * FROM ai_runs WHERE command_id = ?', [gptId]);
  const gptSkip = gptRuns.find((r) => r.member === 'ChatGPT');
  const gptWin = gptRuns.find((r) => r.member === 'Gemini');
  ok(!!gptSkip && gptSkip.status === 'skipped' && gptSkip.error === 'NO_KEY'
    && !!gptWin && gptWin.status === 'done',
  'route failover: ai_runs records the target hop skipped (NO_KEY) and the failover hop done');

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
  ok(copRow.status === 'done'
    && copRow.answer === '[FROM Copilot]\n(asked through the phone — Copilot has no API, so it answers through the app on the phone; its reply lands in the log when the phone picks it up)\n[END]',
  'route: Copilot is delegated to the phone — the parent completes with the honest asked-through-the-phone block, never a NO_API dead-end, never a fake answer, never a substitute product under its name');
  ok(!/paste/i.test(copRow.answer),
    'route: the Copilot delegation never hands the user a copy-paste chore (owner law)');
  const copChild = await db.get('SELECT * FROM ai_commands WHERE parent_id = ?', [copId]);
  ok(!!copChild && copChild.lane === 'device' && copChild.status === 'queued'
    && copChild.text === 'Have Copilot say the word ready' && copChild.device_id === 'api-lane-test',
  'route: exactly one linked device-lane child spawns, carrying the command text for the phone executor');
  const copHop = await db.get("SELECT * FROM ai_runs WHERE command_id = ? AND member = 'Copilot'", [copId]);
  ok(!!copHop && copHop.status === 'delegated' && copHop.lane === 'device',
    'route: ai_runs records the Copilot hop as delegated on the device lane');

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
    && fullLoopHops.filter((r) => r.status === 'delegated' && r.lane === 'device').length === 1
    && fullLoopHops.filter((r) => r.status === 'skipped').length === 0,
  'hello loop (slice 2): ai_runs records 7 done hops + Copilot delegated to the phone lane');
  ok(fullLoopRow.answer.includes('[FROM Copilot]') && fullLoopRow.answer.includes('asked through the phone'),
    'hello loop (slice 2): the Copilot block says it was asked through the phone');

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
  ok(row503.status === 'done' && row503.answer.includes('No member answered over the API this round'),
    'summary: a loop where every API member fails still completes when Copilot is out with the phone, and says so');
  ok(row503.answer.includes('1 configured member tried and failed'),
    'summary: a configured member that errored (HTTP 503) is counted as configured-but-failed');
  ok(row503.answer.includes('6 members are not configured'),
    'summary: the unconfigured members are counted separately and accurately (Copilot is not counted among them anymore)');
  ok(row503.answer.includes('Copilot was asked through the phone'),
    'summary: the pending phone hop is named in the summary');
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
  ok(nkLoopRow.status === 'done' && nkLoopRow.answer.includes('asked through the phone')
    && nkLoopRow.answer.includes('7 members are not configured'),
  'missing keys: a hello loop with nobody configured completes honestly — every API member named not-configured, Copilot asked through the phone');

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

  console.log('copilot phone-lane bridge (child spawn, linkage, honest failure):');
  const bridge = apiLane.createWorker({ env: {}, fetchImpl: mockFetch([]), retryDelayMs: 0, workerId: 'test-bridge' });

  // Linkage: the phone answers the child; the parent record learns.
  const brId = await insertCmd('Have Copilot say the word ready');
  await bridge.drain();
  const brRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [brId]);
  const brChild = await db.get('SELECT * FROM ai_commands WHERE parent_id = ?', [brId]);
  ok(brRow.status === 'done' && !!brChild && brChild.status === 'queued',
    'bridge: a Copilot route leaves the parent done with its child queued for the phone');
  await db.update('ai_commands', brChild.id, {
    status: 'done', answer: 'Ready — straight from the phone.', completed_at: Date.now(),
  });
  const fin1 = await apiLane.finalizeCopilotHop(brId, brRow.answer);
  ok(fin1.changed && fin1.answer.includes('[FROM Copilot]')
    && fin1.answer.includes('via phone') && fin1.answer.includes('Ready — straight from the phone.')
    && !fin1.answer.includes('asked through the phone'),
  'bridge: finalize swaps the pending block for the real phone answer under a via-phone label');
  await db.update('ai_commands', brId, { answer: fin1.answer });
  const brHop = await db.get("SELECT * FROM ai_runs WHERE command_id = ? AND member = 'Copilot'", [brId]);
  ok(!!brHop && brHop.status === 'done' && brHop.lane === 'device',
    'bridge: the delegated ai_runs hop settles to done on the device lane');
  const fin2 = await apiLane.finalizeCopilotHop(brId, fin1.answer);
  ok(!fin2.changed && fin2.answer === fin1.answer,
    'bridge: finalize is idempotent — a second fold changes nothing');

  // Honest failure: the phone reports the pane failure; that is
  // what the parent record shows.
  const bfId = await insertCmd('Have Copilot write a haiku');
  await bridge.drain();
  const bfChild = await db.get('SELECT * FROM ai_commands WHERE parent_id = ?', [bfId]);
  await db.update('ai_commands', bfChild.id, {
    status: 'failed', answer: 'composer not found (sign-in wall)', completed_at: Date.now(),
  });
  const bfParent = await db.get('SELECT * FROM ai_commands WHERE id = ?', [bfId]);
  const finF = await apiLane.finalizeCopilotHop(bfId, bfParent.answer);
  ok(finF.changed && finF.answer.includes('via phone — Copilot could not answer on the phone: composer not found (sign-in wall)'),
    'bridge: an on-phone failure lands in the parent record as the outcome — named, never papered over');
  const bfHop = await db.get("SELECT * FROM ai_runs WHERE command_id = ? AND member = 'Copilot'", [bfId]);
  ok(!!bfHop && bfHop.status === 'failed' && bfHop.error === 'PHONE_FAILED' && bfHop.lane === 'device',
    'bridge: ai_runs settles the failed phone hop as failed with PHONE_FAILED');

  // Loop linkage: completing the full-team loop's child upgrades
  // only the Copilot block; the API blocks stand untouched.
  const ftChild = await db.get('SELECT * FROM ai_commands WHERE parent_id = ?', [fullLoopId]);
  ok(!!ftChild && ftChild.text.includes('say hello'),
    'bridge: the loop child carries the greeting instruction for Copilot');
  await db.update('ai_commands', ftChild.id, {
    status: 'done', answer: 'Hello team — Copilot here.', completed_at: Date.now(),
  });
  const finL = await apiLane.finalizeCopilotHop(fullLoopId, fullLoopRow.answer);
  ok(finL.changed && finL.answer.includes('Hello team — Copilot here.')
    && finL.answer.includes('[FROM Gemini]\nHello from Gemini!\n[END]')
    && finL.answer.split('[FROM Copilot]').length === 2,
  'bridge: the loop record gains Copilot\'s real reply in place of the pending block — one Copilot block, API blocks untouched');

  // Fixtures for the HTTP result-route linkage test below: a
  // finished API parent holding the pending block, its delivered
  // device child, and the delegated hop row — exactly what the
  // worker leaves behind. The HTTP phase posts the child's result
  // with the device key and reads the parent back over HTTP.
  httpFixtureParentId = crypto.randomUUID();
  httpFixtureChildId = crypto.randomUUID();
  await db.insert('ai_commands', {
    id: httpFixtureParentId, device_id: 'api-lane-http', text: 'Have Copilot say the word ready',
    status: 'done', answer: apiLane.copilotPendingBlock(), delivered_at: null, completed_at: Date.now(),
    origin: 'hq', lane: 'api', claimed_by: 'fixture', claimed_at: Date.now(), attempts: 1, parent_id: null,
  });
  await db.insert('ai_commands', {
    id: httpFixtureChildId, device_id: 'api-lane-http', text: 'Have Copilot say the word ready',
    status: 'delivered', answer: null, delivered_at: Date.now(), completed_at: null,
    origin: 'hq', lane: 'device', claimed_by: null, claimed_at: null, attempts: 0,
    parent_id: httpFixtureParentId,
  });
  await db.insert('ai_runs', {
    command_id: httpFixtureParentId, member: 'Copilot', model: null, status: 'delegated',
    error: null, lane: 'device', prompt_tokens: null, completion_tokens: null, cost_microusd: null,
    started_at: Date.now(), finished_at: Date.now(),
  });

  // Re-execution idempotency: a parent interrupted mid-delegation
  // (stuck 'running', child already spawned) re-runs through the
  // watchdog and still ends up with exactly ONE child.
  const reParentId = crypto.randomUUID();
  await db.insert('ai_commands', {
    id: reParentId, device_id: 'api-lane-test', text: 'Have Copilot say the word ready',
    status: 'running', answer: null, delivered_at: null, completed_at: null,
    origin: 'hq', lane: 'api', claimed_by: 'dead-worker', claimed_at: Date.now() - 10 * 60 * 1000, attempts: 1,
    parent_id: null,
  });
  await db.insert('ai_commands', {
    device_id: 'api-lane-test', text: 'Have Copilot say the word ready',
    status: 'queued', answer: null, delivered_at: null, completed_at: null,
    origin: 'hq', lane: 'device', claimed_by: null, claimed_at: null, attempts: 0,
    parent_id: reParentId,
  });
  await bridge.watchdog();
  await bridge.drain();
  const reChildren = await db.all('SELECT * FROM ai_commands WHERE parent_id = ?', [reParentId]);
  const reParent = await db.get('SELECT * FROM ai_commands WHERE id = ?', [reParentId]);
  ok(reChildren.length === 1 && reParent.status === 'done'
    && reParent.answer.includes('asked through the phone'),
  'bridge: a re-executed parent reuses its existing phone child — one parent, one child, however many attempts');

  console.log('api lane slice 3 — full team grammar:');
  // Parser pins: the exact phrase forms the thin client forwards
  // verbatim (mirrors the button's AiNameRouter).
  const pc = apiLane.parseCommand;
  ok(pc('run the word loop').type === 'word_loop' && pc('word loop').type === 'word_loop'
    && pc('run the word chain').type === 'word_loop',
    'slice 3 parse: word-loop forms parse as word_loop, never as the hello loop');
  ok(pc('read the log').type === 'read_log' && pc('read me the log').type === 'read_log',
    'slice 3 parse: read-the-log forms');
  ok(pc('summarize the loop').type === 'summarize' && pc('summarise').type === 'summarize',
    'slice 3 parse: summarize forms');
  const cmpPin = pc('compare answers on ink brands');
  ok(cmpPin.type === 'compare' && cmpPin.prompt === 'ink brands',
    'slice 3 parse: compare with a prompt extracts the question');
  ok(pc('compare answers').type === 'compare' && pc('compare answers').prompt === '',
    'slice 3 parse: bare "compare answers" means compare the log as it stands');
  const bcPin = pc('Brainstorm across all AI: name one color that suits a koi tattoo');
  ok(bcPin.type === 'broadcast' && bcPin.prompt === 'name one color that suits a koi tattoo',
    'slice 3 parse: brainstorm-across-all extracts the broadcast prompt');
  ok(pc('ask all ais what is 2+2').type === 'broadcast' && pc('ask all ais what is 2+2').prompt === 'what is 2+2',
    'slice 3 parse: ask-all-AIs broadcast form');
  const chkPin = pc('Have Claude check that');
  ok(chkPin.type === 'check' && chkPin.member === 'Claude',
    'slice 3 parse: "Have <AI> check that" is a named check, not a route');
  ok(pc('check that').type === 'check' && pc('check that').member === null && pc('check it').type === 'check',
    'slice 3 parse: bare check that/it is the peer-review form');
  const cntPin = pc('continue with Gemini and make it shorter');
  ok(cntPin.type === 'continue' && cntPin.member === 'Gemini' && cntPin.followUp === 'and make it shorter',
    'slice 3 parse: continue-with carries the member and the follow-up');
  ok(pc('share with Claude').type === 'share' && pc('share with Claude').member === 'Claude'
    && pc('send it to Grok').member === 'Grok' && pc('pass it to ChatGPT').member === 'ChatGPT',
    'slice 3 parse: share/send/pass forms name the receiving member');
  ok(apiLane.extractAddedWord('Hello', 'Hello world').word === 'world'
    && apiLane.extractAddedWord('Hello', 'Hello').kind === 'none'
    && apiLane.extractAddedWord('Hello', 'Something else entirely').kind === 'fidelity',
  'slice 3: word-loop extraction reads the added word, flags a no-op reply, flags a fidelity break');

  const seedBase = Date.now() - 120000;

  // SHARE — the last answer is handed to the named member.
  await seedSettled('s3-share', 'Have Gemini name a color for a koi tattoo',
    '[FROM Gemini]\nCrimson — it reads as strength against black linework.\n[END]', seedBase);
  const shareId = await insertCmd('share with ChatGPT', 'api', { device_id: 's3-share' });
  const callsBeforeShare = calls2.length;
  await full.drain();
  const shareRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [shareId]);
  ok(shareRow.status === 'done' && shareRow.answer === '[FROM ChatGPT]\nHello from ChatGPT!\n[END]',
    'slice 3 share: the receiving member\'s answer posts as its block');
  const shareCall = calls2.slice(callsBeforeShare).find((c) => c.url.includes('api.openai.com'));
  ok(!!shareCall && String(shareCall.opts.body).includes('Crimson — it reads as strength against black linework.')
    && String(shareCall.opts.body).includes('name a color for a koi tattoo'),
  'slice 3 share: the shared answer AND the original request travel into the receiving member\'s prompt');
  const shareNoneId = await insertCmd('share with Claude', 'api', { device_id: 's3-share-none' });
  await full.drain();
  const shareNoneRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [shareNoneId]);
  ok(shareNoneRow.status === 'failed' && shareNoneRow.answer.includes('nothing to share yet'),
    'slice 3 share: with no earlier answer in the log it fails honestly instead of inventing context');

  // CONTINUE WITH <AI> — log context + the owner's follow-up.
  await seedSettled('s3-continue', 'Have Gemini draft a tagline',
    '[FROM Gemini]\nInk that outlives trends.\n[END]', seedBase + 1000);
  const contId = await insertCmd('continue with Claude and make it punchier', 'api', { device_id: 's3-continue' });
  const callsBeforeCont = calls2.length;
  await full.drain();
  const contRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [contId]);
  ok(contRow.status === 'done' && contRow.answer === '[FROM Claude]\nHello from Claude!\n[END]',
    'slice 3 continue: the named member picks the loop up and its answer posts as its block');
  const contCall = calls2.slice(callsBeforeCont).find((c) => c.url.includes('api.anthropic.com'));
  ok(!!contCall && String(contCall.opts.body).includes('Ink that outlives trends.')
    && String(contCall.opts.body).includes('make it punchier'),
  'slice 3 continue: the log context AND the owner\'s follow-up reach the member');

  // CHECK THAT — named checker.
  await seedSettled('s3-check', 'Have Gemini state a fact about koi',
    '[FROM Gemini]\nKoi can live for over a century.\n[END]', seedBase + 2000);
  const chkId = await insertCmd('Have Claude check that', 'api', { device_id: 's3-check' });
  const callsBeforeChk = calls2.length;
  await full.drain();
  const chkRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [chkId]);
  ok(chkRow.status === 'done' && chkRow.answer === '[FROM Claude]\nHello from Claude!\n[END]',
    'slice 3 check (named): the checker\'s verdict posts as its block');
  const chkCall = calls2.slice(callsBeforeChk).find((c) => c.url.includes('api.anthropic.com'));
  ok(!!chkCall && String(chkCall.opts.body).includes('Koi can live for over a century.')
    && String(chkCall.opts.body).includes('verify its claims'),
  'slice 3 check (named): the claim under review travels with the verify framing');

  // CHECK THAT — bare: the OTHER members critique; the author sits out.
  await seedSettled('s3-check-bare', 'Have Gemini state a fact about koi',
    '[FROM Gemini]\nKoi can live for over a century.\n[END]', seedBase + 3000);
  const calls3 = [];
  const full3 = apiLane.createWorker({ env: fullEnv, fetchImpl: mockFetch(calls3), retryDelayMs: 0, workerId: 'test-worker-3' });
  const chkBareId = await insertCmd('check that', 'api', { device_id: 's3-check-bare' });
  await full3.drain();
  const chkBareRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [chkBareId]);
  ok(chkBareRow.status === 'done'
    && chkBareRow.answer.includes('[FROM Claude]') && chkBareRow.answer.includes('[FROM ChatGPT]')
    && chkBareRow.answer.includes('[FROM Copilot]') && chkBareRow.answer.includes('asked through the phone'),
  'slice 3 check (bare): the other members critique — verdict blocks plus Copilot through the phone');
  ok(!chkBareRow.answer.includes('[FROM Gemini]'),
    'slice 3 check (bare): the member who answered last time does not check its own work');
  ok(calls3.filter((c) => c.url.includes('generativelanguage.googleapis.com')).length === 0,
    'slice 3 check (bare): the author (Gemini) is never even called');

  // BROADCAST — full team, then the partial-keys honesty shape.
  const bId = await insertCmd('Brainstorm across all AI: name one color that suits a koi tattoo', 'api', { device_id: 's3-broadcast' });
  await full.drain();
  const bRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [bId]);
  ok(bRow.status === 'done'
    && ['Muse', 'ChatGPT', 'Claude', 'Gemini', 'Perplexity', 'Grok', 'DeepSeek']
      .every((m) => bRow.answer.includes(`[FROM ${m}]`))
    && bRow.answer.includes('[FROM Copilot]') && bRow.answer.includes('asked through the phone'),
  'slice 3 broadcast: every member\'s block lands in the one log, Copilot through the phone bridge');
  const bHops = (await db.all('SELECT * FROM ai_runs WHERE command_id = ?', [bId])).filter((r) => r.member);
  ok(bHops.filter((r) => r.status === 'done').length === 7
    && bHops.filter((r) => r.status === 'delegated' && r.lane === 'device').length === 1,
  'slice 3 broadcast: ai_runs records 7 API answers + the Copilot delegation');
  const bChild = await db.get('SELECT * FROM ai_commands WHERE parent_id = ?', [bId]);
  ok(!!bChild && bChild.lane === 'device' && bChild.text === 'Have Copilot name one color that suits a koi tattoo',
    'slice 3 broadcast: the phone child carries the broadcast prompt for Copilot');
  const bkId = await insertCmd('ask all ais name one color that suits a koi tattoo', 'api', { device_id: 's3-broadcast-keyed' });
  await keyed.drain();
  const bkRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [bkId]);
  ok(bkRow.status === 'done' && bkRow.answer.includes('[FROM Gemini]\nHello from Gemini!\n[END]')
    && bkRow.answer.includes('[FROM DeepSeek]\nReady.\n[END]')
    && bkRow.answer.includes('[FROM ChatGPT]\n(not answered — ChatGPT is not configured on the server (no API key set))\n[END]'),
  'slice 3 broadcast (partial keys): configured members answer, unconfigured members post honest NO_KEY absence blocks');

  // COMPARE ANSWERS — with a prompt (blocks side by side) and
  // against the standing log (the Lead compares).
  const cpId = await insertCmd('compare answers on the best ink color for a koi', 'api', { device_id: 's3-compare' });
  await full.drain();
  const cpRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [cpId]);
  ok(cpRow.status === 'done' && cpRow.answer.includes('[FROM Muse]\nHello from Muse!\n[END]')
    && cpRow.answer.includes('[FROM Gemini]\nHello from Gemini!\n[END]')
    && cpRow.answer.includes('[FROM DeepSeek]\nReady.\n[END]'),
  'slice 3 compare (with prompt): every member answers the same question, blocks side by side in the one log');
  await seedSettled('s3-compare-log', 'Have Gemini name a color for a koi tattoo',
    '[FROM Gemini]\nCrimson.\n[END]', seedBase + 4000);
  await seedSettled('s3-compare-log', 'Have Claude name a color for a koi tattoo',
    '[FROM Claude]\nVermilion.\n[END]', seedBase + 5000);
  const cplId = await insertCmd('compare answers', 'api', { device_id: 's3-compare-log' });
  const callsBeforeCpl = calls2.length;
  await full.drain();
  const cplRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [cplId]);
  ok(cplRow.status === 'done' && cplRow.answer.startsWith('[FROM Muse]'),
    'slice 3 compare (log): the Lead (Muse) reads the log and posts the comparison as its block');
  const cplCall = calls2.slice(callsBeforeCpl).find((c) => c.url.includes('api.meta.ai'));
  ok(!!cplCall && String(cplCall.opts.body).includes('Crimson.') && String(cplCall.opts.body).includes('Vermilion.'),
    'slice 3 compare (log): the recorded answers from the log reach the comparator');

  // READ THE LOG — the persistent log is the answer; nobody is called.
  const rlId = await insertCmd('read the log', 'api', { device_id: 's3-compare-log' });
  const callsBeforeRl = calls2.length;
  await full.drain();
  const rlRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [rlId]);
  ok(rlRow.status === 'done' && rlRow.answer.includes('Have Gemini name a color for a koi tattoo')
    && rlRow.answer.includes('Crimson.') && rlRow.answer.includes('Vermilion.')
    && rlRow.answer.includes('[FROM Muse]'),
  'slice 3 read the log: the persistent log comes back as the answer, commands and answers intact (including the comparison just posted)');
  ok(calls2.length === callsBeforeRl,
    'slice 3 read the log: no member is called — the log speaks for itself');
  const rlEmptyId = await insertCmd('read the log', 'api', { device_id: 's3-empty' });
  await full.drain();
  const rlEmptyRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [rlEmptyId]);
  ok(rlEmptyRow.status === 'done' && rlEmptyRow.answer.includes('team log is empty'),
    'slice 3 read the log: an empty log says so, plainly');

  // SUMMARIZE THE LOOP — Lead first, then first configured member.
  const sumId = await insertCmd('summarize the loop', 'api', { device_id: 's3-compare-log' });
  await full.drain();
  const sumRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [sumId]);
  ok(sumRow.status === 'done' && sumRow.answer === '[FROM Muse]\nHello from Muse!\n[END]',
    'slice 3 summarize: the Lead (Muse) writes the summary when configured');
  await seedSettled('s3-sum-keyed', 'Have Gemini name a color', '[FROM Gemini]\nCrimson.\n[END]', seedBase + 6000);
  const sumKId = await insertCmd('summarize the loop', 'api', { device_id: 's3-sum-keyed' });
  await keyed.drain();
  const sumKRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [sumKId]);
  ok(sumKRow.status === 'done' && sumKRow.answer === '[FROM Gemini]\nHello from Gemini!\n[END]',
    'slice 3 summarize: without the Lead configured, the first configured member in roster order summarizes');

  // WORD LOOP — one word per member, roster order, fidelity named.
  // A compliant member echoes the running sentence plus its word,
  // so this mock reads the sentence out of the prompt (the static
  // mockFetch replies would — correctly — trip the fidelity flag).
  const wlFetch = async (url, opts = {}) => {
    const m = /The sentence so far is: \\?"([^"\\]*)/.exec(String((opts && opts.body) || ''));
    const s = m ? m[1] : 'Hello';
    if (url.includes('generativelanguage.googleapis.com')) {
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: `${s} await` }] } }], usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 3 }, modelVersion: 'gemini-test-1' });
    }
    if (url.includes('api.deepseek.com')) {
      return jsonResponse(200, { choices: [{ message: { content: `${s} everywhere` } }], usage: { prompt_tokens: 60, completion_tokens: 3 }, model: 'deepseek-flash' });
    }
    if (url.includes('api.openai.com')) {
      return jsonResponse(200, { choices: [{ message: { content: `${s} new` } }], usage: { prompt_tokens: 60, completion_tokens: 3 }, model: 'gpt-6.1-sol' });
    }
    if (url.includes('api.anthropic.com')) {
      return jsonResponse(200, { content: [{ type: 'text', text: `${s} worlds` }], usage: { input_tokens: 60, output_tokens: 3 }, model: 'claude-sonnet-5-5' });
    }
    if (url.includes('api.x.ai')) {
      return jsonResponse(200, { choices: [{ message: { content: `${s} explorers` } }], usage: { prompt_tokens: 60, completion_tokens: 3 }, model: 'grok-4.3' });
    }
    if (url.includes('api.perplexity.ai')) {
      return jsonResponse(200, { choices: [{ message: { content: `${s} patient` } }], usage: { prompt_tokens: 60, completion_tokens: 3 }, model: 'sonar' });
    }
    if (url.includes('api.meta.ai')) {
      return jsonResponse(200, { choices: [{ message: { content: `${s} brave` } }], usage: { prompt_tokens: 60, completion_tokens: 3 }, model: 'muse-spark-1.3' });
    }
    throw new Error(`word-loop fetch: unexpected URL ${url}`);
  };
  const wlWorker = apiLane.createWorker({ env: fullEnv, fetchImpl: wlFetch, retryDelayMs: 0, workerId: 'test-wordloop' });
  const wlId = await insertCmd('run the word loop', 'api', { device_id: 's3-wordloop' });
  await wlWorker.drain();
  const wlRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [wlId]);
  ok(wlRow.status === 'done' && wlRow.answer.includes('[FROM Muse]')
    && wlRow.answer.includes('added the word "brave"') && wlRow.answer.includes('added the word "everywhere"'),
  'slice 3 word loop: each member\'s block names the word it added');
  ok(wlRow.answer.includes('The word-loop sentence so far: "Hello brave new worlds await patient explorers everywhere"'),
    'slice 3 word loop: the sentence builds one word per member in roster order and the closing line states it, Copilot\'s word still out with the phone');
  const wlHops = (await db.all('SELECT * FROM ai_runs WHERE command_id = ?', [wlId])).filter((r) => r.member);
  ok(wlHops.filter((r) => r.status === 'done').length === 7,
    'slice 3 word loop: ai_runs records a done hop per answering member');
  const wlChild = await db.get('SELECT * FROM ai_commands WHERE parent_id = ?', [wlId]);
  ok(!!wlChild && wlChild.text.includes('The sentence so far is: "Hello brave new worlds await"'),
    'slice 3 word loop: Copilot\'s phone child carries the sentence as it stood at Copilot\'s turn');

  // WORD LOOP — a member that adds nothing is flagged by name.
  const echoFetch = async (url) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 1 },
        modelVersion: 'gemini-test-1',
      });
    }
    throw new Error(`echo fetch: unexpected URL ${url}`);
  };
  const envEcho = {};
  envEcho['GEMINI' + '_API_KEY'] = TEST_GEMINI_KEY;
  const wEcho = apiLane.createWorker({ env: envEcho, fetchImpl: echoFetch, retryDelayMs: 0, workerId: 'test-echo' });
  const wlEchoId = await insertCmd('run the word loop', 'api', { device_id: 's3-wordloop-echo' });
  await wEcho.drain();
  const wlEchoRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [wlEchoId]);
  ok(wlEchoRow.answer.includes('[FROM Gemini]') && wlEchoRow.answer.includes('added no word'),
    'slice 3 word loop: a member that returns the sentence unchanged is flagged in its block — the word count names the guilty hop');
  const wlEchoHop = await db.get("SELECT * FROM ai_runs WHERE command_id = ? AND member = 'Gemini'", [wlEchoId]);
  ok(!!wlEchoHop && wlEchoHop.status === 'failed' && wlEchoHop.error === 'NO_WORD',
    'slice 3 word loop: ai_runs records the no-word hop as failed with NO_WORD');

  // ROUTE FAILOVER — provider error after retry; nobody to take over.
  const calls4 = [];
  const baseMock4 = mockFetch(calls4);
  const flakyFetch = async (url, opts) => {
    if (url.includes('api.openai.com')) {
      calls4.push({ url, opts });
      return jsonResponse(500, { error: 'boom' });
    }
    return baseMock4(url, opts);
  };
  const full4 = apiLane.createWorker({ env: fullEnv, fetchImpl: flakyFetch, retryDelayMs: 0, workerId: 'test-worker-4' });
  const foId = await insertCmd('Have ChatGPT say the word ready', 'api', { device_id: 's3-failover' });
  await full4.drain();
  const foRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [foId]);
  ok(foRow.status === 'done' && foRow.answer.includes('failed over to Claude')
    && foRow.answer.includes('[FROM Claude]\nHello from Claude!\n[END]'),
  'slice 3 failover: a routed member whose provider errors (after the built-in retry) fails over to the next configured member, named in the log');
  ok(calls4.filter((c) => c.url.includes('api.openai.com')).length === 2,
    'slice 3 failover: the failing provider was retried exactly once before the failover');
  const foHop = await db.get("SELECT * FROM ai_runs WHERE command_id = ? AND member = 'ChatGPT'", [foId]);
  ok(!!foHop && foHop.status === 'failed' && foHop.error === 'HTTP_500',
    'slice 3 failover: ai_runs records the failed hop with its provider error');
  const foNoneId = await insertCmd('Have ChatGPT say the word ready', 'api', { device_id: 's3-failover-none' });
  await unkeyed.drain();
  const foNoneRow = await db.get('SELECT * FROM ai_commands WHERE id = ?', [foNoneId]);
  ok(foNoneRow.status === 'failed' && foNoneRow.answer.includes('not configured')
    && foNoneRow.answer.includes('no other member is configured to take over'),
  'slice 3 failover: with nobody configured to take over, the route settles failed with the honest reason');
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

  console.log('copilot phone-lane bridge (HTTP result linkage):');
  r = await call('POST', `/api/muse/ai-commands/${httpFixtureChildId}/result`,
    { status: 'done', answer: 'Ready — posted by the phone.' }, deviceKey);
  j = await r.json();
  ok(r.status === 200 && j.ok === true,
    'bridge http: the phone posts its Copilot child result with the device key');
  r = await call('GET', '/api/muse/ai-commands?device_id=api-lane-http', undefined, PIPE);
  j = await r.json();
  const fxParent = (j.commands || []).find((c) => c.id === httpFixtureParentId);
  ok(!!fxParent && fxParent.answer.includes('[FROM Copilot]')
    && fxParent.answer.includes('via phone') && fxParent.answer.includes('Ready — posted by the phone.')
    && !fxParent.answer.includes('asked through the phone'),
  'bridge http: the parent record now shows Copilot\'s real reply labeled via phone — the pending wording is gone');
  const fxChild = (j.commands || []).find((c) => c.id === httpFixtureChildId);
  ok(!!fxChild && fxChild.status === 'done',
    'bridge http: the child itself reads done with its posted answer');
}

module.exports = { runDbTests, runHttpTests };
