// Money Watch tests (slice 1, 2026-10-26).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers the design's load-bearing rules:
//  - a LANDING fires exactly once (watermark + seen-IDs per source);
//    the first watcher pass is a baseline that fires nothing.
//  - kinds are honest: website sales + the Penny Ledger house share
//    are revenue; the other split slices are transfers shown as
//    themselves; refunds are refunds. Window totals sum revenue only.
//  - the Penny Ledger's Gmail accounts are mapped to role labels at
//    detection time — a raw Gmail never enters the watch state, in
//    either view.
//  - window boundaries are America/Chicago (the owner's "today").
//  - GET /api/money-watch is public + read-only with the whitelisted
//    projection; ?full=1 and POST /run sit behind the Muse service
//    token (404/401 discipline like the keeper ingest).
const BASE = 'http://localhost:4137';

// ---- unit + DB tests (run in-process against the suite's temp DB) ----
async function runDbTests(ok) {
  console.log('money watch (classification + watcher):');
  const mw = require('../src/lib/moneyWatch');
  const db = require('../src/db');

  // Classification — orders.
  const paid = mw.classifyOrder({ id: 'o1', status: 'paid', amount_cents: 499, amount_paid_cents: 499, paid_at: 1000, created_at: 900 });
  ok(paid.kind === 'revenue' && paid.amount_cents === 499 && paid.at === 1000
    && paid.line.includes('$4.99'), 'paid order classifies as a revenue landing');
  ok(Array.isArray(paid.split) && paid.split.length === 2
    && paid.split[0].amount_cents === 50 && paid.split[1].amount_cents === 449,
    'revenue landing carries the §7A split math (10% overhead, rest business lanes)');
  const refunded = mw.classifyOrder({ id: 'o2', status: 'refunded', amount_cents: 499, amount_paid_cents: 499, paid_at: 2000, created_at: 1900 });
  ok(refunded.kind === 'refund' && refunded.amount_cents === -499 && refunded.split.length === 0,
    'refunded order classifies as a refund, never revenue');

  // Classification — penny ledger rows, incl. the Gmail mapping.
  const house = mw.classifyPenny({ id: 'p1', account: 'house', kind: 'split_house', amount_cents: 81, created_at: 3000 });
  ok(house.kind === 'revenue' && house.amount_cents === 81, 'penny house share is revenue');
  const referrer = mw.classifyPenny({ id: 'p2', account: 'devref@example.com', kind: 'split_referrer', amount_cents: 1, created_at: 3000 });
  ok(referrer.kind === 'transfer' && !JSON.stringify(referrer).includes('devref@example.com')
    && referrer.account.includes('referrer'), 'referrer penny is a transfer; the Gmail becomes a role label');
  const spend = mw.classifyPenny({ id: 'p3', account: 'devbuyer@example.com', kind: 'credit_spend', amount_cents: -99, created_at: 3001 });
  ok(spend.kind === 'transfer' && spend.amount_cents === -99
    && !JSON.stringify(spend).includes('devbuyer@example.com'), 'credit spend stays negative, Gmail never surfaces');
  const weird = mw.classifyPenny({ id: 'p4', account: 'pot', kind: 'something_new', amount_cents: 5, created_at: 3002 });
  ok(weird.kind === 'unknown', 'an unrecognized ledger kind is shown as unknown, never laundered');

  // Chicago window boundaries (fixed clock).
  const MON = Date.parse('2026-10-26T13:00:00Z'); // Monday 08:00 CDT
  const starts = mw.windowStarts(MON);
  ok(starts.today === Date.parse('2026-10-26T05:00:00Z'), 'today starts at CT midnight (05:00Z in CDT)');
  ok(starts.this_week === Date.parse('2026-10-26T05:00:00Z'), 'this week starts Monday CT midnight');
  ok(starts.this_month === Date.parse('2026-10-01T05:00:00Z'), 'this month starts on the 1st, CT midnight');
  const SUN = Date.parse('2026-10-25T15:00:00Z'); // Sunday 10:00 CDT
  ok(mw.windowStarts(SUN).this_week === Date.parse('2026-10-19T05:00:00Z'),
    'on Sunday the week still started the previous Monday');
  const wins = mw.computeWindows([
    { kind: 'revenue', amount_cents: 100, at: MON - 30 * 60 * 1000 },
    { kind: 'revenue', amount_cents: 200, at: MON - 2 * 3600 * 1000 },
    { kind: 'transfer', amount_cents: 999, at: MON - 10 * 60 * 1000 },
    { kind: 'refund', amount_cents: -500, at: MON - 10 * 60 * 1000 },
  ], MON);
  ok(wins.last_hour.revenue_cents === 100 && wins.today.revenue_cents === 300
    && wins.this_month.revenue_cents === 300,
    'window totals sum revenue-kind landings only (transfers/refunds excluded)');

  // The watcher over the real tables. Baseline first: whatever the
  // seed/other DB tests already wrote is absorbed, fires nothing.
  const t0 = Date.now();
  const base = await mw.runWatcher(t0);
  ok(base.baseline === true && base.new_landings === 0, 'first watcher pass is a baseline — fires nothing');
  let state = await mw.getState();
  ok(state.baseline_at === t0 && state.landings.length === 0, 'baseline records itself, holds zero landings');

  // Fixtures: one paid website order + one full $0.99 penny split
  // (google 15 / pot 1 / buyer credit 1 / house 81 / referrer 1 = 99)
  // + one credit spend. The order is stamped 5s after the ledger rows
  // so the newest landing is unambiguous. BOTH fixtures are deleted
  // again at the end of these tests: the suite's Profile Plug tests
  // assert ABSOLUTE penny-pot totals over this shared temp DB, and a
  // stray paid order would shift the global paid-order counts other
  // tests watch. Test hygiene, not product behavior.
  const now = Date.now();
  await db.insert('orders', {
    id: 'mw-test-order-1', buyer_id: 'mw-test-buyer', order_type: 'premade',
    amount_cents: 499, amount_paid_cents: 499, status: 'paid',
    paid_at: now + 5000, created_at: now,
  });
  const splitRows = [
    { id: 'mw-penny-1', account: 'google', kind: 'split_google_fee', amount_cents: 15 },
    { id: 'mw-penny-2', account: 'pot', kind: 'split_pot', amount_cents: 1 },
    { id: 'mw-penny-3', account: 'devbuyer@example.com', kind: 'split_buyer_credit', amount_cents: 1 },
    { id: 'mw-penny-4', account: 'house', kind: 'split_house', amount_cents: 81 },
    { id: 'mw-penny-5', account: 'devref@example.com', kind: 'split_referrer', amount_cents: 1 },
    { id: 'mw-penny-6', account: 'devbuyer@example.com', kind: 'credit_spend', amount_cents: -99 },
  ];
  for (const r of splitRows) await db.insert('penny_ledger', { ...r, entry_id: 'mw-entry', purchase_ref: 'mw-test', created_at: now });

  const run1 = await mw.runWatcher(Date.now());
  ok(run1.baseline === false && run1.new_landings === 7, 'second pass fires each new source row exactly once (1 order + 6 ledger rows)');
  state = await mw.getState();
  ok(state.landings.length === 7, 'state holds the seven landings');
  const revenue = state.landings.filter((l) => l.kind === 'revenue');
  ok(revenue.length === 2 && revenue.reduce((s, l) => s + l.amount_cents, 0) === 580,
    'revenue landings are the sale + the house share only ($5.80)');
  const stateJson = JSON.stringify(state);
  ok(!stateJson.includes('devbuyer@example.com') && !stateJson.includes('devref@example.com'),
    'no Gmail anywhere in the stored watch state');

  const run2 = await mw.runWatcher(Date.now());
  ok(run2.new_landings === 0, 'third pass fires nothing — a landing exists exactly once');

  // Views over the same state (clock past every fixture timestamp).
  const pub = mw.publicView(state, now + 60000);
  ok(pub.headline.startsWith('You made'), 'public headline is the newest landing\u2019s report line');
  ok(pub.doors.length === 7 && pub.doors.filter((d) => d.state === 'wired').length === 2,
    'doors list names the two wired sources and the unwired ones — nothing faked');
  ok(pub.windows.last_hour.revenue_cents === 580, 'public last-hour window sums the revenue landings');
  ok(pub.split_plan.moves_money === false, 'the split plan states plainly that it moves nothing');
  const full = mw.fullView(state, Date.now());
  ok(full.personal_side && full.personal_side.wired === false && full.personal_side.landings.length === 0,
    'full view carries the personal side as its own unwired section');
  ok(full.watcher && full.watcher.landings_held === 7, 'full view carries watcher internals');

  // Fixture cleanup (see the note at the inserts): the shared temp
  // DB returns to exactly its pre-test contents. The watch state in
  // site_kv keeps the seven landings — that store is Money Watch's
  // own, and the HTTP tests below read it.
  await db.query('DELETE FROM orders WHERE id = ?', ['mw-test-order-1']);
  await db.query("DELETE FROM penny_ledger WHERE id LIKE 'mw-penny-%'");

  // ---- PayPal door (Service Plug Playbook #2, 2026-10-26) ----
  console.log('money watch (paypal lane — playbook #2):');
  const plug = require('../src/lib/paypalPlug');

  // Env absent — the suite never seats the WATCH credential pair, and
  // the checkout lane's PAYPAL_CLIENT_ID stub must NOT configure this
  // door (per-door env seats). The door reads built + awaiting
  // registration: honest, not wired, not vanished.
  delete process.env.PAYPAL_WATCH_CLIENT_ID;
  delete process.env.PAYPAL_WATCH_CLIENT_SECRET;
  ok(plug.configured() === false, 'paypal plug is unconfigured without its own env seat (checkout stub vars do not count)');
  const builtDoor = mw.publicView(state, Date.now()).doors.find((d) => d.key === 'paypal-mk4');
  ok(builtDoor.state === 'built' && /awaiting credential registration/.test(builtDoor.note),
    'env absent: PayPal door shows "plug built, awaiting credential registration"');

  // Classification by event-code family.
  const ppIn = mw.classifyPaypal({ id: 't1', at: 100, amount_cents: 1000, currency: 'USD', event_code: 'T0006' });
  ok(ppIn.kind === 'revenue' && ppIn.amount_cents === 1000 && ppIn.split.length === 2
    && ppIn.account === 'Business PayPal — mk4', 'paypal payment received is revenue with the §7A split math');
  const ppOut = mw.classifyPaypal({ id: 't2', at: 100, amount_cents: -2000, currency: 'USD', event_code: 'T0400' });
  ok(ppOut.kind === 'transfer' && ppOut.amount_cents === -2000, 'paypal withdrawal to a bank is a transfer');
  const ppRef = mw.classifyPaypal({ id: 't3', at: 100, amount_cents: -499, currency: 'USD', event_code: 'T1106' });
  ok(ppRef.kind === 'refund' && ppRef.amount_cents === -499, 'paypal refund event is a refund, negative');
  const ppCb = mw.classifyPaypal({ id: 't4', at: 100, amount_cents: -499, currency: 'USD', event_code: 'T1201' });
  ok(ppCb.kind === 'refund', 'paypal chargeback family is a refund, shown as itself');
  const ppSent = mw.classifyPaypal({ id: 't5', at: 100, amount_cents: -750, currency: 'USD', event_code: 'T0002' });
  ok(ppSent.kind === 'unknown', 'a payment he sent is shown as itself — never netted, never revenue');
  const ppWeird = mw.classifyPaypal({ id: 't6', at: 100, amount_cents: 300, currency: 'USD', event_code: 'T2002' });
  ok(ppWeird.kind === 'unknown', 'an unmapped PayPal event code is unknown, never laundered');
  const ppFx = mw.classifyPaypal({ id: 't7', at: 100, amount_cents: 300, currency: 'EUR', event_code: 'T0006' });
  ok(ppFx.kind === 'unknown' && /EUR/.test(ppFx.line), 'a non-USD movement is never converted or counted as revenue');

  // Env present + mocked transport: the full lane with zero network
  // and zero real credential. First wired pass = door baseline
  // (history absorbed, fires nothing); new transactions then fire
  // classified, exactly once.
  process.env.PAYPAL_WATCH_CLIENT_ID = 'watch-test-id';
  process.env.PAYPAL_WATCH_CLIENT_SECRET = 'watch-test-secret';
  const HIST_AT = Date.now() - 3600 * 1000;
  const mkTx = (id, code, value, at) => ({
    transaction_info: {
      transaction_id: id, transaction_event_code: code, transaction_status: 'S',
      transaction_amount: { value, currency_code: 'USD' },
      transaction_initiation_date: new Date(at).toISOString(),
      transaction_updated_date: new Date(at).toISOString(),
    },
  });
  let mockTx = [mkTx('PP-HIST-1', 'T0006', '10.00', HIST_AT)];
  plug._setTransportForTests(async ({ url }) => {
    if (url.includes('/v1/oauth2/token')) return { status: 200, json: { access_token: 'test-access-token', expires_in: 32400 } };
    if (url.includes('/v1/reporting/balances')) return { status: 200, json: { balances: [{ currency: 'USD', total_balance: { value: '0.00', currency_code: 'USD' } }] } };
    if (url.includes('/v1/reporting/transactions')) {
      const u = new URL(url);
      const start = Date.parse(u.searchParams.get('start_date'));
      const end = Date.parse(u.searchParams.get('end_date'));
      const rows = mockTx.filter((t) => {
        const d = Date.parse(t.transaction_info.transaction_updated_date);
        return d >= start && d <= end;
      });
      return { status: 200, json: { transaction_details: rows, page: 1, total_pages: 1, total_items: rows.length } };
    }
    return { status: 404, json: {} };
  });
  ok(plug.configured() === true, 'paypal plug is configured once its env seat exists');
  const balances = await plug.fetchBalances();
  ok(Array.isArray(balances) && balances.length === 1, 'the proof read (balances) answers over the mocked transport');

  const doorBase = await mw.runWatcher(Date.now());
  let st2 = await mw.getState();
  ok(doorBase.new_landings === 0 && st2.paypal_baseline_at !== null
    && !st2.landings.some((l) => l.id === 'paypal:PP-HIST-1'),
    'first wired pass is the PayPal door baseline — history absorbed, nothing fired');

  const NEW_AT = Date.now();
  mockTx = [...mockTx,
    mkTx('PP-NEW-1', 'T0006', '4.99', NEW_AT),
    mkTx('PP-NEW-2', 'T0400', '-20.00', NEW_AT),
    mkTx('PP-NEW-3', 'T1106', '-4.99', NEW_AT),
  ];
  const doorRun = await mw.runWatcher(Date.now());
  st2 = await mw.getState();
  const ppLandings = st2.landings.filter((l) => l.id.startsWith('paypal:'));
  ok(doorRun.new_landings === 3 && ppLandings.length === 3, 'new PayPal transactions fire as landings on the next pass');
  const ppRev = ppLandings.find((l) => l.id === 'paypal:PP-NEW-1');
  ok(ppRev && ppRev.kind === 'revenue' && ppRev.amount_cents === 499 && ppRev.split.length === 2,
    'the PayPal payment lands as revenue with the split math');
  ok(ppLandings.find((l) => l.id === 'paypal:PP-NEW-2').kind === 'transfer'
    && ppLandings.find((l) => l.id === 'paypal:PP-NEW-3').kind === 'refund',
    'the payout lands as a transfer and the refund as a refund');
  ok(!JSON.stringify(st2).includes('watch-test-secret') && !JSON.stringify(st2).includes('test-access-token'),
    'no credential material ever enters the watch state');
  const wiredDoor = mw.publicView(st2, Date.now()).doors.find((d) => d.key === 'paypal-mk4');
  ok(wiredDoor.state === 'wired', 'env present: the PayPal door reads wired');
  const doorAgain = await mw.runWatcher(Date.now());
  ok(doorAgain.new_landings === 0, 'PayPal landings fire exactly once — the next pass is silent');

  // A failed read parks the door: error class surfaces, the rest of
  // the pass completes, and nothing half-fires.
  plug._setTransportForTests(async () => ({ status: 401, json: { error: 'invalid_client' } }));
  const doorFail = await mw.runWatcher(Date.now());
  ok(doorFail.paypal_error === 'credential_rejected' && doorFail.new_landings === 0,
    'a rejected credential parks the door with its error class — no crash, no half-fired pass');

  // Restore the unconfigured state: the HTTP tests (spawned server,
  // same env discipline) and every later suite must see the built door.
  plug._setTransportForTests(null);
  delete process.env.PAYPAL_WATCH_CLIENT_ID;
  delete process.env.PAYPAL_WATCH_CLIENT_SECRET;
  ok(plug.configured() === false, 'paypal plug restored to unconfigured for the rest of the suite');
}

// ---- HTTP tests (against the spawned server, same temp DB) ----
async function runHttpTests(ok, req) {
  console.log('money watch (endpoint):');
  const TOKEN = process.env.MUSE_SERVICE_TOKEN;
  const call = async (method, p, token) => {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, text, json };
  };

  const pub = await call('GET', '/api/money-watch');
  ok(pub.status === 200 && pub.json && pub.json.ok === true && pub.json.view === 'public',
    'GET /api/money-watch responds ok as the public view');
  ok(typeof pub.json.headline === 'string' && pub.json.headline.length > 0
    && Array.isArray(pub.json.doors) && Array.isArray(pub.json.landings)
    && pub.json.windows && 'last_hour' in pub.json.windows && 'this_month' in pub.json.windows,
    'public envelope carries headline, doors, landings, windows');
  ok(pub.json.doors.filter((d) => d.state === 'wired').length === 2
    && pub.json.doors.some((d) => /PayPal/.test(d.name) && d.state === 'built')
    && /awaiting credential registration/.test((pub.json.doors.find((d) => /PayPal/.test(d.name)) || {}).note || ''),
    'mk4 PayPal is named as a built door awaiting credential registration (Playbook #2), not faked as watched');
  ok((pub.json.landings || []).every((l) => !/@/.test(l.account) && !/@/.test(l.source)),
    'no public landing carries an email-shaped account or source');
  ok(!pub.text.includes(TOKEN) && !('personal_side' in pub.json),
    'public view leaks no token and carries no personal side');

  const fullAnon = await call('GET', '/api/money-watch?full=1');
  ok(fullAnon.status === 401, 'full view rejects a missing Bearer <redacted>');
  const fullBad = await call('GET', '/api/money-watch?full=1', 'wrong-token');
  ok(fullBad.status === 401, 'full view rejects a wrong Bearer <redacted>');
  const full = await call('GET', '/api/money-watch?full=1', TOKEN);
  ok(full.status === 200 && full.json.view === 'full'
    && full.json.personal_side && full.json.personal_side.wired === false
    && full.json.watcher && typeof full.json.watcher.landings_held === 'number',
    'full view serves to the service token with personal side + watcher internals');

  const runAnon = await call('POST', '/api/money-watch/run');
  ok(runAnon.status === 401, 'watcher run rejects a missing Bearer <redacted>');
  const runBad = await call('POST', '/api/money-watch/run', 'wrong-token');
  ok(runBad.status === 401, 'watcher run rejects a wrong Bearer <redacted>');
  const run1 = await call('POST', '/api/money-watch/run', TOKEN);
  ok(run1.status === 200 && run1.json.ok === true && typeof run1.json.new_landings === 'number',
    'watcher run executes under the service token');
  const run2 = await call('POST', '/api/money-watch/run', TOKEN);
  ok(run2.status === 200 && run2.json.new_landings === 0,
    'an immediate second run fires nothing — exactly-once holds over HTTP');
}

module.exports = { runDbTests, runHttpTests };
