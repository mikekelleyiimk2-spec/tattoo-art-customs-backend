// Codex for OneMind plug tests (Slice 1, 2026-10-26).
// The coordinator (test/run.js) wires this in; do not run from here.
async function runHttpTests(ok, req) {
  console.log('codex (registry of the table):');
  const get = async (p) => {
    const r = await req('GET', p);
    let json = null;
    try { json = JSON.parse(r.text); } catch (e) {}
    return { status: r.status, json, text: r.text };
  };

  const all = await get('/api/codex');
  ok(all.status === 200 && all.json && all.json.ok === true, 'codex endpoint responds ok');
  const b = (all.json || {});

  // Sections present and non-empty.
  ok(Array.isArray(b.doors) && b.doors.length > 0, 'codex serves doors');
  ok(Array.isArray(b.plugs) && b.plugs.length > 0, 'codex serves plugs');
  ok(Array.isArray(b.seats) && b.seats.length > 0, 'codex serves seats');
  ok(b.prices && Array.isArray(b.prices.entries) && b.prices.entries.length > 0, 'codex serves price entries');
  ok(typeof b.law === 'string' && b.law.length > 0, 'codex carries its law');
  ok(b.prices && typeof b.prices.law === 'string' && /toll on the flow/i.test(b.prices.law),
    'prices carry the Codex price law (toll on the flow)');
  ok(b.prices && /draft/i.test(b.prices.status || ''), 'prices are marked DRAFT (awaiting owner strike)');

  // Every entry: the public shape, exactly — name, kind, state, liveness.
  const entries = [...(b.doors || []), ...(b.plugs || []), ...(b.seats || []), ...((b.prices || {}).entries || [])];
  ok(entries.length > 0 && entries.every((e) => {
    const keys = Object.keys(e).sort().join(',');
    return keys === 'kind,liveness,name,state'
      && typeof e.name === 'string' && e.name.length > 0
      && typeof e.state === 'string' && e.state.length > 0
      && e.liveness && typeof e.liveness.how_checked === 'string' && e.liveness.how_checked.length > 0
      && /^\d{4}-\d{2}-\d{2}$/.test(e.liveness.last_verified || '');
  }), 'every entry carries exactly {name, kind, state, liveness{how_checked, last_verified}}');

  // The pieces written in today are actually in the book.
  const doorNames = (b.doors || []).map((e) => e.name);
  ok(doorNames.some((n) => /Play Developer API doorway/.test(n)), 'the Play API doorway is written in');
  ok(doorNames.filter((n) => /^Gmail/.test(n)).length === 6, 'all six Gmail doors are written in');
  const tac = (b.doors || []).find((e) => /TAC/.test(e.name));
  ok(!!tac && tac.state === 'down', 'TAC door is on record as down (damage, not hidden)');
  const plugNames = (b.plugs || []).map((e) => e.name);
  ok(plugNames.includes('Affiliate Rolodex plug') && plugNames.includes('Tester Hub pool')
    && plugNames.includes('Email Keeper'), 'rolodex, tester pool, and keeper plugs are written in');
  const gemini = (b.seats || []).find((e) => e.name === 'Gemini');
  ok(!!gemini && /seated/.test(gemini.state), 'Gemini is recorded as the seated API-lane seat');
  const deepseek = (b.seats || []).find((e) => e.name === 'DeepSeek');
  ok(!!deepseek && deepseek.state === 'unconfigured', 'DeepSeek is honestly recorded unconfigured (no key held)');

  // Sensitive-key absence, asserted on keys at every depth AND on the
  // raw bytes: no notes, no token/password/secret fields, no connector
  // account ids, no service-account key material, no draft doc path.
  const badKeys = [];
  (function walk(v, path) {
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (/notes|token|password|secret|account_id|api_?key|credential|private/i.test(k)) badKeys.push(path + '.' + k);
        walk(v[k], path + '.' + k);
      }
    }
  })(b, 'codex');
  ok(badKeys.length === 0, 'no sensitive keys anywhere in the projection' + (badKeys.length ? ' — found: ' + badKeys.join(', ') : ''));
  ok(!/c49143f8|fd81fe76|3f26fb5e|80007e45|441ee532|9ece48da/.test(all.text), 'no connector account ids in the raw response');
  ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(all.text), 'no key material in the raw response');
  ok(!/plug-pricing-draft/.test(all.text), 'the internal draft doc path is not projected');
  ok(!/custody debt/i.test(all.text), 'internal notes (custody debt) are not projected');
}

module.exports = { runHttpTests };
