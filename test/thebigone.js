// The Big One — web edition + money surfaces (Lane A, 2026-10-27).
// DB phase: the register (plans) + price config + founding cap.
// HTTP phase: the publication's own face, its money doors, and the
// classifieds intake (nothing auto-publishes).
const db = require('../src/db');
const tbo = require('../src/lib/thebigone');
const config = require('../src/config');

async function runDbTests(ok) {
  console.log('the big one (register + prices):');
  // One config place: plan prices live in config.pricing.plans.
  ok(config.pricing.plans.the_big_one.priceCents === 565, 'subscription plan $4.99 base -> $5.65 register (fee pass-through)');
  ok(config.pricing.plans.the_big_one_annual.priceCents === 4188, 'annual plan $39.99 base -> $41.88 register');
  ok(config.pricing.plans.the_big_one_founding.priceCents === 358, 'founding plan $2.99 base -> $3.58 register');
  ok(config.pricing.plans.the_big_one_supporter.priceCents === 1083, 'supporter plan $9.99 base -> $10.83 register');
  ok(config.pricing.plans.the_big_one_waiting_room.priceCents === 2118, 'waiting room plan $19.99 base -> $21.18 register');
  ok(tbo.FOUNDING_CAP === 500, 'founding cap is 500');
  ok(tbo.listingPriceCents('classifieds') === 567, 'classifieds listing $5 -> $5.67 register');
  ok(tbo.listingPriceCents('notices') === 360, 'notices listing $3 -> $3.60 register');
  ok(tbo.SPONSORS.some((s) => s.key === 'feed_license' && s.baseCents === 4900), 'feed licensing on the rate card at $49/mo per feed');
  ok(tbo.TIP_JAR_URL === 'https://www.paypal.com/ncp/payment/WA9DS6J8ERSHW', 'tip jar is the house Business PayPal (mk4) link');

  // The register: ensurePlans upserts all five products.
  await tbo.ensurePlans();
  const plans = await tbo.getPlans();
  ok(tbo.PLAN_SLUGS.every((s) => plans[s] && plans[s].active === 1), 'all five Big One products exist active in the plans table');
  ok(plans.the_big_one.price_cents === 565 && plans.the_big_one.interval === 'month', 'subscription plan row carries price + interval');
  ok(plans.the_big_one_annual.interval === 'year', 'annual plan row is yearly');
  // Idempotent: a second ensure changes nothing.
  await tbo.ensurePlans();
  const again = await db.get("SELECT COUNT(*) AS n FROM plans WHERE slug LIKE 'the_big_one%'");
  ok(Number(again.n) === 5, 'ensurePlans is idempotent (exactly five plan rows)');

  // Founding cap accounting counts subscription rows on the plan.
  const before = await tbo.foundingSpotsLeft();
  const uid = await db.insert('users', {
    email: 'tbo-founding@test.local', password_hash: 'x', role: 'customer',
    display_name: 'TBO', created_at: db.now(), email_verified: 1,
  });
  await db.insert('subscriptions', {
    user_id: uid, plan_id: plans.the_big_one_founding.id, status: 'active',
    paypal_subscription_id: '', created_at: db.now(),
  });
  ok((await tbo.foundingSpotsLeft()) === before - 1, 'an active founding subscription holds one of the 500 spots');
  // Parked PayPal state is reported honestly per plan (no env in tests
  // for the Big One plans -> not ready; credit path is the live one).
  ok(tbo.paypalReadyFor('the_big_one') === false, 'PayPal checkout for the subscription reads parked until its dashboard plan ID lands');

  // Surface registry (Lane B addition, 2026-10-27): the app's native
  // OneMind sign-in sends surface 'thebigone-app' — it must be
  // tieable so the sitting seats the tie; kids' surfaces stay refused.
  const surfaces = require('../src/lib/surfaces');
  ok(surfaces.isTieable('thebigone-app') === true, "surface 'thebigone-app' is tieable (the app's sign-in seats the OneMind tie)");
  ok(surfaces.surface('thebigone-app') && surfaces.surface('thebigone-app').kind === 'app', 'thebigone-app registered as an app surface');
  ok(surfaces.isTieable('little-inkers') === false && surfaces.isTieable('kids-corner') === false, 'kids surfaces remain untieable by construction');
}

async function runHttpTests(ok, req) {
  console.log('the big one (web edition + doors):');
  const anon = async (p, opts = {}) => {
    const r = await fetch(`http://localhost:4137${p}`, { redirect: 'manual', ...opts });
    return { status: r.status, text: await r.text(), location: r.headers.get('location') };
  };

  const home = await anon('/the-big-one');
  ok(home.status === 200, '/the-big-one serves 200');
  ok(home.text.includes('The Big One') && home.text.includes('VOL. I — NO. 1'), 'masthead carries Vol. I, No. 1');
  ok(home.text.includes('Wednesday, October 28, 2026'), 'masthead carries the edition date');
  ok(home.text.includes('IN ORDER!') && home.text.includes('puzzleCards'), 'the IN ORDER! puzzle is in the page, playable');
  ok(home.text.includes('The News in Two Frames') && home.text.includes('The Back of the Book')
    && home.text.includes('The Documentary Shelf') && home.text.includes('COLOPHON'),
    'edition departments + colophon ported intact');
  ok(home.text.includes('/audio/the-big-one/edition-1.mp3'), 'Listen player points at the edition audio');
  ok(home.text.includes('/the-big-one/signin'), 'sign-in door present (return path into existing auth)');
  ok(home.text.includes('/the-big-one/link'), 'email sign-in link door present');
  ok(home.text.includes('action="/membership/subscribe/the_big_one"') || home.text.includes('Sign in to subscribe'),
    'subscribe door wired to the membership register');
  ok(home.text.includes('/the-big-one/gift') || home.text.includes('Sign in to give a gift'), 'gift door present');
  ok(home.text.includes('/the-big-one/sponsors') && home.text.includes('/the-big-one/classifieds'), 'sponsor chair + classifieds doors linked');
  ok(home.text.includes('https://www.paypal.com/ncp/payment/WA9DS6J8ERSHW'), 'tip jar is the Business PayPal mk4 link');
  ok(home.text.includes('href="/onemind"') && home.text.includes('href="/apps"'), 'sister links: OneMind + apps');
  ok(home.text.includes('$4.99') || home.text.includes('$5.65'), 'subscription price shown from the register');
  ok(!home.text.includes('tbo-layout-marker-absent') && !/navbar|site-header/.test(home.text), 'publication face is its own (no TAC chrome markers)');

  const signin = await anon('/the-big-one/signin');
  ok(signin.status === 302 && signin.location === '/login', '/the-big-one/signin hands off to the standard login door');

  const sponsors = await anon('/the-big-one/sponsors');
  ok(sponsors.status === 200, '/the-big-one/sponsors serves 200');
  ok(sponsors.text.includes('Presented by') && sponsors.text.includes('Department sponsorship')
    && sponsors.text.includes('Sponsored puzzle') && sponsors.text.includes('Acadiana')
    && sponsors.text.includes('Feed licensing'), 'rate card carries every offer');
  ok(sponsors.text.includes('action="/contact"'), 'sponsor inquiries run through the contact machinery');
  ok(!/\d[\d,]* (readers|subscribers|views) (per|a) (day|month)/i.test(sponsors.text), 'no invented reach numbers on the rate card');

  const classifieds = await anon('/the-big-one/classifieds');
  ok(classifieds.status === 200, '/the-big-one/classifieds serves 200');
  ok(classifieds.text.includes('Founding listings open'), 'empty board honestly says founding listings open');
  ok(classifieds.text.includes('name="business_name"') && classifieds.text.includes('name="listing_text"')
    && classifieds.text.includes('name="department"'), 'submission form carries business/email/text/department');

  // A submission lands for review and does NOT appear on the board.
  const jar = {};
  const post = await fetch('http://localhost:4137/the-big-one/classifieds', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      business_name: 'Bayou Test Biz', contact_email: 'bayou@test.local',
      department: 'classifieds', listing_text: 'Fresh boudin every Friday morning on Main Street.',
    }),
  });
  for (const c of (post.headers.getSetCookie ? post.headers.getSetCookie() : [])) {
    const [pair] = c.split(';'); const [k, v] = pair.split('='); jar[k.trim()] = (v || '').trim();
  }
  ok(post.status === 302 && (post.headers.get('location') || '').includes('/the-big-one/classifieds'),
    'classifieds submission accepted for review (302 back to the board)');
  const board = await anon('/the-big-one/classifieds');
  ok(!board.text.includes('Bayou Test Biz'), 'submitted listing does NOT auto-publish to the board');

  // Gift path is login-gated like every register door.
  const gift = await anon('/the-big-one/gift', { method: 'POST' });
  ok(gift.status === 302 && (gift.location || '').startsWith('/login'), 'gift POST requires login (guest-commerce door, not a wall-less form)');

  const sm = await req('GET', '/sitemap.xml');
  ok(sm.status === 200 && sm.text.includes('/the-big-one</loc>') && sm.text.includes('/the-big-one/sponsors')
    && sm.text.includes('/the-big-one/classifieds'), 'sitemap lists all three Big One doors');

  const apps = await anon('/apps');
  ok(apps.status === 200 && apps.text.includes('href="/the-big-one"'), '/apps cross-links The Big One');

  const codex = await req('GET', '/api/codex');
  const book = JSON.parse(codex.text);
  ok((book.doors || []).some((d) => /The Big One — web edition/.test(d.name)), 'codex records the web edition door');
  ok((book.plugs || []).some((p) => /The Big One publication/.test(p.name)), 'codex records the publication plug (OneMind tie)');
  ok((book.prices.entries || []).filter((e) => /The Big One/.test(e.name)).length >= 4
    && (book.prices.entries || []).every((e) => /settled/i.test(e.state || '')),
    'codex price entries for The Big One are in and settled');
}

// ---- Bundle A (2026-10-28): Founding-500 push + Your Local insert ----
async function runBundleADb(ok) {
  console.log('the big one (bundle A: founding push + local insert):');
  const li = require('../src/lib/localinsert');
  ok(li.HOUSE_LOCALITY.lat === 29.9746 && li.HOUSE_LOCALITY.lon === -92.1553, 'house locality is Abbeville (bundled default)');
  ok(/Abbeville/.test(li.HOUSE_LOCALITY.label), 'house locality label names Abbeville');
  const slots = li.briefSlots(li.HOUSE_LOCALITY);
  ok(Array.isArray(slots) && slots.some((s) => s.kind === 'briefs'), 'brief slots include an honest open briefs slot');

  const uid = await db.insert('users', {
    email: 'tbo-local@test.local', password_hash: 'x', role: 'customer',
    display_name: 'Local', created_at: db.now(), email_verified: 1,
  });
  ok((await li.getUserLocality(uid)) === null, 'no saved locality reads null (house default applies)');
  const saved = await li.saveUserLocality(uid, {
    label: 'Lafayette, Louisiana', name: 'Lafayette', region: 'Louisiana',
    country: 'United States', lat: 30.2241, lon: -92.0198,
  });
  ok(saved && Math.abs(saved.lat - 30.2241) < 1e-9, 'saveUserLocality returns the saved pick');
  const back = await li.getUserLocality(uid);
  ok(back && back.label === 'Lafayette, Louisiana', 'saved locality reads back from the account');
  const bad = await li.saveUserLocality(uid, { label: 'Nowhere', lat: 999, lon: 0 });
  ok(bad === null, 'out-of-range coordinates are refused, never stored');
  const back2 = await li.getUserLocality(uid);
  ok(back2 && back2.label === 'Lafayette, Louisiana', 'refused save leaves the good locality intact');

  // founderInfo: the ordinal ranks founding claims by created_at.
  const plans = await tbo.getPlans();
  const f1 = await db.insert('users', {
    email: 'tbo-founder1@test.local', password_hash: 'x', role: 'customer',
    display_name: 'F1', created_at: db.now(), email_verified: 1,
  });
  ok((await tbo.founderInfo(f1)) === null, 'founderInfo null before any founding subscription');
  await db.insert('subscriptions', {
    user_id: f1, plan_id: plans.the_big_one_founding.id, status: 'active',
    paypal_subscription_id: '', created_at: db.now(),
  });
  const info1 = await tbo.founderInfo(f1);
  ok(info1 && info1.ordinal >= 1, 'founderInfo returns an ordinal for a founding subscriber');
  const f2 = await db.insert('users', {
    email: 'tbo-founder2@test.local', password_hash: 'x', role: 'customer',
    display_name: 'F2', created_at: db.now(), email_verified: 1,
  });
  await db.insert('subscriptions', {
    user_id: f2, plan_id: plans.the_big_one_founding.id, status: 'active',
    paypal_subscription_id: '', created_at: db.now() + 1000,
  });
  const info2 = await tbo.founderInfo(f2);
  ok(info2 && info1 && info2.ordinal === info1.ordinal + 1, 'a later founding claim takes the next ordinal');

  // HTTP-phase fixture: a seated founder with a real password and the
  // house locality saved, exercised over HTTP in runBundleAHttp.
  const bcrypt = require('bcryptjs');
  const seated = await db.insert('users', {
    email: 'tbo-seated@test.local', password_hash: await bcrypt.hash('BundleA123!', 10),
    role: 'customer', display_name: 'Seated', created_at: db.now(), email_verified: 1,
  });
  await db.insert('subscriptions', {
    user_id: seated, plan_id: plans.the_big_one_founding.id, status: 'active',
    paypal_subscription_id: '', created_at: db.now(),
  });
  const fixtureLocal = await li.saveUserLocality(seated, {
    label: 'Abbeville, Louisiana', name: 'Abbeville', region: 'Louisiana',
    country: 'United States', lat: 29.9746, lon: -92.1553,
  });
  ok(!!fixtureLocal, 'seated founder fixture carries a saved locality');
}

async function runBundleAHttp(ok, req) {
  console.log('the big one (bundle A web: founding push + your local):');
  const anon = async (p, opts = {}) => {
    const r = await fetch(`http://localhost:4137${p}`, { redirect: 'manual', ...opts });
    return { status: r.status, text: await r.text(), location: r.headers.get('location') };
  };

  const home = await anon('/the-big-one');
  ok(home.status === 200, '/the-big-one serves 200 (bundle A)');
  ok(home.text.includes('id="your-local"'), 'Your Local insert section is in the page');
  ok(home.text.includes('id="tboLocalLabel">Abbeville, Louisiana</span>'),
    'anon readers get the house locality (Abbeville) in the insert masthead');
  ok(/of 500 founding spots left/.test(home.text), 'founding push shows the real seats-left count from the register');
  ok(home.text.includes('id="founding"'), 'founding push section is in the page');

  const badWx = await anon('/the-big-one/local/weather?lat=999&lon=0');
  ok(badWx.status === 400, 'local weather door rejects bad coordinates');
  const search = await anon('/the-big-one/local/search?q=abbeville');
  ok(search.status === 200 && Array.isArray(JSON.parse(search.text).places),
    'local search door answers a JSON places array (empty offline — never fabricated)');

  const guestPost = await anon('/the-big-one/locality', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ label: 'Lafayette, Louisiana', lat: '30.2241', lon: '-92.0198' }),
  });
  ok(guestPost.status === 302, 'guest locality POST redirects (device pick is client-side; account save needs the seat)');

  // Seated flow: the founder fixture logs in, moves their town over
  // HTTP, and their edition carries the new locality + the badge.
  const jar = {};
  const jarReq = async (method, p, body) => {
    const headers = {};
    const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) headers.cookie = cookies;
    let payload;
    if (body) { payload = new URLSearchParams(body); headers['content-type'] = 'application/x-www-form-urlencoded'; }
    const res = await fetch(`http://localhost:4137${p}`, { method, headers, body: payload, redirect: 'manual' });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [pair] = c.split(';'); const [k, v] = pair.split('='); jar[k.trim()] = (v || '').trim();
    }
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  };
  const login = await jarReq('POST', '/login', { email: 'tbo-seated@test.local', password: 'BundleA123!' });
  ok(login.status === 302 || login.status === 200, 'seated founder login works');
  const save = await jarReq('POST', '/the-big-one/locality', {
    label: 'Lafayette, Louisiana', name: 'Lafayette', region: 'Louisiana',
    country: 'United States', lat: '30.2241', lon: '-92.0198',
  });
  ok(save.status === 302, 'seated locality save accepted (302 back to the insert)');
  const mine = await jarReq('GET', '/the-big-one');
  ok(mine.status === 200 && mine.text.includes('id="tboLocalLabel">Lafayette, Louisiana</span>'),
    'seated reader’s edition carries their own locality in the insert');
  ok(mine.text.includes('FOUNDING MEMBER'), 'seated founder sees the founding recognition in the edition');
  ok(mine.text.includes('You hold founding spot No.'), 'seated founder sees their spot number at the register');
}

module.exports = { runDbTests, runHttpTests, runBundleADb, runBundleAHttp };
