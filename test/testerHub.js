// Tester Hub pool machine tests (2026-10-26).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers the pool contract: sign-up IS the opt-in (idempotent per
// Gmail, Gmail-only validation), leave flips status out of the count
// and the roster, the roster is service-token ONLY (PII), and the app
// feed is public, fleet-seeded, and records the pool snapshot — the
// "12 in one go" number — when a developer adds an app.
const BASE = 'http://localhost:4137';

async function runHttpTests(ok, req) {
  console.log('tester hub (pool machine):');
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

  const TEST_GMAIL = 'pool.machine.test@gmail.com';
  const DEV_GMAIL = 'pool.dev.test@gmail.com';

  // Baseline count (compatible shape with the old route).
  const base = await call('GET', '/api/testers/count');
  ok(base.status === 200 && base.json && base.json.ok === true
    && typeof base.json.count === 'number', 'count responds { ok, count }');
  const baseCount = base.json.count;

  // Signup validation: junk never joins the pool.
  const noName = await call('POST', '/api/testers/signup', { gmail: TEST_GMAIL });
  ok(noName.status === 400, 'signup without a name is 400');
  const badShape = await call('POST', '/api/testers/signup', { name: 'Pool Test', gmail: 'not-an-email' });
  ok(badShape.status === 400, 'signup with a malformed address is 400');
  const nonGmail = await call('POST', '/api/testers/signup', { name: 'Pool Test', gmail: 'pool@yahoo.com' });
  ok(nonGmail.status === 400, 'signup with a non-Gmail address is 400 (the pool is a Gmail pool)');
  const afterJunk = await call('GET', '/api/testers/count');
  ok(afterJunk.json.count === baseCount, 'rejected signups changed nothing');

  // Join: sign-up IS the opt-in. Idempotent per Gmail.
  const join = await call('POST', '/api/testers/signup', { name: 'Pool Machine Test', gmail: TEST_GMAIL, source: 'hub-app' });
  ok(join.status === 200 && join.json && join.json.ok === true && join.json.joined === true
    && join.json.already_member === false && join.json.pool_count === baseCount + 1,
    'signup joins the pool and the count moves by one');
  const joinAgain = await call('POST', '/api/testers/signup', { name: 'Pool Machine Test', gmail: TEST_GMAIL.toUpperCase(), source: 'hub-app' });
  ok(joinAgain.status === 200 && joinAgain.json.already_member === true
    && joinAgain.json.pool_count === baseCount + 1,
    'repeat signup (any case) is idempotent — still one member');

  // Roster: token-only PII. No token / wrong token -> 401, and the
  // roster body must never ride a public response.
  const poolNoTok = await call('GET', '/api/testers/pool');
  ok(poolNoTok.status === 401 && !poolNoTok.text.includes(TEST_GMAIL), 'pool roster rejects a missing token and leaks nothing');
  const poolBadTok = await call('GET', '/api/testers/pool', undefined, 'wrong-token');
  ok(poolBadTok.status === 401, 'pool roster rejects a wrong token');
  const pool = await call('GET', '/api/testers/pool', undefined, TOKEN);
  ok(pool.status === 200 && pool.json && pool.json.ok === true
    && pool.json.count === baseCount + 1
    && pool.json.testers.some((t) => t.gmail === TEST_GMAIL && t.name === 'Pool Machine Test'),
    'pool roster (service token) carries the new member');
  const feedPeek = await call('GET', '/api/testers/apps');
  ok(!feedPeek.text.includes(TEST_GMAIL), 'the public app feed never carries pool addresses');

  // Leave: one call, out of the count AND the roster. Re-join flips back.
  const leave = await call('POST', '/api/testers/leave', { gmail: TEST_GMAIL });
  ok(leave.status === 200 && leave.json && leave.json.left === true
    && leave.json.pool_count === baseCount, 'leave drops the member from the count');
  const poolAfterLeave = await call('GET', '/api/testers/pool', undefined, TOKEN);
  ok(poolAfterLeave.json && !poolAfterLeave.json.testers.some((t) => t.gmail === TEST_GMAIL),
    'a left member is out of the roster');
  const leaveGhost = await call('POST', '/api/testers/leave', { gmail: 'ghost.notinpool@gmail.com' });
  ok(leaveGhost.status === 404, 'leaving with an unknown Gmail is 404');
  const rejoin = await call('POST', '/api/testers/signup', { name: 'Pool Machine Test', gmail: TEST_GMAIL, source: 'hub-app' });
  ok(rejoin.status === 200 && rejoin.json.reactivated === true
    && rejoin.json.pool_count === baseCount + 1, 're-join after leaving reactivates the member');

  // App feed: fleet-seeded, public, no developer Gmails exposed.
  const feed = await call('GET', '/api/testers/apps');
  const apps = (feed.json && feed.json.apps) || [];
  ok(feed.status === 200 && feed.json && feed.json.ok === true
    && feed.json.pool_count === baseCount + 1, 'app feed responds with the live pool count');
  ok(apps.length === 21 && apps.every((a) => a.source === 'fleet'),
    'app feed is seeded with the fleet\'s 21 apps');
  const tac = apps.find((a) => a.package === 'com.tattooartcustoms.app');
  ok(!!tac && tac.optin_url === 'https://play.google.com/apps/testing/com.tattooartcustoms.app',
    'fleet rows carry their real opt-in URLs');
  const oneMind = apps.find((a) => a.package === 'com.usefulappz.aibar');
  ok(!!oneMind && oneMind.optin_url === null, 'OneMind (track not live) is listed with no fabricated link');
  ok(apps.every((a) => !('developer_gmail' in a)), 'feed rows never expose developer Gmails');

  // Add an app: validation first, then the snapshot is the live pool.
  const badPkg = await call('POST', '/api/testers/apps', { app_name: 'Bad', package: 'not a package', optin_url: 'https://play.google.com/apps/testing/x', developer_gmail: DEV_GMAIL });
  ok(badPkg.status === 400, 'add-app with a junk package id is 400');
  const badUrl = await call('POST', '/api/testers/apps', { app_name: 'Bad', package: 'com.example.bad', optin_url: 'http://insecure.example.com/x', developer_gmail: DEV_GMAIL });
  ok(badUrl.status === 400, 'add-app with a non-https opt-in URL is 400');
  const badDev = await call('POST', '/api/testers/apps', { app_name: 'Bad', package: 'com.example.bad', optin_url: 'https://play.google.com/apps/testing/com.example.bad', developer_gmail: 'dev@example.com' });
  ok(badDev.status === 400, 'add-app with a non-Gmail developer address is 400');

  const add = await call('POST', '/api/testers/apps', {
    app_name: 'Pool Test App', package: 'com.example.pooltest',
    optin_url: 'https://play.google.com/apps/testing/com.example.pooltest',
    developer_gmail: DEV_GMAIL, blurb: 'A test app for the pool machine tests.',
  });
  ok(add.status === 200 && add.json && add.json.ok === true && add.json.added === true
    && add.json.already_listed === false, 'a developer can add an app to the Hub');
  ok(add.json.app && add.json.app.pool_snapshot === baseCount + 1,
    'the added app records the pool snapshot — testers it instantly has');
  const feedAfter = await call('GET', '/api/testers/apps');
  const feedApps = (feedAfter.json && feedAfter.json.apps) || [];
  ok(feedApps.length === 22 && feedApps.some((a) => a.package === 'com.example.pooltest'
    && a.pool_snapshot === baseCount + 1), 'the added app appears in the feed with its snapshot');
  ok(!feedAfter.text.includes(DEV_GMAIL), 'the feed never leaks the developer Gmail');

  const addAgain = await call('POST', '/api/testers/apps', {
    app_name: 'Pool Test App', package: 'com.example.pooltest',
    optin_url: 'https://play.google.com/apps/testing/com.example.pooltest',
    developer_gmail: DEV_GMAIL,
  });
  ok(addAgain.status === 200 && addAgain.json.already_listed === true
    && addAgain.json.app.pool_snapshot === baseCount + 1,
    're-adding the same package is idempotent and keeps the original snapshot');
  const feedFinal = await call('GET', '/api/testers/apps');
  ok(((feedFinal.json && feedFinal.json.apps) || []).length === 22, 'no duplicate app row was created');
}

module.exports = { runHttpTests };
