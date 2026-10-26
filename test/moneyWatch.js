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
    && pub.json.doors.some((d) => /PayPal/.test(d.name) && d.state === 'unwired'),
    'mk4 PayPal is named as an unwired door, not faked as watched');
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
