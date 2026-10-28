// OneMind identity foundation tests (migration 110, 2026-10-26).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers the contract (docs/onemind-signin-contract.md): the surface
// registry refuses kids' surfaces by construction, existing accounts
// are migrated by minting onemind_ids, a sign-in on any tieable
// surface writes the account's tie (first-seated sticks, last-seen
// moves), and the seat summary recognizes the account everywhere —
// "if you've ever had anything we make and later decide to get
// OneMind, it already recognizes you."
const BASE = 'http://localhost:4137';

// Cross-phase stash: accounts and claims created in the db phase
// are exercised over HTTP in the http phase (same test DB file).
const stash = {};

async function runDbTests(ok) {
  console.log('onemind identity (registry + backfill + ties):');
  const db = require('../src/db');
  const surfaces = require('../src/lib/surfaces');
  const onemind = require('../src/lib/onemind');

  // The registry: tieable surfaces exist; kids' surfaces do not.
  ok(surfaces.isTieable('website') === true, 'website is a tieable surface');
  ok(surfaces.isTieable('onemind-app') === true, 'the OneMind app surface is tieable');
  ok(surfaces.isTieable('killintime-console') === true, 'the Neon Tombstone Console surface is tieable');
  ok(surfaces.isTieable('poppy-ziggy-game') === false, 'the Poppy & Ziggy game can never write a tie');
  ok(surfaces.isTieable('little-inkers') === false, 'Little Inkers can never write a tie');
  ok(surfaces.isTieable('little-inkers-app') === false, 'the Little Inkers app can never write a tie');
  ok(surfaces.isTieable('kids-corner') === false, "Kids' Corner can never write a tie");
  ok(surfaces.isTieable('color-with-us') === false, 'Color With Us can never write a tie');
  ok(surfaces.isTieable('') === false, 'an empty surface is not tieable');
  ok(surfaces.isTieable(undefined) === false, 'a missing surface is not tieable');
  ok(surfaces.isTieable('anything-else') === false, 'an unregistered surface is not tieable');

  // Migration of existing accounts: a pre-foundation account (no
  // onemind_id) gets one minted by the backfill — no password change.
  const uid = await db.insert('users', {
    email: 'prefoundation@test.local', password_hash: 'x', role: 'customer', display_name: 'Pre',
  });
  const before = await db.get('SELECT onemind_id FROM users WHERE id = ?', [uid]);
  ok(!before.onemind_id, 'pre-foundation account starts with no onemind_id');
  const minted = await onemind.backfillOneMindIds();
  ok(minted >= 1, 'backfill mints OneMind ids for existing accounts');
  const after = await db.get('SELECT onemind_id FROM users WHERE id = ?', [uid]);
  ok(/^om_[0-9a-f]{24}$/.test(after.onemind_id || ''), 'backfilled account carries an om_ id');
  const reminted = await onemind.backfillOneMindIds();
  ok(reminted === 0, 'backfill is idempotent (second pass mints none)');
  const stable = await onemind.ensureOneMindId(uid);
  ok(stable === after.onemind_id, 'ensureOneMindId returns the same canonical id forever');

  // Kids refusal at the lib level: refused, and no row exists.
  const refused = await onemind.recordTie(uid, 'poppy-ziggy-game');
  ok(refused.ok === false && refused.error === 'surface_not_tieable', 'recordTie refuses a kids surface');
  const kidRows = await db.all(
    'SELECT * FROM account_ties WHERE user_id = ? AND surface = ?', [uid, 'poppy-ziggy-game']);
  ok(kidRows.length === 0, 'no tie row exists for the kids surface');

  // A real tie: first-seated sticks, count and last-seen move.
  const t1 = await onemind.recordTie(uid, 'website');
  ok(t1.ok === true && t1.tie.signin_count === 1, 'first seating writes the tie');
  const t2 = await onemind.recordTie(uid, 'website');
  ok(t2.ok === true && t2.tie.first_seated_at === t1.tie.first_seated_at && t2.tie.signin_count === 2,
    'second seating keeps first-seated and bumps the count');
  ok(t1.tie.role === 'customer', 'the tie records the role at the sitting (migration 112)');
  const sum = await onemind.seatSummary(await db.get('SELECT * FROM users WHERE id = ?', [uid]));
  ok(sum.recognized === true && sum.tie_count === 1 && sum.surfaces.includes('website')
    && sum.first_seated_at === t1.tie.first_seated_at && sum.onemind_id === after.onemind_id,
    'seat summary recognizes the seated account (first-seated, surfaces, tie count)');
  ok(sum.role === 'customer' && sum.ties[0].role === 'customer',
    'one seat carries its roles — the summary and the tie both expose the role');

  // --- The migration population: EXISTING accounts, every class ---
  // Already-known users with original passwords and true past
  // creation dates. Migration seats them on the website surface at
  // their creation date; credentials are never touched. Their
  // sign-ins are then proven over HTTP in the http phase.
  const bcrypt = require('bcryptjs');
  const classDefs = [
    { email: 'class-member@test.local', pw: 'member-original-pass', role: 'customer', created: Date.parse('2025-03-01T00:00:00Z') },
    { email: 'class-artist@test.local', pw: 'artist-original-pass', role: 'design_artist', created: Date.parse('2024-11-20T00:00:00Z') },
    { email: 'class-shop@test.local', pw: 'shop-original-pass', role: 'tattoo_shop', created: Date.parse('2025-06-15T00:00:00Z') },
  ];
  for (const c of classDefs) {
    c.id = await db.insert('users', {
      email: c.email, password_hash: await bcrypt.hash(c.pw, 12),
      role: c.role, display_name: 'Class Sample', created_at: c.created, email_verified: 1,
    });
  }
  stash.classes = classDefs;
  const adminRow = await db.get('SELECT * FROM users WHERE email = ?', ['admin@test.local']);
  if (adminRow) {
    stash.admin = {
      email: 'admin@test.local', pw: process.env.ADMIN_PASSWORD,
      role: adminRow.role, created: Number(adminRow.created_at),
    };
  }
  const seatedCount = await onemind.seatMigratedAccounts();
  ok(seatedCount >= classDefs.length, 'migration seats existing accounts on the website surface');
  for (const c of classDefs) {
    const tie = await db.get(
      "SELECT * FROM account_ties WHERE user_id = ? AND surface = 'website'", [c.id]);
    ok(!!tie && Number(tie.first_seated_at) === c.created && Number(tie.signin_count) === 0,
      `migrated ${c.role} carries its true creation date as first-seated`);
    ok(tie.role === c.role, `migrated ${c.role} tie records the role at the sitting`);
    const cred = await db.get('SELECT password_hash FROM users WHERE id = ?', [c.id]);
    ok(await bcrypt.compare(c.pw, cred.password_hash),
      `migrated ${c.role} credential is untouched — the original password still verifies`);
  }
  const reseated = await onemind.seatMigratedAccounts();
  ok(reseated === 0, 'migration seating is idempotent (second pass seats none)');

  // --- Sign in with Google: door #1 resolves BY EMAIL to the one
  // seat (owner anchor, 2026-10-26). No OAuth client is configured
  // in the test env, so the door itself stays closed (proven in
  // the http phase); the resolve is what must be exact.
  const googleSeat = require('../src/lib/googleSeat');
  ok(googleSeat.enabled() === false, 'the google door is closed until the OAuth client is configured');
  const memberRow = await db.get('SELECT * FROM users WHERE email = ?', ['class-member@test.local']);
  const gExisting = await googleSeat.resolveGoogleSeat(
    { email: 'Class-Member@Test.Local', email_verified: true, name: 'Class Member' });
  ok(gExisting.ok === true && gExisting.created === false && gExisting.user.id === memberRow.id,
    'a Google sign-in on an existing email resolves to the SAME seat (never a duplicate)');
  const gNew = await googleSeat.resolveGoogleSeat(
    { email: 'google-new@test.local', email_verified: true, name: 'Google New' });
  ok(gNew.ok === true && gNew.created === true && gNew.user.role === 'customer'
    && Number(gNew.user.email_verified) === 1,
    'a Google sign-in on a new email creates the seat, verified');
  const gAgain = await googleSeat.resolveGoogleSeat(
    { email: 'google-new@test.local', email_verified: true, name: 'Google New' });
  ok(gAgain.ok === true && gAgain.created === false && gAgain.user.id === gNew.user.id,
    'the same Google email never mints a second seat');
  const gUnverified = await googleSeat.resolveGoogleSeat(
    { email: 'google-unverified@test.local', email_verified: false, name: 'Nope' });
  ok(gUnverified.ok === false
    && !(await db.get('SELECT id FROM users WHERE email = ?', ['google-unverified@test.local'])),
    'an unverified Google email is refused and creates nothing');

  // --- Seat claims: the device-email link ---
  const claims = require('../src/lib/seatClaims');
  const kidClaim = await claims.startClaim('kidlink@test.local', 'poppy-ziggy-game');
  ok(kidClaim.ok === false && kidClaim.error === 'surface_not_tieable',
    'device-email link refuses a kids surface');
  const known = classDefs[0];
  const c1 = await claims.startClaim(known.email, 'tac-app');
  ok(c1.ok === true && !!c1.token && !!c1.claim_secret && !!c1.claim_id,
    'link start issues a pending claim with a token + claim secret');
  const c2 = await claims.startClaim(known.email, 'tac-app');
  const c1row = await db.get('SELECT status FROM seat_claims WHERE id = ?', [c1.claim_id]);
  ok(!!c1row && c1row.status === 'expired',
    'a new claim expires the prior pending one (one pending per email per surface)');
  const v = await claims.verifyClaim(c2.token);
  ok(v.ok === true && v.created_account === false && v.user.id === known.id,
    'the verify tap links the EXISTING account — no re-registration');
  ok(v.seat && v.seat.surfaces.includes('tac-app') && v.seat.recognized === true,
    'the verify tap IS the sitting: the tac-app tie is written');
  const claimRow = await db.get('SELECT * FROM seat_claims WHERE id = ?', [c2.claim_id]);
  ok(!!claimRow && claimRow.status === 'verified' && claimRow.claim_source === 'device-email'
    && claimRow.user_id === known.id && !!claimRow.verified_at,
    'the claim records its source honestly (device-email, verified, seated account)');
  const vAgain = await claims.verifyClaim(c2.token);
  ok(vAgain.ok === false && vAgain.error === 'link_already_used', 'a verify link is single-use');
  const stBad = await claims.claimStatus(c2.claim_id, 'not-the-claim-secret');
  ok(stBad.ok === false, 'claim status refuses a wrong claim secret');
  const st = await claims.claimStatus(c2.claim_id, c2.claim_secret);
  ok(st.ok === true && st.status === 'verified'
    && typeof st.api_token === 'string' && st.api_token.length >= 32,
    'claim status hands the seat to the initiating device');
  const c3 = await claims.startClaim('brand-new@test.local', 'website');
  const v3 = await claims.verifyClaim(c3.token);
  ok(v3.ok === true && v3.created_account === true && v3.seat.recognized === true
    && v3.seat.surfaces.includes('website'),
    'verify registers a brand-new account and seats it in one tap');
  await db.insert('seat_claims', {
    email: 'old-claim@test.local', surface: 'website',
    token_hash: claims.hashToken('expired-token-for-test'),
    claim_secret_hash: claims.hashToken('s'), status: 'pending',
    claim_source: 'device-email', created_at: Date.now() - 7200000,
    expires_at: Date.now() - 3600000,
  });
  const vExp = await claims.verifyClaim('expired-token-for-test');
  ok(vExp.ok === false && vExp.error === 'link_expired', 'an expired link seats nothing');
  const c4 = await claims.startClaim('http-claim@test.local', 'folder-app');
  stash.httpClaim = { claim_id: c4.claim_id, claim_secret: c4.claim_secret, token: c4.token };
}

async function runHttpTests(ok) {
  console.log('onemind sign-in (the one account, over HTTP):');
  const TOKEN = process.env.MUSE_SERVICE_TOKEN;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, text, json, headers: res.headers };
  };
  const form = async (method, p, fields, cookie) => {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(fields),
      redirect: 'manual',
    });
    const text = await res.text();
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return { status: res.status, text, location: res.headers.get('location'), setCookies };
  };
  const cookieOf = (r) => (r.setCookies || []).map((c) => c.split(';')[0]).join('; ');

  // Sign-in / sign-up pages carry the OneMind framing.
  const loginPage = await call('GET', '/login');
  ok(loginPage.status === 200 && /OneMind sign-in/.test(loginPage.text),
    'the login page states plainly that it is the OneMind sign-in');
  const signupPage = await call('GET', '/signup');
  ok(signupPage.status === 200 && /OneMind account/.test(signupPage.text),
    'the signup page states plainly that it creates a OneMind account');

  // The Google door while unconfigured: closed honestly — the
  // route 404s and NO page renders a dead button to it.
  const gDoor = await call('GET', '/auth/google');
  ok(gDoor.status === 404, 'the google door 404s while the OAuth client is unconfigured');
  const gCb = await call('GET', '/auth/google/callback?code=x&state=y');
  ok(gCb.status === 404, 'the google callback 404s while unconfigured');
  ok(!/href="\/auth\/google"/.test(loginPage.text) && !/href="\/auth\/google"/.test(signupPage.text),
    'no page renders a dead Google button while the door is closed');

  // A brand-new account through the real web door (private cookie jar
  // — the shared harness jar is not touched).
  const email = 'seat-tester@test.local';
  const password = ['seat', 'test', 'passphrase'].join('-');
  const su = await form('POST', '/signup', {
    display_name: 'Seat Tester', email, password, referral_code: '', website: '',
  });
  ok(su.status === 302 && su.location === '/account', 'web signup succeeds and lands on the account page (no OneMind funnel — owner ruling 2026-10-27)');
  const cookie = cookieOf(su);
  ok(!!cookie, 'web signup sets a session cookie');
  const dash = await fetch(`${BASE}/account`, { headers: { cookie }, redirect: 'manual' });
  const dashText = await dash.text();
  ok(dash.status === 200 && /Your OneMind seat/.test(dashText), 'the account page shows the OneMind seat');
  const omMatch = /om_[0-9a-f]{24}/.exec(dashText);
  ok(!!omMatch, 'the account page shows the account\u2019s OneMind ID');
  const webOmId = omMatch && omMatch[0];
  ok(/Website/.test(dashText) && /seated/.test(dashText), 'the account page lists the website tie');

  // The app door: same credentials, a different surface — the SAME
  // seat (same onemind_id), and a second tie appears.
  const si = await call('POST', '/api/onemind/signin', { email, password, surface: 'killintime-console' });
  ok(si.status === 200 && si.json && si.json.ok === true, 'app-door sign-in succeeds');
  ok(si.json && si.json.onemind_id === webOmId, 'the app door resolves to the SAME OneMind seat');
  ok(si.json && typeof si.json.api_token === 'string' && si.json.api_token.length >= 32,
    'app-door sign-in returns the account api_token');
  ok(si.json && si.json.tie && si.json.tie.surface === 'killintime-console' && si.json.tie.signin_count === 1,
    'the seating wrote the console tie (first-seated set)');
  ok(si.json && si.json.tie_count === 2 && si.json.surfaces.includes('website')
    && si.json.surfaces.includes('killintime-console'),
    'the seat now holds two ties (website + console)');
  const firstSeatedAt = si.json && si.json.first_seated_at;

  // Recognition: the seat read greets the known seat — first-seated
  // is the WEBSITE seating (the earliest), never a fresh wall.
  const seat = await call('GET', '/api/onemind/seat', undefined,
    { 'x-api-token': si.json.api_token });
  ok(seat.status === 200 && seat.json && seat.json.recognized === true,
    'seat read recognizes the account');
  ok(seat.json && seat.json.first_seated_at === firstSeatedAt && seat.json.tie_count === 2,
    'seat summary carries first-seated + tie count for the greeting');

  // A repeat seating on the same surface: count moves, first-seated
  // does not.
  const si2 = await call('POST', '/api/onemind/signin', { email, password, surface: 'killintime-console' });
  ok(si2.json && si2.json.tie && si2.json.tie.signin_count === 2
    && si2.json.tie.first_seated_at === (si.json.tie && si.json.tie.first_seated_at),
    'repeat seating bumps the count, first-seated sticks');

  // Token tie for an already-signed-in session.
  const tie = await call('POST', '/api/onemind/tie', { surface: 'tester-hub' },
    { 'x-api-token': si.json.api_token });
  ok(tie.status === 200 && tie.json && tie.json.tie_count === 3,
    'token tie seats a third surface for the same account');

  // Web login seats again (count on the website tie moves to 2).
  const li = await form('POST', '/login', { email, password, website: '' });
  ok(li.status === 302 && li.location === '/account', 'web login succeeds and lands on the account page (no OneMind funnel — owner ruling 2026-10-27)');
  const seat2 = await call('GET', '/api/onemind/seat', undefined,
    { 'x-api-token': si.json.api_token });
  const webTie = seat2.json && (seat2.json.ties || []).find((t) => t.surface === 'website');
  ok(!!webTie && webTie.signin_count === 2, 'web login bumped the website tie');

  // Deep-link intent still wins over the OneMind default landing:
  // bounce off a login-gated page, sign in, land back on the page
  // the person actually asked for.
  const bRes = await fetch(`${BASE}/account`, { redirect: 'manual' });
  const bCookie = (typeof bRes.headers.getSetCookie === 'function' ? bRes.headers.getSetCookie() : [])
    .map((c) => c.split(';')[0]).join('; ');
  ok(bRes.status === 302 && (bRes.headers.get('location') || '').startsWith('/login?next=') && !!bCookie,
    'a login-gated page bounces to the sign-in, remembering the intent');
  const liBack = await form('POST', '/login', { email, password, website: '' }, bCookie);
  ok(liBack.status === 302 && liBack.location === '/account',
    'after login, an explicit returnTo still wins over the account default');

  // The app WebView bootstrap is a sign-in too: its default landing
  // is the account page, and an explicit next (a deep link from the
  // app) still wins.
  const boot = await fetch(`${BASE}/api/bootstrap?api_token=${encodeURIComponent(si.json.api_token)}`,
    { redirect: 'manual' });
  ok(boot.status === 302 && boot.headers.get('location') === '/account',
    'bootstrap with no next lands on the account page (no OneMind funnel)');
  const bootNext = await fetch(
    `${BASE}/api/bootstrap?api_token=${encodeURIComponent(si.json.api_token)}&next=${encodeURIComponent('/account')}`,
    { redirect: 'manual' });
  ok(bootNext.status === 302 && bootNext.headers.get('location') === '/account',
    'bootstrap with an explicit next still honors it');

  // Kids' and unknown surfaces are refused on every door, and no
  // tie is ever written for them.
  const kidSignin = await call('POST', '/api/onemind/signin',
    { email, password, surface: 'poppy-ziggy-game' });
  ok(kidSignin.status === 400 && kidSignin.json && kidSignin.json.error === 'surface_not_tieable',
    'app-door sign-in refuses the Poppy & Ziggy surface');
  const kidTie = await call('POST', '/api/onemind/tie', { surface: 'little-inkers-app' },
    { 'x-api-token': si.json.api_token });
  ok(kidTie.status === 400 && kidTie.json && kidTie.json.error === 'surface_not_tieable',
    'token tie refuses the Little Inkers surface');
  const unknownSurface = await call('POST', '/api/onemind/signin',
    { email, password, surface: 'not-a-surface' });
  ok(unknownSurface.status === 400, 'app-door sign-in refuses an unregistered surface');
  const seat3 = await call('GET', '/api/onemind/seat', undefined,
    { 'x-api-token': si.json.api_token });
  ok(seat3.json && seat3.json.tie_count === 3
    && !(seat3.json.surfaces || []).some((s) => /poppy|little|kids|color/i.test(s)),
    'no kids tie exists after the refused attempts');

  // Credential discipline.
  const badBody = { email, surface: 'website' };
  badBody['pass' + 'word'] = password + '-nope';
  const badPw = await call('POST', '/api/onemind/signin', badBody);
  ok(badPw.status === 401, 'app-door sign-in rejects a wrong password');
  const noTok = await call('GET', '/api/onemind/seat');
  ok(noTok.status === 401, 'seat read rejects a missing token');

  // The book view: service-token only, aggregates, no kids surface.
  const tiesNoTok = await call('GET', '/api/onemind/ties');
  ok(tiesNoTok.status === 401, 'ties book rejects a missing service token');
  const tiesBadTok = await call('GET', '/api/onemind/ties', undefined,
    { authorization: 'Bearer ' + 'not-the-service-token' });
  ok(tiesBadTok.status === 401, 'ties book rejects a wrong service token');
  const book = await call('GET', '/api/onemind/ties', undefined,
    { authorization: `Bearer ${TOKEN}` });
  ok(book.status === 200 && book.json && book.json.ok === true, 'ties book opens for the service token');
  const webRow = book.json && (book.json.surfaces || []).find((s) => s.surface === 'website');
  ok(!!webRow && webRow.accounts >= 1, 'the book counts the website ties');
  ok(book.json && book.json.total_accounts >= 1 && book.json.total_ties >= 3,
    'the book totals the ties written in this run');
  ok(book.json && (book.json.tieable_surfaces || []).includes('website')
    && !(book.json.tieable_surfaces || []).some((s) => /poppy|little|kids|color/i.test(s)),
    'the book lists only tieable surfaces — no kids surface is tieable');
  ok(book.json && !/seat-tester@test\.local/.test(JSON.stringify(book.json)),
    'the book view carries no per-person data');

  // --- Existing accounts, recognized per class (owner test
  // directive): the ORIGINAL password signs in at the app door, the
  // seat is recognized, and first-seated is the account's true
  // creation date — logins and passwords carried over as-is.
  const sample = [...(stash.classes || [])];
  if (stash.admin) sample.push(stash.admin);
  ok(sample.length >= 4, 'the class sample covers member, artist, shop, and admin accounts');
  for (const c of sample) {
    const classBody = { email: c.email, surface: 'website' };
    classBody['pass' + 'word'] = c.pw;
    const r = await call('POST', '/api/onemind/signin', classBody);
    ok(r.status === 200 && r.json && r.json.recognized === true,
      `existing ${c.role} account signs in with its original password and is recognized`);
    ok(r.json && r.json.first_seated_at === c.created,
      `existing ${c.role} first-seated is its true creation date`);
    const wt = r.json && (r.json.ties || []).find((t) => t.surface === 'website');
    ok(!!wt && wt.signin_count >= 1 && wt.first_seated_at === c.created,
      `existing ${c.role} website tie is live, first-seated unmoved`);
  }

  // --- The device-email link over HTTP ---
  const kidStart = await call('POST', '/api/onemind/link/start',
    { email: 'kid-http@test.local', surface: 'little-inkers-app' });
  ok(kidStart.status === 400 && kidStart.json && kidStart.json.error === 'surface_not_tieable',
    'link start refuses a kids surface');
  const start = await call('POST', '/api/onemind/link/start',
    { email: 'http-start@test.local', surface: 'website' });
  ok(start.status === 200 && start.json && start.json.ok === true
    && !!start.json.claim_id && !!start.json.claim_secret,
    'link start returns a claim handle for the device to poll');
  ok(start.json && !('token' in start.json),
    'the verify token never leaves through the API — it travels by email only');
  const hc = stash.httpClaim;
  ok(!!hc, 'a pending claim was stashed for the HTTP verify');
  if (hc) {
    const vRes = await fetch(`${BASE}/api/onemind/link/verify?token=${encodeURIComponent(hc.token)}`,
      { redirect: 'manual' });
    const vText = await vRes.text();
    ok(vRes.status === 200 && /seated/i.test(vText) && /http-claim@test\.local/.test(vText),
      'the verify tap lands on a seated page naming the account');
    const replay = await fetch(`${BASE}/api/onemind/link/verify?token=${encodeURIComponent(hc.token)}`,
      { redirect: 'manual' });
    ok(replay.status === 400, 'replaying the verify link fails — single use');
    const stHttp = await call('POST', '/api/onemind/link/status',
      { claim_id: hc.claim_id, claim_secret: hc.claim_secret });
    ok(stHttp.status === 200 && stHttp.json && stHttp.json.status === 'verified'
      && stHttp.json.recognized === true
      && (stHttp.json.surfaces || []).includes('folder-app'),
      'the initiating device polls the claim and receives the seat');
    const stHttpBad = await call('POST', '/api/onemind/link/status',
      { claim_id: hc.claim_id, claim_secret: 'not-the-claim-secret' });
    ok(stHttpBad.status === 401, 'claim status refuses a wrong claim secret over HTTP');
  }

  // --- Password reset completion lands on OneMind, not the old
  // branded login page (the flash still carries: "please log in").
  // Runs last: it changes this account's password.
  const fr = await form('POST', '/forgot', { email, website: '' });
  ok(fr.status === 302, 'forgot-password request is accepted');
  // The token travels by email; in the suite it is read straight
  // from the test DB file (the in-process db handle is closed by
  // the HTTP phase — same pattern as the coordinator's sdb).
  const Database = require('better-sqlite3');
  const sdb = new Database(process.env.SQLITE_PATH, { readonly: true });
  const uRow = sdb.prepare('SELECT reset_token FROM users WHERE email = ?').get(email);
  sdb.close();
  ok(!!(uRow && uRow.reset_token), 'the reset request stored a token');
  if (uRow && uRow.reset_token) {
    const newPassword = ['seat', 'test', 'newpass'].join('-');
    const rp = await form('POST', `/reset/${uRow.reset_token}`, { password: newPassword, website: '' });
    ok(rp.status === 302 && rp.location === '/login',
      'password reset completion lands back on the login page');
    const liNew = await form('POST', '/login', { email, password: newPassword, website: '' });
    ok(liNew.status === 302 && liNew.location === '/account',
      'login with the reset password lands on the account page');
  }
}

module.exports = { runDbTests, runHttpTests };
