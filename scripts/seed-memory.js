// Seed the AI Memory Store with the owner's standing AI Button orders
// (scope 'global', kind 'order'). Talks to the live /api/muse/memory
// endpoints over HTTPS so it exercises the real store, exactly like
// scripts/seed-pd-trio.js is a one-purpose seed — except this one is
// IDEMPOTENT: for each entry it reads the current value first and
// only POSTs when the key is missing or its value differs (a differing
// POST is a correction and lands as version+1, preserving history).
// Run explicitly, never on boot:
//   node scripts/seed-memory.js
// Base URL override: MEMORY_API_BASE (default production).
// Token: MUSE_SERVICE_TOKEN env, else ~/workspace/.secrets/muse-service-token.
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = (process.env.MEMORY_API_BASE || 'https://tattoo-art-customs.onrender.com').replace(/\/$/, '');

function loadToken() {
  if (process.env.MUSE_SERVICE_TOKEN) return process.env.MUSE_SERVICE_TOKEN.trim();
  const p = path.join(os.homedir(), 'workspace', '.secrets', 'muse-service-token');
  return fs.readFileSync(p, 'utf8').trim();
}

const SEEDS = [
  {
    key: 'muse-full-member',
    value: 'Muse is a full member of the AI Button roster — never app-only, never skipped in the chain.',
  },
  {
    key: 'signin-full-screen-once',
    value: 'AI sign-in happens once, full-screen, in the full app — signed in once and never touched again.',
  },
  {
    key: 'panel-never-login',
    value: 'The floating bubble/panel never hosts a login — logins live in the full app only.',
  },
  {
    key: 'commands-run-without-panel',
    value: 'Queued commands must execute without the panel being open — delivered is not executed.',
  },
  {
    key: 'his-word-is-evidence',
    value: "The owner's report of a failure is the verification — never ask him for a screenshot to prove it.",
  },
  {
    key: 'sarcasm-is-a-verdict',
    value: "The owner's sarcasm is a verdict to read correctly, not praise to celebrate.",
  },
];

async function api(token, method, route, body) {
  const r = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* digest is plain text */ }
  if (!r.ok) throw new Error(`${method} ${route} -> ${r.status}: ${text.slice(0, 200)}`);
  return json;
}

(async () => {
  const token = loadToken();
  const current = await api(token, 'GET', '/api/muse/memory?scope=global&kind=order');
  const byKey = new Map((current.entries || []).map((e) => [e.key, e]));
  let created = 0;
  let corrected = 0;
  let unchanged = 0;
  for (const seed of SEEDS) {
    const cur = byKey.get(seed.key);
    if (cur && cur.value === seed.value) {
      unchanged++;
      console.log(`unchanged  ${seed.key} (v${cur.version})`);
      continue;
    }
    const out = await api(token, 'POST', '/api/muse/memory', {
      scope: 'global', kind: 'order', key: seed.key, value: seed.value,
      source: 'seed-memory.js 2026-10-22',
    });
    if (cur) { corrected++; console.log(`corrected  ${seed.key} -> v${out.entry.version}`); }
    else { created++; console.log(`created    ${seed.key} (v${out.entry.version})`); }
  }
  console.log(`seed-memory done: ${created} created, ${corrected} corrected, ${unchanged} unchanged`);
})().catch((e) => { console.error('seed-memory failed:', e.message); process.exit(1); });
