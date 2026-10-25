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
// Muse (slice 2); the full team grammar — SHARE, CONTINUE WITH,
// CHECK THAT, BROADCAST, COMPARE ANSWERS, READ THE LOG, SUMMARIZE
// THE LOOP, WORD LOOP — plus ROUTE failover (slice 3); and the
// phone-lane fallback for every member when no API member can
// answer a route (slice 3.5, owner redundancy order); and the
// LESSER TABLE (2026-10-23, owner order): five secondary providers
// — Groq, OpenRouter, Cloudflare, NVIDIA, Mistral — seated under
// their OWN names as understudy members, reachable by direct ask
// ("Have Groq ...") only. They are NOT in ROSTER: the hello loop,
// broadcast, word loop, summarizer pick, and primary ROUTE
// failover keep their exact slice 1–3.5 behavior, and a lesser
// seat never substitutes for a primary (labeling law, below).
// Members
// without an adapter yet or without a configured key are named in
// the result with the reason — never silently skipped. Copilot has no API at all (design §3.8), so it
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
// Per-call provider timeout. 120s: a non-streaming generateContent call
// returns nothing until generation finishes, and a long briefing prompt
// under provider load can run past 60s — at 60s our own AbortController
// killed Gemini's answer to the owner's 2026-10-25 table briefing twice
// ("This operation was aborted", runs of ~60s + 1s retry delay + ~60s).
// Budget check: worst case one member hop = 2 attempts x 120s + 1s
// retry delay = 241s, still inside the 5-minute claim watchdog above.
const HTTP_TIMEOUT_MS = 120000;
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
  // Lesser table (secondary providers, seated 2026-10-23). NOTE:
  // "groq" (GroqCloud) and "grok" (xAI) are DIFFERENT members —
  // the tokenizer matches whole words, so the two never collide.
  groq: 'Groq',
  openrouter: 'OpenRouter', 'open router': 'OpenRouter',
  cloudflare: 'Cloudflare', 'workers ai': 'Cloudflare',
  nvidia: 'NVIDIA', nim: 'NVIDIA',
  mistral: 'Mistral',
};
// The lesser table: secondary providers seated as understudy
// members under their own names (owner order 2026-10-23, from the
// secondary-AI research of 2026-10-22). LABELING LAW: a lesser
// seat answers ONLY as itself — its blocks carry its own name,
// its primer names it as an understudy, and it is never dressed
// up as, swapped in for, or failed over to/from a primary. A
// direct ask to a lesser seat settles with that seat's answer or
// that seat's honest absence block — exactly like a named SHARE
// target, there is no substitute. Lesser seats are deliberately
// absent from ROSTER, so no multi-member command and no primary
// failover path can reach them.
const LESSER_ROSTER = ['Groq', 'OpenRouter', 'Cloudflare', 'NVIDIA', 'Mistral'];
const LESSER_MEMBERS = new Set(LESSER_ROSTER);
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
  // Lesser table: the seats run on free tiers today (hard stop at
  // zero), so these are the providers' published PAY rates from
  // the 2026-10-22 research, carried only so ai_runs estimates
  // stay comparable if a seat ever moves to paid usage.
  // OpenRouter :free models and Cloudflare's neuron-metered free
  // allocation have no per-token rate — no entry, cost stays null.
  Groq: { inPerM: 0.15, outPerM: 0.60 },
  Mistral: { inPerM: 0.15, outPerM: 0.60 },
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

// Grammar (slices 1+3): the settled team grammar from
// ~/workspace/app/ai-bar/CROSS-AI-COMMANDS.md. The v1.7.7 thin
// client forwards Share / Check / Broadcast / Compare / WordLoop /
// ReadLog / Summarize commands VERBATIM, so this parser mirrors the
// button's AiNameRouter.parseCommand token for token: tokens are
// letter/digit words (lowercased) carrying end offsets into the
// original text, so extracted prompts keep the owner's casing.
// Check order matches the button (word loop before hello loop,
// check/broadcast before route) so the same words mean the same
// thing on both sides of the wire.
function tokenize(text) {
  const tokens = [];
  const re = /[A-Za-z0-9]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ word: m[0].toLowerCase(), end: m.index + m[0].length });
  }
  return tokens;
}
function wordAt(tokens, pos, word) {
  return pos >= 0 && pos < tokens.length && tokens[pos].word === word;
}
function phraseAt(tokens, pos, phrase) {
  if (pos < 0 || pos + phrase.length > tokens.length) return false;
  for (let i = 0; i < phrase.length; i++) {
    if (tokens[pos + i].word !== phrase[i]) return false;
  }
  return true;
}
// Longest alias starting exactly at pos → { member, words } | null.
function matchAliasAt(tokens, pos) {
  let best = null;
  for (const name of Object.keys(ALIASES)) {
    const words = name.split(' ');
    if (pos + words.length > tokens.length) continue;
    if (best && words.length <= best.words) continue;
    let match = true;
    for (let w = 0; w < words.length; w++) {
      if (tokens[pos + w].word !== words[w]) { match = false; break; }
    }
    if (match) best = { member: ALIASES[name], words: words.length };
  }
  return best;
}
function findAlias(tokens, from) {
  for (let pos = Math.max(0, from); pos < tokens.length; pos++) {
    const hit = matchAliasAt(tokens, pos);
    if (hit) return { member: hit.member, words: hit.words, start: pos };
  }
  return null;
}
// The original text after the first `endPos` tokens, leading
// punctuation stripped (the button strips a leading ", " the same
// way after a member name).
function restAfter(text, tokens, endPos) {
  if (endPos <= 0) return text.trim();
  if (endPos > tokens.length) return '';
  return text.slice(tokens[endPos - 1].end).replace(/^[^A-Za-z0-9]+/, '').trim();
}
function textBefore(text, tokens, startPos) {
  if (startPos <= 0) return '';
  return text.slice(0, tokens[startPos - 1].end).replace(/[\s:;,—-]+$/, '').trim();
}
function skipWords(tokens, pos, words) {
  let p = pos;
  while (p < tokens.length && words.includes(tokens[p].word)) p++;
  return p;
}

const WORD_LOOP_PHRASES = [
  ['run', 'the', 'word', 'loop'], ['ran', 'the', 'word', 'loop'],
  ['running', 'the', 'word', 'loop'], ['start', 'the', 'word', 'loop'],
  ['do', 'the', 'word', 'loop'], ['run', 'word', 'loop'],
  ['ran', 'word', 'loop'], ['word', 'loop'],
  ['run', 'the', 'word', 'chain'], ['ran', 'the', 'word', 'chain'],
  ['run', 'word', 'chain'], ['word', 'chain'],
];
const HELLO_LOOP_PHRASES = [
  ['hello', 'loop'], ['run', 'the', 'loop'], ['run', 'the', 'hello', 'loop'],
  ['run', 'loop'], ['start', 'the', 'loop'], ['do', 'the', 'loop'],
  ['do', 'the', 'hello', 'loop'], ['ran', 'the', 'loop'],
  ['ran', 'the', 'hello', 'loop'], ['ran', 'loop'],
  ['running', 'the', 'loop'], ['running', 'the', 'hello', 'loop'],
  ['start', 'loop'], ['the', 'loop'], ['loop'],
];
const BROADCAST_PHRASES = [
  ['brainstorm', 'across', 'all', 'ai'], ['brainstorm', 'across', 'all', 'ais'],
  ['brainstorm', 'across', 'all', 'the', 'ais'], ['ask', 'all', 'ais'],
  ['ask', 'all', 'ai'], ['ask', 'all', 'the', 'ais'], ['ask', 'all', 'the', 'ai'],
  ['ask', 'every', 'ai'], ['brainstorm', 'with', 'all', 'ai'],
  ['brainstorm', 'with', 'all', 'ais'], ['brainstorm', 'with', 'all'],
  ['brainstorm', 'all', 'ai'], ['brainstorm', 'all'],
];

const ROUTE_VERB = /^(?:please\s+)?(?:have|ask|tell)\s+/i;
function parseCommand(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return { type: 'unsupported' };
  const tokens = tokenize(text);
  if (!tokens.length) return { type: 'unsupported' };
  const first = tokens[0].word;

  // WORD LOOP — checked before the hello loop, as on the button.
  for (const p of WORD_LOOP_PHRASES) if (phraseAt(tokens, 0, p)) return { type: 'word_loop' };

  // HELLO LOOP.
  for (const p of HELLO_LOOP_PHRASES) if (phraseAt(tokens, 0, p)) return { type: 'hello_loop' };

  // READ THE LOG.
  if (phraseAt(tokens, 0, ['read', 'the', 'log'])
      || phraseAt(tokens, 0, ['read', 'the', 'command', 'log'])
      || phraseAt(tokens, 0, ['read', 'me', 'the', 'log'])
      || phraseAt(tokens, 0, ['read', 'log'])) {
    return { type: 'read_log' };
  }

  // SUMMARIZE THE LOOP.
  if ((first === 'summarize' || first === 'summarise')
      && (tokens.length === 1
        || ['the', 'loop', 'log', 'answers', 'all', 'that', 'it'].includes(tokens[1].word))) {
    return { type: 'summarize' };
  }

  // COMPARE ANSWERS (optional prompt; no prompt = compare the log).
  if (first === 'compare'
      && (tokens.length === 1
        || ['answers', 'answer', 'the', 'all'].includes(tokens[1].word))) {
    let consumed = skipWords(tokens, 1, ['answers', 'answer', 'the', 'all']);
    consumed = skipWords(tokens, consumed, ['on', 'about', 'for']);
    return { type: 'compare', prompt: restAfter(text, tokens, consumed) };
  }

  // BROADCAST — the verb form, then the button's phrase forms
  // searched anywhere in the text ("ask all AIs: ..." / "... — ask
  // all AIs"). The prompt is what follows the phrase, or what
  // precedes it when nothing follows.
  if (first === 'broadcast') {
    return { type: 'broadcast', prompt: restAfter(text, tokens, 1) };
  }
  for (const phrase of BROADCAST_PHRASES) {
    for (let pos = 0; pos + phrase.length <= tokens.length; pos++) {
      if (!phraseAt(tokens, pos, phrase)) continue;
      let prompt = restAfter(text, tokens, pos + phrase.length);
      if (!prompt) prompt = textBefore(text, tokens, pos);
      return { type: 'broadcast', prompt };
    }
  }

  // CHECK THAT — "Have <AI> check ...", "<AI> check ...", or the
  // bare "check that/this/it" (the OTHER members critique).
  if (first === 'have' || first === 'get' || first === 'ask') {
    const hit = findAlias(tokens, 1);
    if (hit) {
      const after = skipWords(tokens, hit.start + hit.words, ['to']);
      if (wordAt(tokens, after, 'check')) return { type: 'check', member: hit.member };
    }
  }
  {
    const lead = matchAliasAt(tokens, 0);
    if (lead && wordAt(tokens, lead.words, 'check')) return { type: 'check', member: lead.member };
  }
  if (phraseAt(tokens, 0, ['check', 'that']) || phraseAt(tokens, 0, ['check', 'this'])
      || phraseAt(tokens, 0, ['check', 'it'])) {
    return { type: 'check', member: null };
  }

  // CONTINUE WITH <AI> (optionally followed by the follow-up).
  if (phraseAt(tokens, 0, ['continue', 'with']) || phraseAt(tokens, 0, ['carry', 'on', 'with'])) {
    const from = phraseAt(tokens, 0, ['continue', 'with']) ? 2 : 3;
    const hit = findAlias(tokens, from);
    if (hit) {
      return {
        type: 'continue', member: hit.member,
        followUp: restAfter(text, tokens, hit.start + hit.words),
      };
    }
  }

  // SHARE / SEND TO / PASS IT TO <AI>.
  for (let pos = 0; pos <= 1 && pos < tokens.length; pos++) {
    if (pos === 1 && tokens[0].word !== 'please') break;
    if (!['share', 'send', 'pass'].includes(tokens[pos].word)) continue;
    let p = skipWords(tokens, pos + 1, ['this', 'it']);
    p = skipWords(tokens, p, ['with', 'to']);
    const hit = findAlias(tokens, p);
    if (hit) return { type: 'share', member: hit.member };
  }

  // ROUTE (slices 1-2): "Have/Ask/Tell <AI> <task>".
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

// ── Lesser table adapters (2026-10-23) ──────────────────────────
// All five secondary providers speak the OpenAI chat-completions
// shape (secondary-AI research 2026-10-22), so they ride the same
// chatCompletionsAdapter factory as the slice-2 primaries — same
// Member interface, same error vocabulary, same header-only key
// handling. Each is configured by its own env key; a missing key
// settles as honest NO_KEY through memberState/askMember, exactly
// like an unconfigured primary. Default models are the research
// file's free-tier picks, each overridable by its *_MODEL env.

// Groq (GroqCloud) — OpenAI-compatible at api.groq.com/openai/v1.
// Default free model: gpt-oss-120b (the Llama self-serve SKUs
// moved to Enterprise-only in Aug 2026, per the research).
function groqCloudAdapter(env, fetchImpl) {
  return chatCompletionsAdapter({
    member: 'Groq', keyEnv: 'GROQ_API_KEY', modelEnv: 'GROQ_MODEL',
    defaultModel: 'openai/gpt-oss-120b', baseEnv: 'GROQ_BASE_URL', defaultBase: 'https://api.groq.com/openai/v1',
  }, env, fetchImpl);
}

// OpenRouter — one key, 300+ models at openrouter.ai/api/v1.
// Default: a :free variant (the free roster rotates; :free models
// hard-stop at the daily cap and can never charge).
function openrouterAdapter(env, fetchImpl) {
  return chatCompletionsAdapter({
    member: 'OpenRouter', keyEnv: 'OPENROUTER_API_KEY', modelEnv: 'OPENROUTER_MODEL',
    defaultModel: 'openai/gpt-oss-120b:free', baseEnv: 'OPENROUTER_BASE_URL', defaultBase: 'https://openrouter.ai/api/v1',
  }, env, fetchImpl);
}

// Cloudflare Workers AI — OpenAI-compatible endpoint is per-account:
// /client/v4/accounts/<ACCOUNT_ID>/ai/v1. Configured therefore
// requires BOTH CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID; with
// no account id the key is blanked in the effective env so the
// seat reports honest NO_KEY instead of calling a malformed URL.
function cloudflareAdapter(env, fetchImpl) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || '';
  const effEnv = { ...env };
  if (!accountId) {
    effEnv.CLOUDFLARE_API_KEY = '';
  } else if (!env.CLOUDFLARE_BASE_URL) {
    effEnv.CLOUDFLARE_BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
  }
  return chatCompletionsAdapter({
    member: 'Cloudflare', keyEnv: 'CLOUDFLARE_API_KEY', modelEnv: 'CLOUDFLARE_MODEL',
    defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', baseEnv: 'CLOUDFLARE_BASE_URL',
    defaultBase: 'https://api.cloudflare.com/client/v4/accounts//ai/v1',
  }, effEnv, fetchImpl);
}

// NVIDIA NIM (build.nvidia.com API catalog) — OpenAI-compatible
// at integrate.api.nvidia.com/v1, nvapi- keys. Default: the
// DeepSeek V4 Flash endpoint the research seats here.
function nvidiaAdapter(env, fetchImpl) {
  return chatCompletionsAdapter({
    member: 'NVIDIA', keyEnv: 'NVIDIA_API_KEY', modelEnv: 'NVIDIA_MODEL',
    defaultModel: 'deepseek-ai/deepseek-v4-flash', baseEnv: 'NVIDIA_BASE_URL', defaultBase: 'https://integrate.api.nvidia.com/v1',
  }, env, fetchImpl);
}

// Mistral (La Plateforme) — OpenAI-compatible in practice at
// api.mistral.ai/v1. Default: Mistral Small (the Experiment free
// tier covers the catalog; Small is the volume pick).
function mistralAdapter(env, fetchImpl) {
  return chatCompletionsAdapter({
    member: 'Mistral', keyEnv: 'MISTRAL_API_KEY', modelEnv: 'MISTRAL_MODEL',
    defaultModel: 'mistral-small-latest', baseEnv: 'MISTRAL_BASE_URL', defaultBase: 'https://api.mistral.ai/v1',
  }, env, fetchImpl);
}

// The system prompt a lesser seat answers under: it names the
// seat as itself — an understudy member of the lesser table — so
// even the model's own self-description can never dress it up as
// a primary (labeling law). The [FROM <name>] envelope is stamped
// by the framework regardless of what the model claims.
function lesserPrimer(member) {
  return [
    `You are ${member}, a member of the AI team's lesser table — a secondary`,
    'provider seated as an understudy alongside the primary team (Muse, ChatGPT,',
    'Claude, Gemini, Copilot, Perplexity, Grok, DeepSeek). You answer as',
    `${member}, under your own name — never claim to be another member, and never`,
    "claim another member's words as your own. Answer the owner's request",
    'directly, in plain language, and keep it concise unless the request asks',
    'for depth. If you cannot do something, say so plainly in one line.',
  ].join('\n');
}

function buildAdapters(env, fetchImpl) {
  const map = new Map();
  for (const make of [museAdapter, chatgptAdapter, claudeAdapter, geminiAdapter,
    perplexityAdapter, grokAdapter, deepseekAdapter,
    groqCloudAdapter, openrouterAdapter, cloudflareAdapter, nvidiaAdapter, mistralAdapter]) {
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

// ── Session context (slice 3) ─────────────────────────────────────
// The "current loop" and "the last answer" the grammar refers to
// live in the persistent command log: the settled API-lane commands
// recorded for the SAME device as the running command (the panel's
// log and the HQ log are per-device records). Context handed to a
// member is capped at the shared team log cap the button enforces
// (CrossAiProtocol MAX_LOG_CHARS, 16,000 chars) — newest entries
// win the budget, and the cut is stated, never silent.
const LOG_CONTEXT_CAP = 16000;
const SESSION_COMMAND_LIMIT = 8;
const SHARED_ANSWER_CAP = 6000;

async function recentSettledCommands(cmd, limit = SESSION_COMMAND_LIMIT) {
  return db.all(
    "SELECT * FROM ai_commands WHERE device_id = ? AND lane = 'api' AND id != ?"
      + " AND status IN ('done', 'failed') ORDER BY created_at DESC LIMIT ?",
    [cmd.device_id, cmd.id, limit]
  );
}

// Settled rows (newest first, as fetched) → chronological log
// entries, "Owner: <command>" followed by the recorded answer.
function sessionEntries(rowsNewestFirst) {
  return rowsNewestFirst.slice().reverse().map((r) =>
    `Owner: ${r.text}\n${String(r.answer || '').trim()}`);
}

// Join chronological entries under the cap; when older entries are
// dropped the text says so.
function buildLogText(entries, cap = LOG_CONTEXT_CAP) {
  const kept = [];
  let total = 0;
  let omitted = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const cost = entries[i].length + (kept.length ? 2 : 0);
    if (kept.length > 0 && total + cost > cap) { omitted = i + 1; break; }
    kept.unshift(entries[i]);
    total += cost;
  }
  if (!kept.length && entries.length) {
    kept.push(entries[entries.length - 1]);
    omitted = entries.length - 1;
  }
  let text = kept.join('\n\n');
  if (text.length > cap) text = `${text.slice(0, cap)}\n…(trimmed to the log cap)`;
  if (omitted > 0) {
    text = `(${omitted} earlier ${omitted === 1 ? 'entry' : 'entries'} omitted — the shared team log is capped)\n\n${text}`;
  }
  return text;
}

async function lastExchange(cmd) {
  const rows = await recentSettledCommands(cmd, 1);
  return rows[0] || null;
}

// Which members actually ANSWERED in a recorded answer — real
// [FROM X] blocks. Absence blocks ("(not answered — ...)") and a
// Copilot block still waiting on the phone are not authorship; a
// via-phone Copilot answer is.
const FROM_BLOCK_RE = /\[FROM ([^\]]+)\]\n([\s\S]*?)\n\[END\]/g;
function answerAuthors(answer) {
  const authors = new Set();
  const re = new RegExp(FROM_BLOCK_RE.source, 'g');
  let m;
  while ((m = re.exec(String(answer || ''))) !== null) {
    const body = m[2].trim();
    if (body.startsWith('(not answered')) continue;
    if (body.startsWith('(asked through the phone')) continue;
    authors.add(m[1]);
  }
  return authors;
}

// One configured-member call with the lane's bookkeeping. Copilot
// is NOT handled here — it goes through the phone bridge
// (delegateCopilot). Returns { ok, configured, text | reasonText }.
async function askMember(cmd, ctx, run, member, args) {
  const st = memberState(member, ctx.adapters);
  if (st.state !== 'ready') {
    const reason = absenceReason(member, st.state);
    await recordHop(cmd, run, member, null, 'skipped', reason.code, null);
    return { ok: false, configured: false, code: reason.code, reasonText: reason.text };
  }
  try {
    const out = await callMember(ctx, st.adapter, args);
    await recordHop(cmd, run, member, out.model, 'done', null, out);
    return { ok: true, configured: true, text: out.text };
  } catch (e) {
    await recordHop(cmd, run, member, null, 'failed', e.code || 'ERROR', null);
    return { ok: false, configured: true, code: e.code || 'ERROR', reasonText: e.message };
  }
}

// Single-target settlement shared by SHARE / CONTINUE / named
// CHECK: the target's block, via the phone bridge for Copilot, an
// honest absence block (status failed) when it cannot answer. A
// route FAILS OVER instead (see executeRoute) — a share names its
// recipient, so a silent substitute would lie about who got it.
async function answerFromMember(cmd, ctx, run, member, user, copilotText) {
  if (member === 'Copilot') {
    const { child, state } = await delegateCopilot(cmd, run, copilotText);
    return { status: state === 'failed' ? 'failed' : 'done', answer: copilotChildBlock(child) };
  }
  const res = await askMember(cmd, ctx, run, member, { system: PRIMER, user, maxTokens: 800 });
  if (!res.ok) return { status: 'failed', answer: absenceBlock(member, res.reasonText) };
  return { status: 'done', answer: envelope(member, res.text) };
}

// Ask a set of members the same job, sequentially in roster order
// (broadcast is sequential by design), collecting envelope blocks.
// Copilot joins through the phone bridge. userFor(member) builds
// the prompt for API members; copilotText is the child instruction
// the phone executes.
async function askAll(cmd, ctx, run, members, { userFor, copilotText, maxTokens = 800 }) {
  const blocks = [];
  const tally = { answered: 0, configuredFailed: 0, notConfigured: 0, phonePending: 0, phoneFailed: 0 };
  for (const member of members) {
    if (member === 'Copilot') {
      const { child, state } = await delegateCopilot(cmd, run, copilotText);
      blocks.push(copilotChildBlock(child));
      if (state === 'answered') tally.answered++;
      else if (state === 'failed') tally.phoneFailed++;
      else tally.phonePending++;
      continue;
    }
    const res = await askMember(cmd, ctx, run, member, { system: PRIMER, user: userFor(member), maxTokens });
    if (res.ok) {
      blocks.push(envelope(member, res.text));
      tally.answered++;
    } else {
      blocks.push(absenceBlock(member, res.reasonText));
      if (res.configured) tally.configuredFailed++;
      else tally.notConfigured++;
    }
  }
  return { blocks, tally };
}

// Settlement shared by the multi-member commands, mirroring the
// hello loop: done when someone answered; done-with-a-note when
// only the phone hop is still out; failed with the reasons named
// when nobody could answer.
function settleMulti(blocks, tally, subject) {
  const answer = blocks.join('\n\n');
  if (tally.answered > 0) return { status: 'done', answer };
  const bits = [];
  if (tally.configuredFailed) {
    bits.push(`${tally.configuredFailed} configured ${tally.configuredFailed === 1 ? 'member' : 'members'} tried and failed — the reasons are in their blocks above`);
  }
  if (tally.phoneFailed) {
    bits.push('Copilot was asked through the phone but could not answer there');
  }
  if (tally.notConfigured) {
    bits.push(`${tally.notConfigured} ${tally.notConfigured === 1 ? 'member is' : 'members are'} not configured on the API lane yet`);
  }
  const detail = bits.length ? ` — ${bits.join('; ')}` : '';
  if (tally.phonePending) {
    return {
      status: 'done',
      answer: `${answer}\n\nNo member answered over the API for ${subject}${detail}. Copilot was asked through the phone; its reply lands in the log when the phone picks it up.`,
    };
  }
  return { status: 'failed', answer: `${answer}\n\nNo member of the team could answer ${subject}${detail}.` };
}

// Who writes a summary / comparison of the log: the Lead first
// (Muse heads the roster — PRIMER names Muse the Lead AI), then
// roster order. Copilot never does it synchronously (phone bridge).
function pickSummarizer(ctx) {
  for (const member of ROSTER) {
    if (member === 'Copilot') continue;
    if (memberState(member, ctx.adapters).state === 'ready') return member;
  }
  return null;
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

// ── Generalized phone-lane fallback (slice 3.5, owner order
// 2026-10-22: "the pipeline needs redundancy — we should have built
// the new path and kept the functionality of the original
// intact"). Every member is reachable TWO ways: the API lane is
// primary, and the device lane (the phone's pane executor, the
// path that worked all along) is the live fallback whenever the
// API path is unconfigured or errored. The Copilot bridge above is
// the original instance of this pattern — Copilot's ONLY path is
// the phone. The functions below carry the same mechanism for
// every member: a parent may hold one phone child PER MEMBER, and
// the member a child belongs to is read from its instruction
// text, which always opens with the member's name in the
// executor's own grammar ("Have <AI> ...").
function viaPhoneLabel(member) {
  return `via phone — answered through the ${member} app on the phone`;
}
function memberFromChildText(text) {
  const hit = findAlias(tokenize(String(text || '')), 0);
  return hit && hit.start <= 2 ? hit.member : null;
}
async function findChildren(parentId) {
  return db.all(
    'SELECT * FROM ai_commands WHERE parent_id = ? ORDER BY created_at ASC',
    [parentId]
  );
}
async function findMemberChild(parentId, member) {
  const children = await findChildren(parentId);
  return children.find((c) => memberFromChildText(c.text) === member) || null;
}

// The parent's block for a phone-delegated member, rendered from
// the child's state. apiReason — why the API path could not
// answer — is stated in the pending and double-failure blocks so
// the log shows BOTH paths' truth (finalize-time calls pass no
// apiReason; the API hop's outcome lives in ai_runs and was in
// the pending block this one replaces). Copilot has no API path,
// so its blocks keep their original wording (copilotChildBlock).
function memberChildBlock(member, child, apiReason) {
  if (member === 'Copilot') return copilotChildBlock(child);
  if (child && child.status === 'done') {
    const text = String(child.answer || '').trim();
    return envelope(member, `(${viaPhoneLabel(member)})\n${text || '(the phone posted an empty answer)'}`);
  }
  if (child && child.status === 'failed') {
    const why = String(child.answer || '').trim() || 'no answer was posted';
    const apiBit = apiReason
      ? `${apiReason}; the phone was tried too and could not answer: ${why}`
      : `the API path could not answer, and the phone could not answer either: ${why}`;
    return envelope(member, `(not answered — ${apiBit})`);
  }
  const reason = apiReason || `${member} could not be reached over its API`;
  return envelope(member, `(asked through the phone — the API path could not answer: ${reason}. ${member} was asked through the app on the phone instead; its reply lands in the log when the phone picks it up)`);
}

// Create the phone child for a parent command, or return the one
// an earlier execution already spawned — a (command, member)
// pair delegates at most one child, however many times the parent
// is (re-)executed.
async function ensureMemberChild(parentCmd, member, childText) {
  const existing = await findMemberChild(parentCmd.id, member);
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

async function ensureCopilotChild(parentCmd, childText) {
  return ensureMemberChild(parentCmd, 'Copilot', childText);
}

// Spawn (or reuse) the phone child for this command's hop to
// `member` and record the hop in ai_runs on the device lane.
// Returns { child, state } with state 'pending' | 'answered' |
// 'failed', mirroring the child's state at this moment.
async function delegateMember(cmd, run, member, childText) {
  const child = await ensureMemberChild(cmd, member, childText);
  let state = 'pending';
  if (child.status === 'done') state = 'answered';
  else if (child.status === 'failed') state = 'failed';
  if (state === 'answered') {
    await recordHop(cmd, run, member, null, 'done', null, null, 'device');
  } else if (state === 'failed') {
    await recordHop(cmd, run, member, null, 'failed', 'PHONE_FAILED', null, 'device');
  } else {
    await recordHop(cmd, run, member, null, 'delegated', null, null, 'device');
  }
  return { child, state };
}

async function delegateCopilot(cmd, run, childText) {
  return delegateMember(cmd, run, 'Copilot', childText);
}

const COPILOT_BLOCK_RE = /\[FROM Copilot\]\n[\s\S]*?\n\[END\]/;
function memberBlockRe(member) {
  return member === 'Copilot'
    ? COPILOT_BLOCK_RE
    : new RegExp(`\\[FROM ${member}\\]\\n[\\s\\S]*?\\n\\[END\\]`);
}

// Fold a finished phone child's outcome into the parent command's
// answer text (replacing that member's pending block, or
// appending the block when the text has none) and settle the
// delegated ai_runs hop. Idempotent: once the child is final,
// re-running changes nothing. Called by the worker just before it
// writes the parent's result (a fast phone may have answered
// mid-execution) and by the device result route when a child
// posts after the parent already completed. Returns
// { answer, changed, child }.
async function finalizeMemberHop(parentId, member, answerText) {
  const child = await findMemberChild(parentId, member);
  const base = String(answerText || '');
  if (!child || (child.status !== 'done' && child.status !== 'failed')) {
    return { answer: base, changed: false, child: child || null };
  }
  const block = memberChildBlock(member, child);
  const re = memberBlockRe(member);
  const existing = re.exec(base);
  let next;
  if (existing && !existing[0].includes('(asked through the phone')) {
    // The block already carries a final outcome — e.g. a
    // double-failure rendered at execution time WITH the API
    // reason in it. Replacing it with the finalize-time rendering
    // (which has no apiReason) would erase that truth from the
    // log; only a still-pending block gets swapped. The hop
    // settlement below still runs.
    next = base;
  } else if (existing) {
    next = base.replace(re, block);
  } else if (base) {
    next = `${base}\n\n${block}`;
  } else {
    next = block;
  }
  next = next.slice(0, ANSWER_CAP);
  const hopStatus = child.status === 'done' ? 'done' : 'failed';
  const hopError = child.status === 'done' ? null : 'PHONE_FAILED';
  const delegated = await db.get(
    "SELECT id FROM ai_runs WHERE command_id = ? AND member = ? AND lane = 'device' AND status = 'delegated' ORDER BY started_at ASC LIMIT 1",
    [parentId, member]
  );
  if (delegated) {
    await db.update('ai_runs', delegated.id, {
      status: hopStatus, error: hopError, finished_at: db.now(),
    });
  } else {
    const settled = await db.get(
      "SELECT id FROM ai_runs WHERE command_id = ? AND member = ? AND lane = 'device' LIMIT 1",
      [parentId, member]
    );
    if (!settled) {
      await db.insert('ai_runs', {
        command_id: parentId, member, model: null,
        status: hopStatus, error: hopError, lane: 'device',
        prompt_tokens: null, completion_tokens: null, cost_microusd: null,
        started_at: child.created_at || db.now(), finished_at: db.now(),
      });
    }
  }
  return { answer: next, changed: next !== base, child };
}

async function finalizeCopilotHop(parentId, answerText) {
  return finalizeMemberHop(parentId, 'Copilot', answerText);
}

// Fold EVERY finished phone child of a parent (any member) into
// the answer text, in spawn order. The worker runs this just
// before writing a result.
async function finalizeMemberHops(parentId, answerText) {
  const children = await findChildren(parentId);
  let answer = String(answerText || '');
  let changed = false;
  for (const child of children) {
    const member = memberFromChildText(child.text);
    if (!member) continue;
    const fin = await finalizeMemberHop(parentId, member, answer);
    if (fin.changed) { answer = fin.answer; changed = true; }
  }
  return { answer, changed };
}

// ── Execution ───────────────────────────────────────────────────────

async function executeRoute(cmd, parsed, ctx, run) {
  if (LESSER_MEMBERS.has(parsed.member)) {
    // LESSER TABLE direct ask (2026-10-23): the named lesser seat
    // answers itself, under its own name and its understudy
    // primer, or settles failed with its honest absence block.
    // There is NO failover and NO phone fallback here — a lesser
    // seat is not a primary, no primary may silently take its
    // place (labeling law), and the lesser providers have no
    // phone panes. Primary failover below is untouched.
    const member = parsed.member;
    const res = await askMember(cmd, ctx, run, member, {
      system: lesserPrimer(member), user: parsed.task, maxTokens: 800,
    });
    if (!res.ok) return { status: 'failed', answer: absenceBlock(member, res.reasonText) };
    return { status: 'done', answer: envelope(member, res.text) };
  }
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
  // FAILOVER (framework gap review, owner 2026-10-21; slice 3):
  // when the routed member cannot answer — not configured, or its
  // provider errored after the built-in retry — the request moves
  // to the next CONFIGURED member in roster order (wrapping once,
  // Copilot excluded: it answers through the phone, never as a
  // silent substitute). The log names the failover honestly. A
  // direct answer stays exactly one block, as before.
  const target = parsed.member;
  const args = { system: PRIMER, user: parsed.task, maxTokens: 800 };
  const first = await askMember(cmd, ctx, run, target, args);
  if (first.ok) return { status: 'done', answer: envelope(target, first.text) };
  const failures = [{ member: target, reasonText: first.reasonText }];
  let winner = null;
  const idx = ROSTER.indexOf(target);
  for (let k = 1; k < ROSTER.length && !winner; k++) {
    const candidate = ROSTER[(idx + k) % ROSTER.length];
    if (candidate === 'Copilot') continue;
    if (memberState(candidate, ctx.adapters).state !== 'ready') continue;
    const res = await askMember(cmd, ctx, run, candidate, args);
    if (res.ok) winner = { member: candidate, text: res.text };
    else failures.push({ member: candidate, reasonText: res.reasonText });
  }
  if (winner) {
    const blocks = failures.map((f, i) => absenceBlock(f.member,
      i === 0 ? `${f.reasonText} — failed over to ${winner.member}` : f.reasonText));
    blocks.push(envelope(winner.member, winner.text));
    return { status: 'done', answer: blocks.join('\n\n') };
  }
  // PHONE FALLBACK (slice 3.5, owner redundancy order 2026-10-22):
  // no configured API member could take the request, so the
  // TARGET member is asked through the other working path — the
  // phone's pane executor — via a linked device-lane child
  // carrying this command's own text, the same instruction the
  // owner's queued commands use. The target's block states both
  // truths: why the API path could not answer, and that the
  // member was asked through the phone. The other members' API
  // failures stay in the log as their absence blocks, and ai_runs
  // holds both hops (the API attempt and the device delegation).
  // When the phone posts, finalizeMemberHop folds the real reply
  // into this record labeled via phone; a phone that already
  // failed settles the command failed with the double-failure
  // block — a member unanswered on both paths says so.
  const { child, state } = await delegateMember(cmd, run, target, cmd.text);
  const targetBlock = memberChildBlock(target, child, first.reasonText);
  const blocks = failures.map((f) => (f.member === target
    ? targetBlock
    : absenceBlock(f.member, f.reasonText)));
  return { status: state === 'failed' ? 'failed' : 'done', answer: blocks.join('\n\n') };
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

// SHARE / CONTINUE WITH <AI>: the last settled exchange on this
// device is handed to the named member with the owner's framing —
// the shared request, the answer in the log, and (for CONTINUE) the
// follow-up. The receiver's response posts as its block. Naming a
// recipient is the point, so there is no failover here: an
// unreachable recipient settles failed with its honest block.
async function executeShare(cmd, parsed, ctx, run) {
  const last = await lastExchange(cmd);
  if (!last) {
    const verb = parsed.type === 'continue' ? 'continue' : 'share';
    return {
      status: 'failed',
      answer: `There is nothing to ${verb} yet — no earlier answer in this device's team log. Ask the team something first.`,
    };
  }
  const sharedAnswer = String(last.answer || '').trim().slice(0, SHARED_ANSWER_CAP);
  const followUp = (parsed.followUp || '').trim();
  const framing = parsed.type === 'continue'
    ? (followUp
      ? `The owner says: continue this work — ${followUp}`
      : 'The owner says: continue this work from where it stopped — take it further.')
    : 'The owner shared this with you — build on it, react to it, or take it further, as it calls for.';
  const user = [
    `Earlier team work from the log on this device. The request was: "${last.text}"`,
    '',
    'The answer in the log:',
    sharedAnswer,
    '',
    framing,
  ].join('\n');
  return answerFromMember(cmd, ctx, run, parsed.member, user, `Have Copilot ${user}`.slice(0, 1900));
}

// CHECK THAT: peer review of the last answer in the log. Named
// ("Have Claude check that") → that member critiques it. Bare
// ("check that") → the OTHER configured members critique it —
// everyone except whoever actually answered last time (absence
// blocks don't count as authorship). Copilot checks through the
// phone bridge.
async function executeCheck(cmd, parsed, ctx, run) {
  const last = await lastExchange(cmd);
  if (!last) {
    return {
      status: 'failed',
      answer: 'There is nothing to check yet — no earlier answer in this device\'s team log. Ask the team something first.',
    };
  }
  const claim = String(last.answer || '').trim().slice(0, SHARED_ANSWER_CAP);
  const user = [
    'Check the answer below from the team log: verify its claims, flag anything wrong or unsupported, and say plainly whether it holds up. Be specific and concise.',
    '',
    `The request it answered was: "${last.text}"`,
    '',
    'The answer:',
    claim,
  ].join('\n');
  if (parsed.member) {
    return answerFromMember(cmd, ctx, run, parsed.member, user, `Have Copilot ${user}`.slice(0, 1900));
  }
  const authors = answerAuthors(last.answer);
  const checkers = ROSTER.filter((m) => !authors.has(m));
  if (!checkers.length) {
    return {
      status: 'failed',
      answer: 'Every member had a hand in the last answer, so there is nobody left to check it — name a checker instead: "Have <AI> check that".',
    };
  }
  const { blocks, tally } = await askAll(cmd, ctx, run, checkers, {
    userFor: () => user,
    copilotText: `Have Copilot ${user}`.slice(0, 1900),
  });
  return settleMulti(blocks, tally, 'the check');
}

// BROADCAST: the same prompt to every member; each block lands in
// the one log (Copilot through the phone bridge).
async function executeBroadcast(cmd, parsed, ctx, run) {
  const prompt = (parsed.prompt || '').trim();
  if (!prompt) {
    return {
      status: 'failed',
      answer: 'That broadcast named nothing to ask — say it as "Brainstorm across all AI: <your question>" or "Ask all AIs <your question>".',
    };
  }
  const { blocks, tally } = await askAll(cmd, ctx, run, ROSTER, {
    userFor: () => prompt,
    copilotText: `Have Copilot ${prompt}`.slice(0, 1900),
  });
  return settleMulti(blocks, tally, 'the broadcast');
}

// COMPARE ANSWERS: with a prompt, the same question goes to every
// member and the blocks stand side by side — the comparison IS the
// blocks, no forced verdict. Without a prompt, a configured
// member (the Lead first) reads the recent log and compares the
// answers already in it: where they agree, where they differ.
async function executeCompare(cmd, parsed, ctx, run) {
  const prompt = (parsed.prompt || '').trim();
  if (prompt) {
    const { blocks, tally } = await askAll(cmd, ctx, run, ROSTER, {
      userFor: () => prompt,
      copilotText: `Have Copilot ${prompt}`.slice(0, 1900),
    });
    return settleMulti(blocks, tally, 'the comparison');
  }
  const rows = await recentSettledCommands(cmd);
  if (!rows.length) {
    return {
      status: 'failed',
      answer: 'There is nothing to compare yet — no earlier answers in this device\'s team log. Ask the team something first, or name the question: "Compare answers on <question>".',
    };
  }
  const comparator = pickSummarizer(ctx);
  if (!comparator) {
    return {
      status: 'failed',
      answer: 'No member is configured on the server to compare the log yet — the Lead (Muse) is not configured, and no other member is either.',
    };
  }
  const logText = buildLogText(sessionEntries(rows), SHARED_ANSWER_CAP);
  const res = await askMember(cmd, ctx, run, comparator, {
    system: PRIMER,
    maxTokens: 800,
    user: `Here is the team's recent log on this device:\n\n${logText}\n\nCompare the answers in it: where do the members agree, where do they differ, and which answer looks strongest? Be specific and concise.`,
  });
  if (!res.ok) return { status: 'failed', answer: absenceBlock(comparator, res.reasonText) };
  return { status: 'done', answer: envelope(comparator, res.text) };
}

// READ THE LOG: the persistent command log IS the answer — the
// settled commands on this device, oldest first, each with its
// recorded answer. No member is called; nothing is summarized or
// reworded. The 16k shared-log cap applies (newest entries win).
async function executeReadLog(cmd, ctx, run) {
  const rows = await recentSettledCommands(cmd, 10);
  if (!rows.length) {
    return {
      status: 'done',
      answer: 'The team log is empty — no commands have completed on this device yet.',
    };
  }
  return { status: 'done', answer: buildLogText(sessionEntries(rows), ANSWER_CAP - 200) };
}

// SUMMARIZE THE LOOP: the current log goes to a configured member
// (the Lead first) and its summary posts as that member's block.
async function executeSummarize(cmd, ctx, run) {
  const rows = await recentSettledCommands(cmd);
  if (!rows.length) {
    return {
      status: 'failed',
      answer: 'There is nothing to summarize yet — the team log on this device is empty. Run a command or two first.',
    };
  }
  const summarizer = pickSummarizer(ctx);
  if (!summarizer) {
    return {
      status: 'failed',
      answer: 'No member is configured on the server to write the summary yet — the Lead (Muse) is not configured, and no other member is either.',
    };
  }
  const logText = buildLogText(sessionEntries(rows), SHARED_ANSWER_CAP);
  const res = await askMember(cmd, ctx, run, summarizer, {
    system: PRIMER,
    maxTokens: 800,
    user: `Here is the team's recent log on this device:\n\n${logText}\n\nSummarize the loop: what was asked, what the team answered, where members agreed or differed, and anything still open. Concise, plain language.`,
  });
  if (!res.ok) return { status: 'failed', answer: absenceBlock(summarizer, res.reasonText) };
  return { status: 'done', answer: envelope(summarizer, res.text) };
}

// WORD LOOP (Loop 2, owner design): the sentence starts as "Hello"
// and passes member to member in roster order; each member adds
// EXACTLY ONE word and returns the full sentence, never altering
// earlier words. Each hop's block names the word it added and the
// sentence so far, so the final word count names any hop that
// failed to add (the owner's fidelity check). Copilot takes its
// turn through the phone bridge — the sentence it receives is the
// one standing at its turn; its word folds into this record when
// the phone posts it, and the members after it continue from the
// sentence as it stands (stated in the closing line).
const WORD_LOOP_START = 'Hello';
function cleanAddedWord(raw) {
  return String(raw || '').trim().replace(/^[^A-Za-z0-9'-]+/, '').replace(/[^A-Za-z0-9'-]+$/, '');
}
function extractAddedWord(sentence, reply) {
  const norm = String(reply || '').replace(/\s+/g, ' ').trim().replace(/^["“”]+|["“”]+$/g, '');
  if (!norm) return { kind: 'none' };
  if (norm.toLowerCase().startsWith(sentence.toLowerCase())) {
    const extra = norm.slice(sentence.length).trim();
    if (!extra) return { kind: 'none' };
    const w = cleanAddedWord(extra.split(/\s+/)[0]);
    return w ? { kind: 'word', word: w } : { kind: 'none' };
  }
  const words = norm.split(/\s+/);
  if (words.length === 1) {
    const w = cleanAddedWord(words[0]);
    return w ? { kind: 'word', word: w } : { kind: 'none' };
  }
  return { kind: 'fidelity', snippet: norm.slice(0, 120) };
}

async function executeWordLoop(cmd, ctx, run) {
  let sentence = WORD_LOOP_START;
  const blocks = [];
  const tally = { answered: 0, configuredFailed: 0, notConfigured: 0, phonePending: 0, phoneFailed: 0 };
  let wordsAdded = 0;
  for (const member of ROSTER) {
    if (member === 'Copilot') {
      const childText = `Have Copilot continue a word loop. The sentence so far is: "${sentence}". Add exactly ONE word to continue it and reply with ONLY the full sentence — the sentence above plus your one new word at the end. Do not change any earlier word.`;
      const { child, state } = await delegateCopilot(cmd, run, childText);
      blocks.push(copilotChildBlock(child));
      if (state === 'answered') tally.answered++;
      else if (state === 'failed') tally.phoneFailed++;
      else tally.phonePending++;
      continue;
    }
    const st = memberState(member, ctx.adapters);
    if (st.state !== 'ready') {
      const reason = absenceReason(member, st.state);
      blocks.push(absenceBlock(member, reason.text));
      tally.notConfigured++;
      await recordHop(cmd, run, member, null, 'skipped', reason.code, null);
      continue;
    }
    const user = `We are building one sentence together as a team, one word per member. The sentence so far is: "${sentence}". Add exactly ONE word to continue it. Reply with ONLY the full sentence — the sentence above plus your one new word at the end. Do not change, reorder, or drop any earlier word.`;
    try {
      const out = await callMember(ctx, st.adapter, { system: PRIMER, user, maxTokens: 60 });
      const ex = extractAddedWord(sentence, out.text);
      if (ex.kind === 'word') {
        sentence = `${sentence} ${ex.word}`;
        wordsAdded++;
        tally.answered++;
        blocks.push(envelope(member, `added the word "${ex.word}" — the sentence is now: "${sentence}"`));
        await recordHop(cmd, run, member, out.model, 'done', null, out);
      } else if (ex.kind === 'none') {
        tally.configuredFailed++;
        blocks.push(envelope(member, '(added no word — it returned the sentence unchanged)'));
        await recordHop(cmd, run, member, null, 'failed', 'NO_WORD', null);
      } else {
        tally.configuredFailed++;
        blocks.push(envelope(member, `(did not continue the sentence — it replied: "${ex.snippet}")`));
        await recordHop(cmd, run, member, null, 'failed', 'FIDELITY', null);
      }
    } catch (e) {
      blocks.push(absenceBlock(member, e.message));
      tally.configuredFailed++;
      await recordHop(cmd, run, member, null, 'failed', e.code || 'ERROR', null);
    }
  }
  if (wordsAdded > 0) {
    const tail = tally.phonePending
      ? `The word-loop sentence so far: "${sentence}" — Copilot was asked through the phone; its word joins this record when the phone posts it.`
      : `The word-loop sentence: "${sentence}"`;
    return { status: 'done', answer: `${blocks.join('\n\n')}\n\n${tail}` };
  }
  return settleMulti(blocks, tally, 'the word loop');
}

async function executeCommand(cmd, ctx, run) {
  const parsed = parseCommand(cmd.text);
  switch (parsed.type) {
    case 'route': return executeRoute(cmd, parsed, ctx, run);
    case 'hello_loop': return executeHelloLoop(cmd, ctx, run);
    case 'share':
    case 'continue': return executeShare(cmd, parsed, ctx, run);
    case 'check': return executeCheck(cmd, parsed, ctx, run);
    case 'broadcast': return executeBroadcast(cmd, parsed, ctx, run);
    case 'compare': return executeCompare(cmd, parsed, ctx, run);
    case 'read_log': return executeReadLog(cmd, ctx, run);
    case 'summarize': return executeSummarize(cmd, ctx, run);
    case 'word_loop': return executeWordLoop(cmd, ctx, run);
    default: return {
      status: 'failed',
      answer: `The API lane cannot run that command yet: "${cmd.text}". The lane runs "Have <AI> ..." requests (with failover to the next configured member), the hello loop, the word loop, "Share with <AI>", "Continue with <AI>", "Check that", "Brainstorm across all AI: ...", "Compare answers", "Read the log", and "Summarize the loop".`,
    };
  }
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
      // A phone child (Copilot's bridge, or any member's slice-3.5
      // fallback) may have posted its result while this command
      // executed (or before a re-run): fold every finished child's
      // real answer into the record before it is written, so a
      // pending block never overwrites a reply that already landed.
      const fin = await finalizeMemberHops(cmd.id, result.answer);
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
  ROSTER, LESSER_ROSTER, LESSER_MEMBERS, ALIASES, PRICES, PRIMER, MemberError,
  resolveMember, parseCommand, envelope, absenceBlock, costMicroUsd,
  buildAdapters, memberState, absenceReason, lesserPrimer,
  recentSettledCommands, sessionEntries, buildLogText, answerAuthors,
  askMember, extractAddedWord, WORD_LOOP_START, LOG_CONTEXT_CAP,
  COPILOT_PENDING_TEXT, copilotPendingBlock, copilotChildBlock,
  findCopilotChild, ensureCopilotChild, delegateCopilot, finalizeCopilotHop,
  viaPhoneLabel, memberFromChildText, findChildren, findMemberChild, memberChildBlock,
  ensureMemberChild, delegateMember, finalizeMemberHop, finalizeMemberHops,
  createWorker, laneEnabled, start, stop,
  POLL_MS, WATCHDOG_MS, MAX_ATTEMPTS,
};
