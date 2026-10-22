// AI Master Button — API lane worker (slice 1, owner approval 2026-10-22).
//
// Commands used to execute inside the phone app (WebView panes) — the
// one leg that never worked reliably. The API lane moves execution
// here: this in-process worker claims rows from ai_commands where
// lane = 'api', executes them against the members' OFFICIAL APIs with
// server-side keys, and posts the result back onto the command row in
// the [FROM <AI>] ... [END] envelope. The phone is a thin client (mic,
// panel, display): a command completes with the phone powered off.
//
// Owner law baked in (2026-10-22):
//   - Customers NEVER touch API keys. Keys are server env vars only
//     (GEMINI_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY,
//     ANTHROPIC_API_KEY, XAI_API_KEY, PERPLEXITY_API_KEY,
//     META_MODEL_API_KEY). There is no key UI, no key field, nothing
//     customer-facing about keys anywhere in the lane.
//   - No copy-paste chore, and the Easier Test: the user speaks or
//     types in the button ONCE and the command goes where he told it,
//     automatically — fewer steps than opening the app himself. A
//     member that cannot be reached automatically FAILS HONESTLY
//     (named, with the reason) — never a fake answer, never a manual
//     carrying step handed back to the user.
//
// Scope: grammar ROUTE + HELLO LOOP (slice 1); member adapters
// Gemini + DeepSeek (slice 1) and ChatGPT, Claude, Grok, Perplexity,
// Muse (slice 2). Members without an adapter yet or without a
// configured key are named in the result with the reason — never
// silently skipped. Copilot has no API at all (design §3.8), so it
// joins through the phone-lane bridge below (owner order
// 2026-10-22): a linked device-lane child command the phone
// executes, whose posted answer is folded back into the parent
// record labeled "via phone". NO_API is never the final word.
//
// Lifecycle: queued -> claimed -> running -> done | failed. Claiming
// is a race-safe conditional UPDATE (only one claimant wins). A claim
// older than WATCHDOG_MS with no completion is re-queued by the
// watchdog; after MAX_ATTEMPTS the command lands failed with the
// reason in plain words on the row — visible, never silent limbo.
const crypto = require('crypto');
const db = require('../db');

const POLL_MS = 3000;
const WATCHDOG_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const HTTP_TIMEOUT_MS = 60000;
const ANSWER_CAP = 8000; // matches the device result-post cap in routes/muse.js

// Team roster, in the order loops run and report (the button's
// AiAssistants.ALL order — Muse first).
const ROSTER = ['Muse', 'ChatGPT', 'Claude', 'Gemini', 'Copilot', 'Perplexity', 'Grok', 'DeepSeek'];
const ALIASES = {
  muse: 'Muse', 'meta ai': 'Muse', meta: 'Muse',
  chatgpt: 'ChatGPT', gpt: 'ChatGPT', openai: 'ChatGPT',
  claude: 'Claude', anthropic: 'Claude',
  gemini: 'Gemini', google: 'Gemini',
  copilot: 'Copilot', microsoft: 'Copilot',
  perplexity: 'Perplexity', sonar: 'Perplexity',
  grok: 'Grok', xai: 'Grok',
  deepseek: 'DeepSeek',
};
// Members with NO consumer API (design §3.8): no server-side call
// can reach them. Copilot is bridged through the phone lane (see
// the bridge section below); memberState still reports no_api for
// it, and the execution paths preempt that with the bridge.
const NO_API_MEMBERS = new Set(['Copilot']);

// Estimated prices, USD per 1M tokens (design 2026-10-22 §4 shipped
// defaults: Gemini 3.8 Flash paid rate, DeepSeek Flash off-peak,
// ChatGPT gpt-6.1-sol, Claude Sonnet 5.5, Grok 4.3, Perplexity sonar,
// Muse Spark 1.3). Perplexity also charges a per-request fee (design
// §3.6: $5 per 1,000 requests at low search context = 5000 micro-USD
// per call), carried as perRequestMicroUsd. ai_runs stores these
// estimates next to the MEASURED token counts.
const PRICES = {
  Muse: { inPerM: 1.25, outPerM: 4.25 },
  ChatGPT: { inPerM: 2.00, outPerM: 10.00 },
  Claude: { inPerM: 2.00, outPerM: 10.00 },
  Gemini: { inPerM: 0.75, outPerM: 3.75 },
  Perplexity: { inPerM: 1.00, outPerM: 1.00, perRequestMicroUsd: 5000 },
  Grok: { inPerM: 1.25, outPerM: 2.50 },
  DeepSeek: { inPerM: 0.15, outPerM: 0.60 },
};

const PRIMER = [
  'You are one member of an AI team coordinated by the AI Master Button.',
  'The team is: Muse, ChatGPT, Claude, Gemini, Copilot, Perplexity, Grok, DeepSeek.',
  "The owner's Lead AI is Muse. Answer the owner's request directly, in your own",
  'voice, in plain language, and keep it concise unless the request asks for depth.',
  'You may be handed a running team log of earlier answers in [FROM <AI>] blocks:',
  "treat it as shared team memory — build on it, don't repeat it, and never claim",
  "another member's words as your own. Never invent another member's answer.",
  'If you cannot do something, say so plainly in one line.',
].join('\n');

class MemberError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function resolveMember(name) {
  const key = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return ALIASES[key] || null;
}

// Grammar (slice 1): ROUTE ("Have <AI> <task>", also Ask/Tell) and the
// HELLO LOOP ("hello loop" / "run the loop"). Anything else is reported
// unsupported — honestly, in the result — until later slices land.
const ROUTE_VERB = /^(?:please\s+)?(?:have|ask|tell)\s+/i;
function parseCommand(rawText) {
  const text = String(rawText || '').trim();
  if (/\bhello loop\b/i.test(text) || /\brun the loop\b/i.test(text)) {
    return { type: 'hello_loop' };
  }
  const vm = ROUTE_VERB.exec(text);
  if (vm) {
    const rest = text.slice(vm[0].length);
    const lower = rest.toLowerCase();
    // Longest alias first so "meta ai" wins over "meta".
    const names = Object.keys(ALIASES).sort((a, b) => b.length - a.length);
    for (const name of names) {
      if (lower === name || lower.startsWith(name + ' ')) {
        const task = rest.slice(name.length).trim().replace(/^to\s+/i, '');
        if (task) return { type: 'route', member: ALIASES[name], task };
      }
    }
  }
  return { type: 'unsupported' };
}

function envelope(member, text) {
  return `[FROM ${member}]\n${String(text).trim()}\n[END]`;
}
function absenceBlock(member, reasonText) {
  return envelope(member, `(not answered — ${reasonText})`);
}

function costMicroUsd(member, promptTokens, completionTokens) {
  const p = PRICES[member];
  if (!p) return null;
  const usd = ((promptTokens || 0) * p.inPerM + (completionTokens || 0) * p.outPerM) / 1e6;
  return Math.round(usd * 1e6) + (p.perRequestMicroUsd || 0);
}

// Provider error text is stored on ai_runs and echoed in results, so it
// is capped and scrubbed of the key value (defense in depth: keys never
// appear in anything we store or return).
function cleanErrorText(text, secret) {
  let s = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (secret) s = s.split(secret).join('[redacted]');
  return s;
}

function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return Promise.resolve()
    .then(() => fetchImpl(url, { ...options, signal: ctrl.signal }))
    .finally(() => clearTimeout(timer));
}

// ── Adapters ────────────────────────────────────────────────────────
// One Member interface: { member, model, configured, call({system,
// user, maxTokens}) -> { text, model, promptTokens, completionTokens } }.
// Keys are read from the env object at build time and used ONLY as
// request headers — never in URLs, never logged, never stored.

function geminiAdapter(env, fetchImpl) {
  const key = env.GEMINI_API_KEY || '';
  const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
  return {
    member: 'Gemini',
    model,
    configured: !!key,
    async call({ system, user, maxTokens }) {
      if (!key) throw new MemberError('NO_KEY', 'Gemini is not configured on the server (no API key set)');
      let res;
      try {
        res = await fetchWithTimeout(fetchImpl,
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: system }] },
              contents: [{ role: 'user', parts: [{ text: user }] }],
              generationConfig: { maxOutputTokens: maxTokens },
            }),
          }, HTTP_TIMEOUT_MS);
      } catch (e) {
        throw new MemberError('NETWORK', `Gemini call failed: ${cleanErrorText(e.message, key)}`);
      }
      const raw = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new MemberError('BAD_KEY', `Gemini rejected the server API key (HTTP ${res.status})`);
      }
      if (!res.ok) {
        throw new MemberError(`HTTP_${res.status}`, `Gemini returned HTTP ${res.status}: ${cleanErrorText(raw, key)}`);
      }
      let data;
      try { data = JSON.parse(raw); } catch { throw new MemberError('BAD_RESPONSE', 'Gemini returned a response that was not JSON'); }
      const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      const text = parts.map((p) => p.text || '').join('').trim();
      if (!text) throw new MemberError('EMPTY', 'Gemini returned an empty answer');
      return {
        text,
        model: data.modelVersion || model,
        promptTokens: data.usageMetadata ? (data.usageMetadata.promptTokenCount ?? null) : null,
        completionTokens: data.usageMetadata ? (data.usageMetadata.candidatesTokenCount ?? null) : null,
      };
    },
  };
}

function deepseekAdapter(env, fetchImpl) {
  const key = env.DEEPSEEK_API_KEY || '';
  const model = env.DEEPSEEK_MODEL || 'deepseek-flash';
  const base = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  return {
    member: 'DeepSeek',
    model,
    configured: !!key,
    async call({ system, user, maxTokens }) {
      if (!key) throw new MemberError('NO_KEY', 'DeepSeek is not configured on the server (no API key set)');
      let res;
      try {
        res = await fetchWithTimeout(fetchImpl, `${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            max_tokens: maxTokens,
          }),
        }, HTTP_TIMEOUT_MS);
      } catch (e) {
        throw new MemberError('NETWORK', `DeepSeek call failed: ${cleanErrorText(e.message, key)}`);
      }
      const raw = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new MemberError('BAD_KEY', `DeepSeek rejected the server API key (HTTP ${res.status})`);
      }
      if (res.status === 402) {
        throw new MemberError('NO_BALANCE', 'DeepSeek reports no prepaid balance on the server account (HTTP 402)');
      }
      if (!res.ok) {
        throw new MemberError(`HTTP_${res.status}`, `DeepSeek returned HTTP ${res.status}: ${cleanErrorText(raw, key)}`);
      }
      let data;
      try { data = JSON.parse(raw); } catch { throw new MemberError('BAD_RESPONSE', 'DeepSeek returned a response that was not JSON'); }
      const choice = data && data.choices && data.choices[0];
      const text = choice && choice.message ? String(choice.message.content || '').trim() : '';
      if (!text) throw new MemberError('EMPTY', 'DeepSeek returned an empty answer');
      return {
        text,
        model: data.model || model,
        promptTokens: data.usage ? (data.usage.prompt_tokens ?? null) : null,
        completionTokens: data.usage ? (data.usage.completion_tokens ?? null) : null,
      };
    },
  };
}

// Slice 2: ChatGPT, Grok, Perplexity, and Muse all speak the OpenAI
// chat-completions shape (design §3), so they share one factory —
// same Member interface, same error vocabulary, same header-only key
// handling as DeepSeek above. Only the member's name, endpoint, env
// names, and default model differ.
function chatCompletionsAdapter(cfg, env, fetchImpl) {
  const key = env[cfg.keyEnv] || '';
  const model = env[cfg.modelEnv] || cfg.defaultModel;
  const base = (env[cfg.baseEnv] || cfg.defaultBase).replace(/\/$/, '');
  const member = cfg.member;
  return {
    member,
    model,
    configured: !!key,
    async call({ system, user, maxTokens }) {
      if (!key) throw new MemberError('NO_KEY', `${member} is not configured on the server (no API key set)`);
      let res;
      try {
        res = await fetchWithTimeout(fetchImpl, `${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            max_tokens: maxTokens,
          }),
        }, HTTP_TIMEOUT_MS);
      } catch (e) {
        throw new MemberError('NETWORK', `${member} call failed: ${cleanErrorText(e.message, key)}`);
      }
      const raw = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new MemberError('BAD_KEY', `${member} rejected the server API key (HTTP ${res.status})`);
      }
      if (res.status === 402) {
        throw new MemberError('NO_BALANCE', `${member} reports no prepaid balance on the server account (HTTP 402)`);
      }
      if (!res.ok) {
        throw new MemberError(`HTTP_${res.status}`, `${member} returned HTTP ${res.status}: ${cleanErrorText(raw, key)}`);
      }
      let data;
      try { data = JSON.parse(raw); } catch { throw new MemberError('BAD_RESPONSE', `${member} returned a response that was not JSON`); }
      const choice = data && data.choices && data.choices[0];
      const text = choice && choice.message ? String(choice.message.content || '').trim() : '';
      if (!text) throw new MemberError('EMPTY', `${member} returned an empty answer`);
      return {
        text,
        model: data.model || model,
        promptTokens: data.usage ? (data.usage.prompt_tokens ?? null) : null,
        completionTokens: data.usage ? (data.usage.completion_tokens ?? null) : null,
      };
    },
  };
}

// ChatGPT — OpenAI (design §3.1), default model gpt-6.1-sol.
function chatgptAdapter(env, fetchImpl) {
  return chatCompletionsAdapter({
    member: 'ChatGPT', keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-6.1-sol', baseEnv: 'OPENAI_BASE_URL', defaultBase: 'https://api.openai.com/v1',
  }, env, fetchImpl);
}

// Grok — xAI (design §3.4), OpenAI-compatible, default model grok-4.3.
function grokAdapter(env, fetchImpl) {
  return chatCompletionsAdapter({
    member: 'Grok', keyEnv: 'XAI_API_KEY', modelEnv: 'XAI_MODEL',
    defaultModel: 'grok-4.3', baseEnv: 'XAI_BASE_URL', defaultBase: 'https://api.x.ai/v1',
  }, env, fetchImpl);
}

// Perplexity — Sonar API (design §3.6), OpenAI-shaped chat
// completions, default model sonar (low search context).
function perplexityAdapter(env, fetchImpl) {
  return chatCompletionsAdapter({
    member: 'Perplexity', keyEnv: 'PERPLEXITY_API_KEY', modelEnv: 'PERPLEXITY_MODEL',
    defaultModel: 'sonar', baseEnv: 'PERPLEXITY_BASE_URL', defaultBase: 'https://api.perplexity.ai',
  }, env, fetchImpl);
}

// Muse — Meta Model API (design §3.7), chat completions shape,
// default model muse-spark-1.3 (standard tier only — the contributor
// tier trains on prompts and is never called, per the design).
function museAdapter(env, fetchImpl) {
  return chatCompletionsAdapter({
    member: 'Muse', keyEnv: 'META_MODEL_API_KEY', modelEnv: 'MUSE_MODEL',
    defaultModel: 'muse-spark-1.3', baseEnv: 'META_MODEL_BASE_URL', defaultBase: 'https://api.meta.ai/v1',
  }, env, fetchImpl);
}

// Claude — Anthropic Messages format (design §3.3): the one member
// that does NOT speak chat completions. Key travels as the x-api-key
// header; the system prompt is a top-level field; the answer is the
// text blocks of the content array; usage is input/output tokens.
function claudeAdapter(env, fetchImpl) {
  const key = env.ANTHROPIC_API_KEY || '';
  const model = env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  const base = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  return {
    member: 'Claude',
    model,
    configured: !!key,
    async call({ system, user, maxTokens }) {
      if (!key) throw new MemberError('NO_KEY', 'Claude is not configured on the server (no API key set)');
      let res;
      try {
        res = await fetchWithTimeout(fetchImpl, `${base}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system,
            messages: [{ role: 'user', content: user }],
          }),
        }, HTTP_TIMEOUT_MS);
      } catch (e) {
        throw new MemberError('NETWORK', `Claude call failed: ${cleanErrorText(e.message, key)}`);
      }
      const raw = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new MemberError('BAD_KEY', `Claude rejected the server API key (HTTP ${res.status})`);
      }
      if (res.status === 402) {
        throw new MemberError('NO_BALANCE', 'Claude reports no prepaid balance on the server account (HTTP 402)');
      }
      if (!res.ok) {
        throw new MemberError(`HTTP_${res.status}`, `Claude returned HTTP ${res.status}: ${cleanErrorText(raw, key)}`);
      }
      let data;
      try { data = JSON.parse(raw); } catch { throw new MemberError('BAD_RESPONSE', 'Claude returned a response that was not JSON'); }
      const blocks = (data && Array.isArray(data.content)) ? data.content : [];
      const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('').trim();
      if (!text) throw new MemberError('EMPTY', 'Claude returned an empty answer');
      return {
        text,
        model: data.model || model,
        promptTokens: data.usage ? (data.usage.input_tokens ?? null) : null,
        completionTokens: data.usage ? (data.usage.output_tokens ?? null) : null,
      };
    },
  };
}

function buildAdapters(env, fetchImpl) {
  const map = new Map();
  for (const make of [museAdapter, chatgptAdapter, claudeAdapter, geminiAdapter,
    perplexityAdapter, grokAdapter, deepseekAdapter]) {
    const a = make(env, fetchImpl);
    map.set(a.member, a);
  }
  return map;
}

// Why a member cannot answer right now, in the plain words the result
// carries. state: ready | no_key | no_adapter | no_api.
function memberState(member, adapters) {
  if (NO_API_MEMBERS.has(member)) return { state: 'no_api' };
  const adapter = adapters.get(member);
  if (!adapter) return { state: 'no_adapter' };
  if (!adapter.configured) return { state: 'no_key', adapter };
  return { state: 'ready', adapter };
}
function absenceReason(member, state) {
  switch (state) {
    case 'no_api': return { code: 'NO_API', text: `${member} has no API, so it cannot be reached automatically yet` };
    case 'no_key': return { code: 'NO_KEY', text: `${member} is not configured on the server (no API key set)` };
    default: return { code: 'NO_ADAPTER', text: `${member} is not on the API lane yet` };
  }
}

// One retry on transient failures (network, 429, 5xx), per the design.
// 401/403 (bad key) and 402 (no balance) are never retried.
async function callMember(ctx, adapter, args) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await adapter.call(args);
    } catch (e) {
      lastErr = e;
      const transient = e.code === 'NETWORK' || /^HTTP_(429|5\d\d)$/.test(e.code || '');
      if (!transient || attempt === 1) throw e;
      if (ctx.retryDelayMs) await new Promise((r) => setTimeout(r, ctx.retryDelayMs));
    }
  }
  throw lastErr;
}

async function recordHop(cmd, run, member, model, status, errorCode, out, lane) {
  return db.insert('ai_runs', {
    command_id: cmd.id,
    member,
    model: model || null,
    status,
    error: errorCode || null,
    lane: lane || 'api',
    prompt_tokens: out ? out.promptTokens : null,
    completion_tokens: out ? out.completionTokens : null,
    cost_microusd: out ? costMicroUsd(member, out.promptTokens, out.completionTokens) : null,
    started_at: run.startedAt,
    finished_at: db.now(),
  });
}

// ── Copilot phone-lane bridge (owner order 2026-10-22) ────────────
// Copilot has no API (design §3.8), so it joins the team through a
// pipeline that already exists: the button's device lane. When an
// API-lane command needs Copilot, the worker spawns a linked
// device-lane CHILD command (parent_id = the API command's id,
// migration 099) carrying a plain "Have Copilot ..." instruction
// the phone's executor already knows how to run. The parent's
// Copilot block says honestly that Copilot was asked through the
// phone; when the phone posts the child's result,
// finalizeCopilotHop swaps the real answer into the parent's
// record labeled "via phone". A child that fails on the phone
// shows that failure as the outcome — honest either way, and no
// answer is ever faked.
const COPILOT_PENDING_TEXT = 'asked through the phone — Copilot has no API, so it answers through the app on the phone; its reply lands in the log when the phone picks it up';
const COPILOT_VIA_PHONE_LABEL = 'via phone — answered through the Copilot app on the phone';

function copilotPendingBlock() {
  return envelope('Copilot', `(${COPILOT_PENDING_TEXT})`);
}

// The parent's Copilot block, rendered from the child's state:
// done = the real reply under a via-phone label; failed = the
// on-phone failure, named; anything else = still out with the
// phone, stated plainly.
function copilotChildBlock(child) {
  if (child && child.status === 'done') {
    const text = String(child.answer || '').trim();
    return envelope('Copilot', `(${COPILOT_VIA_PHONE_LABEL})\n${text || '(the phone posted an empty answer)'}`);
  }
  if (child && child.status === 'failed') {
    const why = String(child.answer || '').trim() || 'no answer was posted';
    return envelope('Copilot', `(via phone — Copilot could not answer on the phone: ${why})`);
  }
  return copilotPendingBlock();
}

async function findCopilotChild(parentId) {
  return db.get(
    'SELECT * FROM ai_commands WHERE parent_id = ? ORDER BY created_at ASC LIMIT 1',
    [parentId]
  );
}

// Create the phone child for a parent command, or return the one
// an earlier execution already spawned — a command id delegates at
// most one child, however many times it is (re-)executed.
async function ensureCopilotChild(parentCmd, childText) {
  const existing = await findCopilotChild(parentCmd.id);
  if (existing) return existing;
  const id = crypto.randomUUID();
  await db.insert('ai_commands', {
    id,
    device_id: parentCmd.device_id,
    text: String(childText || '').slice(0, 2000),
    status: 'queued',
    answer: null,
    created_at: db.now(),
    delivered_at: null,
    completed_at: null,
    origin: parentCmd.origin || 'hq',
    lane: 'device',
    claimed_by: null,
    claimed_at: null,
    attempts: 0,
    parent_id: parentCmd.id,
  });
  return db.get('SELECT * FROM ai_commands WHERE id = ?', [id]);
}

// Spawn (or reuse) the phone child for this command's Copilot hop
// and record the hop in ai_runs on the device lane. Returns
// { child, state } with state 'pending' | 'answered' | 'failed',
// mirroring the child's state at this moment.
async function delegateCopilot(cmd, run, childText) {
  const child = await ensureCopilotChild(cmd, childText);
  let state = 'pending';
  if (child.status === 'done') state = 'answered';
  else if (child.status === 'failed') state = 'failed';
  if (state === 'answered') {
    await recordHop(cmd, run, 'Copilot', null, 'done', null, null, 'device');
  } else if (state === 'failed') {
    await recordHop(cmd, run, 'Copilot', null, 'failed', 'PHONE_FAILED', null, 'device');
  } else {
    await recordHop(cmd, run, 'Copilot', null, 'delegated', null, null, 'device');
  }
  return { child, state };
}

const COPILOT_BLOCK_RE = /\[FROM Copilot\]\n[\s\S]*?\n\[END\]/;

// Fold a finished phone child's outcome into the parent command's
// answer text (replacing the pending Copilot block, or appending
// the block when the text has none) and settle the delegated
// ai_runs hop. Idempotent: once the child is final, re-running
// changes nothing. Called by the worker just before it writes the
// parent's result (a fast phone may have answered mid-execution)
// and by the device result route when a child posts after the
// parent already completed. Returns { answer, changed, child }.
async function finalizeCopilotHop(parentId, answerText) {
  const child = await findCopilotChild(parentId);
  const base = String(answerText || '');
  if (!child || (child.status !== 'done' && child.status !== 'failed')) {
    return { answer: base, changed: false, child: child || null };
  }
  const block = copilotChildBlock(child);
  let next;
  if (COPILOT_BLOCK_RE.test(base)) {
    next = base.replace(COPILOT_BLOCK_RE, block);
  } else if (base) {
    next = `${base}\n\n${block}`;
  } else {
    next = block;
  }
  next = next.slice(0, ANSWER_CAP);
  const hopStatus = child.status === 'done' ? 'done' : 'failed';
  const hopError = child.status === 'done' ? null : 'PHONE_FAILED';
  const delegated = await db.get(
    "SELECT id FROM ai_runs WHERE command_id = ? AND member = 'Copilot' AND lane = 'device' AND status = 'delegated' ORDER BY started_at ASC LIMIT 1",
    [parentId]
  );
  if (delegated) {
    await db.update('ai_runs', delegated.id, {
      status: hopStatus, error: hopError, finished_at: db.now(),
    });
  } else {
    const settled = await db.get(
      "SELECT id FROM ai_runs WHERE command_id = ? AND member = 'Copilot' AND lane = 'device' LIMIT 1",
      [parentId]
    );
    if (!settled) {
      await db.insert('ai_runs', {
        command_id: parentId, member: 'Copilot', model: null,
        status: hopStatus, error: hopError, lane: 'device',
        prompt_tokens: null, completion_tokens: null, cost_microusd: null,
        started_at: child.created_at || db.now(), finished_at: db.now(),
      });
    }
  }
  return { answer: next, changed: next !== base, child };
}

// ── Execution ───────────────────────────────────────────────────────

async function executeRoute(cmd, parsed, ctx, run) {
  if (parsed.member === 'Copilot') {
    // No API (design §3.8): Copilot is asked through the phone
    // (owner order 2026-10-22). The child carries this command's
    // own text — the phone's executor parses "Have Copilot ..."
    // exactly like a command the owner queued himself. A child
    // already final (a re-run after the phone answered) speaks
    // for itself in the block.
    const { child, state } = await delegateCopilot(cmd, run, cmd.text);
    return {
      status: state === 'failed' ? 'failed' : 'done',
      answer: copilotChildBlock(child),
    };
  }
  const st = memberState(parsed.member, ctx.adapters);
  if (st.state !== 'ready') {
    const reason = absenceReason(parsed.member, st.state);
    await recordHop(cmd, run, parsed.member, null, 'skipped', reason.code, null);
    return { status: 'failed', answer: absenceBlock(parsed.member, reason.text) };
  }
  try {
    const out = await callMember(ctx, st.adapter, { system: PRIMER, user: parsed.task, maxTokens: 800 });
    await recordHop(cmd, run, parsed.member, out.model, 'done', null, out);
    return { status: 'done', answer: envelope(parsed.member, out.text) };
  } catch (e) {
    await recordHop(cmd, run, parsed.member, null, 'failed', e.code || 'ERROR', null);
    return { status: 'failed', answer: absenceBlock(parsed.member, e.message) };
  }
}

async function executeHelloLoop(cmd, ctx, run) {
  const blocks = [];
  const logBlocks = []; // successful hops only — what later hops read
  let answered = 0;
  let configuredFailed = 0; // had an adapter + key, but the call errored
  let notConfigured = 0; // skipped: no adapter yet, or no key
  let phonePending = 0; // Copilot: asked through the phone, reply lands later
  let phoneFailed = 0; // Copilot: the phone leg already reported a failure
  for (let i = 0; i < ROSTER.length; i++) {
    const member = ROSTER[i];
    if (member === 'Copilot') {
      // Phone-lane member (owner order 2026-10-22): spawn the
      // linked device child with this hop's greeting as a plain
      // instruction the phone types into Copilot. The block in
      // this round's answer says Copilot was asked through the
      // phone; the real reply is folded into this record when the
      // phone posts it (finalizeCopilotHop).
      let next = null;
      for (let j = i + 1; j < ROSTER.length; j++) {
        if (memberState(ROSTER[j], ctx.adapters).state === 'ready') { next = ROSTER[j]; break; }
      }
      const greeting = next
        ? `say hello to the team and greet ${next} by name — ${next} answers right after you. One or two sentences.`
        : 'say hello to the team and wrap up the greetings. One or two sentences.';
      const logSoFar = logBlocks.length ? `\n\nTeam log so far:\n${logBlocks.join('\n\n')}` : '';
      const { child, state } = await delegateCopilot(cmd, run,
        `Have Copilot ${greeting}${logSoFar}`.slice(0, 1900));
      const block = copilotChildBlock(child);
      blocks.push(block);
      if (state === 'answered') { logBlocks.push(block); answered++; }
      else if (state === 'failed') { phoneFailed++; }
      else { phonePending++; }
      continue;
    }
    const st = memberState(member, ctx.adapters);
    if (st.state !== 'ready') {
      const reason = absenceReason(member, st.state);
      blocks.push(absenceBlock(member, reason.text));
      notConfigured++;
      await recordHop(cmd, run, member, null, 'skipped', reason.code, null);
      continue;
    }
    // The next member that will actually answer after this one, so the
    // greeting names someone real.
    let next = null;
    for (let j = i + 1; j < ROSTER.length; j++) {
      if (memberState(ROSTER[j], ctx.adapters).state === 'ready') { next = ROSTER[j]; break; }
    }
    const user = [
      logBlocks.length ? `Team log so far:\n${logBlocks.join('\n\n')}\n` : '',
      next
        ? `You are ${member}. Say hello to the team and greet ${next} by name — ${next} answers right after you. One or two sentences.`
        : `You are ${member}, the last to answer in this round. Say hello to the team and wrap up the greetings. One or two sentences.`,
    ].join('');
    try {
      const out = await callMember(ctx, st.adapter, { system: PRIMER, user, maxTokens: 150 });
      const block = envelope(member, out.text);
      blocks.push(block);
      logBlocks.push(block);
      answered++;
      await recordHop(cmd, run, member, out.model, 'done', null, out);
    } catch (e) {
      blocks.push(absenceBlock(member, e.message));
      configuredFailed++;
      await recordHop(cmd, run, member, null, 'failed', e.code || 'ERROR', null);
    }
  }
  const answer = blocks.join('\n\n');
  if (!answered) {
    // The summary must say WHY nobody answered, accurately: a member
    // that IS configured but errored (e.g. provider HTTP 503) is not
    // "not configured", and the counts keep the two apart. A
    // Copilot hop still out with the phone is neither: the command
    // completes and says the reply lands when the phone picks it
    // up — the loop record is upgraded in place when it does.
    const bits = [];
    if (configuredFailed) {
      bits.push(`${configuredFailed} configured ${configuredFailed === 1 ? 'member' : 'members'} tried and failed — the reasons are in their blocks above`);
    }
    if (phoneFailed) {
      bits.push('Copilot was asked through the phone but could not answer there');
    }
    if (notConfigured) {
      bits.push(`${notConfigured} ${notConfigured === 1 ? 'member is' : 'members are'} not configured on the API lane yet`);
    }
    const detail = bits.length ? ` — ${bits.join('; ')}` : '';
    if (phonePending) {
      return {
        status: 'done',
        answer: `${answer}\n\nNo member answered over the API this round${detail}. Copilot was asked through the phone; its reply lands in the log when the phone picks it up.`,
      };
    }
    return {
      status: 'failed',
      answer: `${answer}\n\nNo member of the team could answer${detail}.`,
    };
  }
  return { status: 'done', answer };
}

async function executeCommand(cmd, ctx, run) {
  const parsed = parseCommand(cmd.text);
  if (parsed.type === 'route') return executeRoute(cmd, parsed, ctx, run);
  if (parsed.type === 'hello_loop') return executeHelloLoop(cmd, ctx, run);
  return {
    status: 'failed',
    answer: `The API lane cannot run that command yet: "${cmd.text}". The lane runs "Have <AI> ..." requests and the hello loop; the rest of the team grammar lands in later slices.`,
  };
}

// ── Worker ──────────────────────────────────────────────────────────

function createWorker(opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const ctx = {
    env,
    fetchImpl,
    adapters: opts.adapters || buildAdapters(env, fetchImpl),
    retryDelayMs: opts.retryDelayMs !== undefined ? opts.retryDelayMs : 1000,
    workerId: opts.workerId || `api-lane-${crypto.randomBytes(4).toString('hex')}`,
  };

  // Race-safe claim: the conditional UPDATE only lands while the row
  // is still queued, so two workers can never execute the same command.
  async function claimNext() {
    const cand = await db.get(
      "SELECT id FROM ai_commands WHERE lane = 'api' AND status = 'queued' ORDER BY created_at ASC LIMIT 1"
    );
    if (!cand) return null;
    const res = await db.query(
      "UPDATE ai_commands SET status = 'claimed', claimed_by = ?, claimed_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'",
      [ctx.workerId, db.now(), cand.id]
    );
    if (!res.changes) return null; // another claimant won
    return db.get('SELECT * FROM ai_commands WHERE id = ?', [cand.id]);
  }

  // Re-queue claims that never finished (worker crash, deploy restart,
  // hung call). A command out of attempts fails honestly instead of
  // cycling forever.
  async function watchdog(nowMs = db.now()) {
    const cutoff = nowMs - WATCHDOG_MS;
    const stuck = await db.all(
      "SELECT * FROM ai_commands WHERE lane = 'api' AND status IN ('claimed', 'running') AND claimed_at < ?",
      [cutoff]
    );
    for (const cmd of stuck) {
      if ((cmd.attempts || 0) >= MAX_ATTEMPTS) {
        await db.query(
          "UPDATE ai_commands SET status = 'failed', completed_at = ?, answer = ? WHERE id = ? AND status IN ('claimed', 'running')",
          [nowMs, `This command was interrupted ${cmd.attempts} times and never finished, so it has been marked failed instead of sitting in limbo.`, cmd.id]
        );
      } else {
        await db.query(
          "UPDATE ai_commands SET status = 'queued', claimed_by = NULL, claimed_at = NULL WHERE id = ? AND status IN ('claimed', 'running')",
          [cmd.id]
        );
      }
    }
    return stuck.length;
  }

  async function processOne() {
    const cmd = await claimNext();
    if (!cmd) return false;
    await db.update('ai_commands', cmd.id, { status: 'running' });
    const run = { startedAt: db.now() };
    const rootRunId = await db.insert('ai_runs', {
      command_id: cmd.id, member: null, model: null, status: 'running',
      error: null, prompt_tokens: null, completion_tokens: null, cost_microusd: null,
      started_at: run.startedAt, finished_at: null,
    });
    try {
      const result = await executeCommand(cmd, ctx, run);
      // A Copilot phone child may have posted its result while
      // this command executed (or before a re-run): fold the real
      // answer into the record before it is written, so a pending
      // block never overwrites a reply that already landed.
      const fin = await finalizeCopilotHop(cmd.id, result.answer);
      result.answer = fin.answer;
      await db.update('ai_commands', cmd.id, {
        status: result.status,
        answer: String(result.answer || '').slice(0, ANSWER_CAP),
        completed_at: db.now(),
      });
      await db.update('ai_runs', rootRunId, { status: result.status, finished_at: db.now() });
    } catch (e) {
      // A crash outside a member call (bug, DB hiccup) must not vanish
      // the command: leave the row running and let the watchdog
      // re-queue or fail it honestly.
      await db.update('ai_runs', rootRunId, {
        status: 'failed', error: cleanErrorText(e.message), finished_at: db.now(),
      }).catch(() => {});
      console.error('[api-lane] command execution crashed:', cmd.id, e.message);
    }
    return true;
  }

  async function drain() {
    let n = 0;
    while (await processOne()) n++;
    return n;
  }

  async function tick() {
    await watchdog();
    return drain();
  }

  return { ctx, claimNext, watchdog, processOne, drain, tick };
}

// The poll loop runs only in the live service: never under the test
// harness (NODE_ENV=test), and killable via API_LANE_ENABLED=false.
function laneEnabled(env = process.env) {
  if (env.NODE_ENV === 'test') return false;
  const v = String(env.API_LANE_ENABLED || '').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

let singleton = null;
let timer = null;
function start(opts = {}) {
  if (timer) return singleton;
  singleton = createWorker(opts);
  const pollMs = opts.pollMs || POLL_MS;
  timer = setInterval(() => {
    singleton.tick().catch((e) => console.error('[api-lane] tick failed:', e.message));
  }, pollMs);
  if (timer.unref) timer.unref();
  singleton.tick().catch((e) => console.error('[api-lane] initial tick failed:', e.message));
  console.log(`[api-lane] worker started (poll ${pollMs}ms)`);
  return singleton;
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  singleton = null;
}

module.exports = {
  ROSTER, ALIASES, PRICES, PRIMER, MemberError,
  resolveMember, parseCommand, envelope, absenceBlock, costMicroUsd,
  buildAdapters, memberState, absenceReason,
  COPILOT_PENDING_TEXT, copilotPendingBlock, copilotChildBlock,
  findCopilotChild, ensureCopilotChild, delegateCopilot, finalizeCopilotHop,
  createWorker, laneEnabled, start, stop,
  POLL_MS, WATCHDOG_MS, MAX_ATTEMPTS,
};
