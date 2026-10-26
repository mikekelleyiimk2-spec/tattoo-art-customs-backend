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
  ok(b.prices && /all settled/i.test(b.prices.status || ''), 'prices status records ALL SETTLED after Approval Batch #1 (Oct 26)');
  ok(b.prices && /settled/i.test(b.prices.status || ''), 'prices status records the Oct 26 settled strike');
  const roloPrice = ((b.prices || {}).entries || []).find((e) => /Profile Plug/.test(e.name));
  ok(!!roloPrice && /settled/i.test(roloPrice.state || '')
    && roloPrice.state.includes('$4.99') && roloPrice.state.includes('$0.99')
    && roloPrice.state.includes('15%'),
    'Rolodex/Profile Plug price entry is SETTLED with the six struck numbers');
  const svcPrice = ((b.prices || {}).entries || []).find((e) => /AI API Service Plug/.test(e.name));
  ok(!!svcPrice && /settled/i.test(svcPrice.state || '') && svcPrice.state.includes('$49'),
    'Service Plug price is SETTLED at $49 (Approval Batch #1, items 2 + 4)');
  const rootPrice = ((b.prices || {}).entries || []).find((e) => /Root AI API/.test(e.name));
  ok(!!rootPrice && /settled/i.test(rootPrice.state || '') && rootPrice.state.includes('$149'),
    'Root AI API price is SETTLED at $149 (Approval Batch #1, item 3)');
  const docPrice = ((b.prices || {}).entries || []).find((e) => /Connection Doctor/.test(e.name));
  ok(!!docPrice && /settled/i.test(docPrice.state || '') && docPrice.state.includes('$29'),
    'Connection Doctor price is SETTLED at $29 (Approval Batch #1, item 5)');
  const watchPrice = ((b.prices || {}).entries || []).find((e) => /Money Watch/.test(e.name));
  ok(!!watchPrice && /settled/i.test(watchPrice.state || '') && watchPrice.state.includes('$4.99'),
    'Money Watch price entry is present and SETTLED at $4.99 (Approval Batch #1, item 1)');
  // No DRAFT price remains anywhere: every price entry reads SETTLED and
  // the status line says the draft figures are gone (the struck-boundary
  // wording "No DRAFT figures remain" is the settled truth, asserted as
  // such — not an unsettled DRAFT marker).
  const priceEntries = (b.prices || {}).entries || [];
  ok(priceEntries.length > 0 && priceEntries.every((e) => /settled/i.test(e.state || '')),
    'every price entry reads SETTLED — no DRAFT price remains (Approval Batch #1)');
  ok(/no draft figures remain/i.test(b.prices.status || ''),
    'prices status states no DRAFT figures remain');

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
  const paypalDoor = (b.doors || []).find((e) => /PayPal/.test(e.name));
  ok(!!paypalDoor && /built/i.test(paypalDoor.state) && /awaiting credential/i.test(paypalDoor.state),
    'the PayPal door is written in as built, awaiting credential registration (Playbook #2)');
  ok(doorNames.filter((n) => /^Gmail/.test(n)).length === 6, 'all six Gmail doors are written in');
  const tac = (b.doors || []).find((e) => /TAC/.test(e.name));
  ok(!!tac && tac.state === 'down', 'TAC door is on record as down (damage, not hidden)');
  const plugNames = (b.plugs || []).map((e) => e.name);
  ok(plugNames.includes('Affiliate Rolodex plug') && plugNames.includes('Tester Hub pool')
    && plugNames.includes('Email Keeper'), 'rolodex, tester pool, and keeper plugs are written in');
  const profilePlug = (b.plugs || []).find((e) => e.name === 'Profile Plug');
  ok(!!profilePlug && /live/.test(profilePlug.state), 'the Profile Plug is written in as a live plug (slice 4)');
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

  // /onemind — the product's own page (website split follow-up,
  // 2026-10-26). Its seat board renders from this same book, so the
  // page must tell the identical truth: exactly one configured seat
  // (Gemini), every other seat labeled as unconfigured / phone-lane /
  // named-not-built, the settled $9.99/mo price, and honest
  // closed-testing status.
  console.log('onemind page (seat board renders the codex truth):');
  const page = await req('GET', '/onemind');
  ok(page.status === 200, '/onemind serves 200');
  ok(/All Your AIs, One Team/.test(page.text), '/onemind carries the OneMind name line');
  ok(page.text.includes('$9.99/mo'), '/onemind states the settled OneMind Team price $9.99/mo');
  ok(/closed testing/i.test(page.text), '/onemind honestly says the app is in closed testing');
  ok(page.text.includes('href="/testers"'), '/onemind download door points at the tester path');
  const configuredCount = (page.text.match(/Seated — configured/g) || []).length;
  ok(configuredCount === 1, '/onemind marks exactly ONE seat configured (Gemini) — none faked live');
  ok(page.text.includes('Gemini'), '/onemind seat board names Gemini');
  ok(page.text.includes('Not configured yet'), '/onemind labels unconfigured seats as not configured');
  ok(page.text.includes('Phone lane — chair unclaimed'), '/onemind labels Copilot as phone lane, chair unclaimed');
  ok(page.text.includes('Named — not built yet'), '/onemind labels the named worker seats as not built');
  ok(/Building/.test(page.text) && /AI-to-AI room/.test(page.text), '/onemind shows the AI-to-AI room as building');
  ok(page.text.includes('paypal.com/ncp/payment/WA9DS6J8ERSHW'), '/onemind carries the mk4 tip jar');
  ok(/SPONSORED/.test(page.text) && /This spot is open/.test(page.text), '/onemind sponsor slot is labeled and pending-fill (no affiliate fits yet)');
  ok(!/little-inkers|poppy-and-ziggy/.test(page.text), '/onemind carries no links into kid-walled surfaces');

  const worlds = await req('GET', '/worlds');
  ok(worlds.status === 200 && worlds.text.includes('href="/onemind"'), '/worlds OneMind card points at /onemind');

  const priv = await req('GET', '/privacy/onemind');
  ok(priv.status === 200 && priv.text.includes('OneMind') && priv.text.includes('com.usefulappz.aibar'),
    '/privacy/onemind serves the OneMind privacy policy');

  const sm = await req('GET', '/sitemap.xml');
  ok(sm.status === 200 && sm.text.includes('/onemind') && sm.text.includes('/privacy/onemind'),
    'sitemap lists /onemind and /privacy/onemind');
}

module.exports = { runHttpTests };
