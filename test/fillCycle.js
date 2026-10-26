// Tester Hub "Fill My Tester List" tests (2026-10-26).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers the fill contract: an order is born 'awaiting_payment' and
// an unpaid app NEVER enters the cycle (no status, no feed
// decoration, confirmations refused); the entitlement grant is
// service-token only and the moment it lands, wave 1 routes; testers
// confirm their own opt-ins (pool members only, idempotent); the
// count climbs to FULL (12) and stops; a drop inside the run reopens
// the cycle for a free top-up; the light board carries real events
// only and never tester data.
const BASE = 'http://localhost:4137';

async function runHttpTests(ok, req) {
  console.log('tester hub (fill my tester list):');
  const TOKEN = process.env.MUSE_SERVICE_TOKEN;
  const call = async (method, p, body, token) => {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, text, json };
  };

  const DEV = 'fill.dev.test@gmail.com';
  const PKG = 'com.filltest.app';

  // A developer + app to fill (public intake, real opt-in URL).
  const add = await call('POST', '/api/testers/apps', {
    app_name: 'Fill Test App', package: PKG,
    optin_url: 'https://play.google.com/apps/testing/com.filltest.app',
    developer_gmail: DEV, blurb: 'Fill cycle test app.',
  });
  ok(add.status === 200 && add.json && add.json.ok === true, 'fill: developer app added to the Hub');

  // Twelve pool members to confirm with.
  const testers = [];
  for (let i = 1; i <= 12; i++) {
    const g = `fill.tester${i}.test@gmail.com`;
    testers.push(g);
    const j = await call('POST', '/api/testers/signup', { name: `Fill Tester ${i}`, gmail: g, source: 'hub-app' });
    if (!(j.status === 200 && j.json && j.json.ok)) { ok(false, `fill: pool member ${i} joined`); }
  }
  ok(true, 'fill: 12 pool members joined');

  // Order: born awaiting_payment at the settled price.
  const ord = await call('POST', '/api/testers/fill/order', { package: PKG, developer_gmail: DEV });
  ok(ord.status === 200 && ord.json.ok === true && ord.json.order.status === 'awaiting_payment'
    && ord.json.order.price_cents === 2499 && ord.json.order.target === 12
    && ord.json.order.confirmed === 0,
    'fill: order created awaiting_payment at $24.99, target 12');

  // THE GATE: unpaid never cycles.
  const earlyConfirm = await call('POST', '/api/testers/fill/confirm', { package: PKG, gmail: testers[0] });
  ok(earlyConfirm.status === 400, 'fill: confirmation refused while unpaid (no fake paid state)');
  const feedBefore = await call('GET', '/api/testers/apps');
  const rowBefore = feedBefore.json.apps.find((a) => a.package === PKG);
  ok(rowBefore && (rowBefore.fill === null || rowBefore.fill === undefined),
    'fill: unpaid app carries no fill decoration in the feed');

  // The grant is service-token only.
  const noToken = await call('POST', '/api/testers/fill/grant', { package: PKG });
  ok(noToken.status === 401 || noToken.status === 404, 'fill: grant without the service token is refused');
  const grant = await call('POST', '/api/testers/fill/grant', { package: PKG, purchase_ref: 'test-receipt-1', simulated: true }, TOKEN);
  ok(grant.status === 200 && grant.json.ok === true && grant.json.order.status === 'filling'
    && grant.json.order.wave === 1 && grant.json.order.simulated === true,
    'fill: grant flips to filling, wave 1 routed, simulated recorded honestly');

  // Status shows the cycle live.
  const st = await call('GET', `/api/testers/fill/status?package=${PKG}&gmail=${DEV}`);
  ok(st.status === 200 && st.json.order.status === 'filling' && st.json.order.confirmed === 0,
    'fill: status reads filling at 0/12');

  // Confirmations: pool members only, idempotent, counted.
  const stranger = await call('POST', '/api/testers/fill/confirm', { package: PKG, gmail: 'fill.stranger.test@gmail.com' });
  ok(stranger.status === 400, 'fill: a non-pool address cannot confirm');
  const c1 = await call('POST', '/api/testers/fill/confirm', { package: PKG, gmail: testers[0] });
  ok(c1.status === 200 && c1.json.confirmed === true && c1.json.count === 1 && c1.json.full === false,
    'fill: first confirmation counts (1/12)');
  const c1again = await call('POST', '/api/testers/fill/confirm', { package: PKG, gmail: testers[0] });
  ok(c1again.status === 200 && c1again.json.already_confirmed === true && c1again.json.count === 1,
    'fill: a repeat confirmation is idempotent (still 1/12)');

  // Climb to FULL.
  let last = null;
  for (let i = 1; i < 12; i++) {
    last = await call('POST', '/api/testers/fill/confirm', { package: PKG, gmail: testers[i] });
  }
  ok(last && last.json.count === 12 && last.json.full === true, 'fill: 12th confirmation lands FULL');
  const stFull = await call('GET', `/api/testers/fill/status?package=${PKG}`);
  ok(stFull.json.order.status === 'full' && stFull.json.order.confirmed === 12,
    'fill: status reads full at 12/12');

  // A drop inside the run reopens the cycle (free top-up).
  const drop = await call('POST', '/api/testers/fill/dropout', { package: PKG, gmail: testers[11] });
  ok(drop.status === 200 && drop.json.dropped === true && drop.json.count === 11,
    'fill: dropout removes the confirmation (11/12)');
  const stTop = await call('GET', `/api/testers/fill/status?package=${PKG}`);
  ok(stTop.json.order.status === 'filling', 'fill: full reopens to filling for the free top-up');
  const back = await call('POST', '/api/testers/fill/confirm', { package: PKG, gmail: testers[11] });
  ok(back.status === 200 && back.json.full === true, 'fill: top-up confirmation restores FULL');

  // The light board: real events, no tester data anywhere. (The
  // default page is the 12 freshest lights; ask for the full window
  // to see the whole run's events.)
  const board = await call('GET', '/api/testers/board?limit=50');
  ok(board.status === 200 && board.json.ok === true && Array.isArray(board.json.developer)
    && board.json.developer.some((e) => e.kind === 'fill_started')
    && board.json.developer.some((e) => e.kind === 'full'),
    'fill: board carries the real fill_started + full events');
  ok(!board.text.includes('fill.tester1.test@gmail.com') && !board.text.includes(DEV),
    'fill: board never leaks a tester or developer address');
}

module.exports = { runHttpTests };
