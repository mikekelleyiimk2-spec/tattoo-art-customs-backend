// CannaDash Driver early outreach (2026-10-28).
// The coordinator (test/run.js) wires this in; it also runs standalone:
//   node test/cannadashDriver.js
// Covers:
//  - the production registry carries the founding driver build
//    (vc3 / 1.0.2 / the shipped sha, free — no gated flag);
//  - roster lib: parseArea on free-text areas, the PURE summarize
//    (totals, by-state / by-city grouping + sort, withApp counted
//    from the app-holder email set, NO name/email strings anywhere
//    in the output), roster() counting drive rows only, and
//    driverApkReady() tracking the registry entry (the bytes live in
//    the canonical host's store — entry absent -> false, present -> true);
//  - the door's new driver gate: drive signups need driver_ok AFTER
//    the name/email/age checks (the pre-existing drive error paths
//    keep their errors), and a gated signup persists NOTHING;
//  - the door + admin view markers for the install CTA, the driver
//    attestation, and the counts-only roster page.
const fs = require('fs');
const os = require('os');
const path = require('path');

const roster = require('../src/lib/cannadashRoster');
const DRIVER_SHA = '55237e708fd872551bbcb67096fc3292376a8734e424e5fa3da2bdf14b8141d9';

function mockRes() {
  return {
    locals: {}, rendered: null, redirected: null,
    render(v, l) { this.rendered = { v, l }; },
    redirect(c, u) { this.redirected = { c, u }; },
  };
}
const joinRes = () => ({ locals: {}, redirected: null, redirect(c, u) { this.redirected = { c, u }; } });

async function checkAll(ok) {
  console.log('cannadash driver (roster + gate + apk):');
  const db = require('../src/db');
  const config = require('../src/config');
  const standalone = require('../src/routes/onemindStandalone');
  // Unique per invocation: runDbTests and runUnitTests both run this
  // full set against the same shared test DB (cannadashFounding style).
  const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;

  // --- Registry: the founding driver build, exactly as shipped ---
  const prodRegistry = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../src/data/app-updates.json'), 'utf8'));
  const entry = prodRegistry[roster.DRIVER_PACKAGE];
  ok(roster.DRIVER_PACKAGE === 'com.usefulappz.cannadashdriver', 'driver package id is com.usefulappz.cannadashdriver');
  ok(roster.DRIVER_APK_URL === 'https://tattoo-art-customs.onrender.com/api/apps/com.usefulappz.cannadashdriver/apk', 'driver apk URL is the canonical host app-updates store route');
  ok(!!entry, 'production registry carries the CannaDash Driver entry');
  ok(entry && entry.versionCode === 3 && entry.versionName === '1.0.2',
    'driver registry entry is vc3 / 1.0.2');
  ok(entry && entry.sha256 === DRIVER_SHA && entry.sizeBytes === 386835,
    'driver registry entry carries the shipped sha256 + size');
  ok(entry && entry.apkUrl === 'https://tattoo-art-customs.onrender.com/api/apps/com.usefulappz.cannadashdriver/apk'
    && entry.publishedAt === '2026-10-28T13:45:00Z' && !entry.gated,
  'driver registry entry points at the canonical-host apk route and is FREE (no gated flag)');

  // --- parseArea ---
  const pa = roster.parseArea;
  ok(JSON.stringify(pa('Lafayette, LA')) === JSON.stringify({ city: 'Lafayette', state: 'LA' }),
    'parseArea: "Lafayette, LA" -> Lafayette / LA');
  ok(JSON.stringify(pa('Austin, Texas')) === JSON.stringify({ city: 'Austin', state: 'Texas' }),
    'parseArea: "Austin, Texas" -> Austin / Texas');
  ok(JSON.stringify(pa('Nowhere')) === JSON.stringify({ city: 'Nowhere', state: 'Unknown' }),
    'parseArea: "Nowhere" (no comma) -> city Nowhere / state Unknown');
  ok(JSON.stringify(pa('')) === JSON.stringify({ city: 'Unknown', state: 'Unknown' }),
    'parseArea: empty -> Unknown / Unknown');
  ok(JSON.stringify(pa(null)) === JSON.stringify({ city: 'Unknown', state: 'Unknown' }),
    'parseArea: null -> Unknown / Unknown');
  ok(pa('Lafayette, la').state === 'LA' && pa('Austin, texas').state === 'Texas',
    'parseArea: 2-letter states uppercase, long states title-case');

  // --- summarize (pure) ---
  const rows = [
    { area: 'Lafayette, LA', email: 'alpha@test.local', name: 'Secret Alpha' },
    { area: 'Lafayette, LA', email: 'bravo@test.local', name: 'Secret Bravo' },
    { area: 'Austin, TX', email: 'charlie@test.local', name: 'Secret Charlie' },
    { area: 'Baton Rouge, LA', email: 'delta@test.local', name: 'Secret Delta' },
  ];
  const sum = roster.summarize(rows, ['alpha@test.local', 'charlie@test.local']);
  ok(sum.total === 4 && sum.withApp === 2, 'summarize: total + withApp counted from the app-holder email set');
  ok(roster.summarize(rows, new Set(['alpha@test.local'])).withApp === 1,
    'summarize: app-holder set may be a Set as well as an array');
  ok(sum.byState.length === 2 && sum.byState[0].state === 'LA' && sum.byState[0].count === 3
    && sum.byState[1].state === 'TX' && sum.byState[1].count === 1,
  'summarize: byState groups and sorts by count desc');
  ok(sum.byCity[0].city === 'Lafayette' && sum.byCity[0].state === 'LA' && sum.byCity[0].count === 2
    && sum.byCity.length === 3,
  'summarize: byCity groups city+state and sorts by count desc');
  const sumJson = JSON.stringify(sum);
  ok(!sumJson.includes('@test.local') && !sumJson.includes('Secret'),
    'summarize: NO email or name strings anywhere in the output (counts only)');
  const empty = roster.summarize([], []);
  ok(empty.total === 0 && empty.withApp === 0 && empty.byState.length === 0 && empty.byCity.length === 0,
    'summarize: empty input -> zeroed roster');

  // --- driverApkReady: registry-entry gate (bytes live in the
  // canonical host's app-updates store; see lib/cannadashRoster.js) ---
  const savedReg = process.env.APP_UPDATES_REGISTRY;
  const tmpReg = path.join(os.tmpdir(), `cd-driver-registry-${uniq}.json`);
  try {
    fs.writeFileSync(tmpReg, JSON.stringify({ 'com.example.other': { versionCode: 1 } }, null, 2));
    process.env.APP_UPDATES_REGISTRY = tmpReg;
    ok(roster.driverApkReady() === false,
      'driverApkReady: false when the registry has no driver entry');
    fs.writeFileSync(tmpReg, JSON.stringify({ [roster.DRIVER_PACKAGE]: entry }, null, 2));
    ok(roster.driverApkReady() === true,
      'driverApkReady: true once the registry entry is present');
    fs.writeFileSync(tmpReg, JSON.stringify({}, null, 2));
    ok(roster.driverApkReady() === false, 'driverApkReady: false again when the entry goes away');
  } finally {
    if (savedReg === undefined) delete process.env.APP_UPDATES_REGISTRY;
    else process.env.APP_UPDATES_REGISTRY = savedReg;
    try { fs.unlinkSync(tmpReg); } catch (e) { /* already gone */ }
  }

  // --- Door handler: 'driver' is an allowed join error, apk local wired ---
  let mr = mockRes();
  standalone.handlers.cannadashDoorHandler({ query: { error: 'driver', join: 'drive' } }, mr);
  ok(mr.rendered && mr.rendered.l.joinError === 'driver' && mr.rendered.l.joinRole === 'drive',
    "door handler allowlists join error 'driver'");
  ok(mr.rendered && 'driverApkUrl' in mr.rendered.l
    && mr.rendered.l.driverApkUrl === (roster.driverApkReady() ? roster.DRIVER_APK_URL : null),
  'door handler passes driverApkUrl (the store route when ready, null otherwise)');
  const routeSrc = fs.readFileSync(path.join(__dirname, '../src/routes/onemindStandalone.js'), 'utf8');
  ok(routeSrc.includes("role === 'drive' && !body.driver_ok") && routeSrc.includes('error=driver'),
    'join handler carries the driver_ok gate');

  // --- Join handler: the driver gate sits AFTER name/email/age ---
  let jr = joinRes();
  await standalone.handlers.cannadashJoinHandler({ body: {
    role: 'drive', name: 'TEST Driver', email: 'not-an-email', area: '', detail: '', age_ok: '1', website: '',
  } }, jr);
  ok(jr.redirected && jr.redirected.u.includes('error=email'),
    'driver gate order: bad email still fails on email first (pre-existing path)');
  jr = joinRes();
  await standalone.handlers.cannadashJoinHandler({ body: {
    role: 'drive', name: 'TEST Driver', email: `gate-age-${uniq}@test.local`, area: '', detail: '', driver_ok: '1', website: '',
  } }, jr);
  ok(jr.redirected && jr.redirected.u.includes('error=age'),
    'driver gate order: missing 21+ still fails on age (checked before driver_ok)');

  const noDriverEmail = `nodriver-${uniq}@test.local`;
  jr = joinRes();
  await standalone.handlers.cannadashJoinHandler({ body: {
    role: 'drive', name: 'TEST Driver', email: noDriverEmail,
    area: 'Lafayette, LA', detail: '', age_ok: '1', website: '',
  } }, jr);
  ok(jr.redirected && jr.redirected.u === '/cannadash?join=drive&error=driver#join',
    'drive signup WITHOUT driver_ok redirects with error=driver');
  ok(!(await db.get('SELECT id FROM cannadash_waitlist WHERE email = ?', [noDriverEmail])),
    'drive signup WITHOUT driver_ok persists NO row');

  const driverEmail = `driverok-${uniq}@test.local`;
  jr = joinRes();
  await standalone.handlers.cannadashJoinHandler({ body: {
    role: 'drive', name: 'TEST Driver', email: driverEmail,
    area: 'Lafayette, LA', detail: 'TEST car', age_ok: '1', driver_ok: '1', website: '',
  } }, jr);
  ok(jr.redirected && jr.redirected.u === '/cannadash?joined=drive#join',
    'drive signup WITH age_ok + driver_ok joins the drive list');
  const driverRow = await db.get('SELECT * FROM cannadash_waitlist WHERE role = ? AND email = ?',
    ['drive', driverEmail]);
  ok(!!driverRow && driverRow.area === 'Lafayette, LA', 'drive signup WITH driver_ok persists the row');

  const orderEmail = `orderok-${uniq}@test.local`;
  jr = joinRes();
  await standalone.handlers.cannadashJoinHandler({ body: {
    role: 'order', name: 'TEST Customer', email: orderEmail,
    area: 'Lafayette, LA', detail: '', age_ok: '1', website: '',
  } }, jr);
  ok(jr.redirected && jr.redirected.u === '/cannadash?joined=order#join',
    'order signup is unaffected by the driver_ok gate (no driver_ok needed)');

  // --- roster(): drive rows only, relative to whatever the DB holds ---
  const city = `Roster${uniq.replace(/[^a-z0-9]/gi, '')}`;
  const rBefore = await roster.roster([]);
  await db.insert('cannadash_waitlist', {
    role: 'drive', name: 'TEST Roster One', email: `roster1-${uniq}@test.local`,
    area: `${city}, LA`, detail: '', source: 'test',
  });
  await db.insert('cannadash_waitlist', {
    role: 'drive', name: 'TEST Roster Two', email: `roster2-${uniq}@test.local`,
    area: `${city}, LA`, detail: '', source: 'test',
  });
  await db.insert('cannadash_waitlist', {
    role: 'order', name: 'TEST Roster Decoy', email: `rosterdecoy-${uniq}@test.local`,
    area: `${city}, LA`, detail: '', source: 'test',
  });
  const rAfter = await roster.roster([`roster1-${uniq}@test.local`]);
  ok(rAfter.total === rBefore.total + 2, 'roster: total counts drive-role rows only (order decoy excluded)');
  ok(rAfter.withApp === rBefore.withApp + 1, 'roster: withApp counts rows whose email is in the app-holder set');
  const cityRow = rAfter.byCity.find((c) => c.city === city);
  ok(!!cityRow && cityRow.state === 'LA' && cityRow.count === 2, 'roster: byCity carries the seeded city pair');
  ok(!JSON.stringify(rAfter).includes('@test.local'), 'roster: output carries no emails');
  await db.query('DELETE FROM cannadash_waitlist WHERE email IN (?, ?, ?, ?, ?)',
    [driverEmail, orderEmail, `roster1-${uniq}@test.local`, `roster2-${uniq}@test.local`, `rosterdecoy-${uniq}@test.local`]);

  // --- Views: door install block + attestation, admin roster page ---
  const doorView = fs.readFileSync(path.join(__dirname, '../src/views/onemind/door-cannadash.ejs'), 'utf8');
  for (const marker of ['Install the driver app now', 'name="driver_ok"', "valid driver's license",
    'Drivers need all three boxes checked', 'Development build (v1.0.2)',
    'CannaDash Driver tester list', "joined === 'drive'"]) {
    ok(doorView.includes(marker), `cannadash door face carries ${marker}`);
  }
  const adminViewPath = path.join(__dirname, '../src/views/admin/cannadash-drivers.ejs');
  ok(fs.existsSync(adminViewPath), 'admin cannadash-drivers view exists');
  const adminView = fs.readFileSync(adminViewPath, 'utf8');
  ok(adminView.includes('No founding drivers yet') && adminView.includes('no driver names or emails'),
    'admin roster view carries the honest empty state + the counts-only privacy note');
  const adminSrc = fs.readFileSync(path.join(__dirname, '../src/routes/admin.js'), 'utf8');
  ok(adminSrc.includes("router.get('/cannadash-drivers'") && adminSrc.includes("router.get('/cannadash-drivers.json'"),
    'admin router mounts GET /cannadash-drivers and /cannadash-drivers.json');
}

// House wiring (cannadashFounding style): both entry points run the
// full set, so a coordinator wiring either one gets full coverage.
async function runDbTests(ok) { await checkAll(ok); }
async function runUnitTests(ok) { await checkAll(ok); }
async function runHttpTests(ok) { await checkAll(ok); }

module.exports = { runDbTests, runUnitTests, runHttpTests };

if (require.main === module) {
  let failures = 0;
  const ok = (cond, name) => {
    if (cond) console.log('  ok -', name);
    else { failures++; console.error('  FAIL -', name); }
  };
  (async () => {
    const { migrate } = require('../src/db/migrate');
    await migrate(); // migrate() inits the db layer itself
    await checkAll(ok);
    await require('../src/db').close();
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nall cannadash driver tests passed');
    process.exit(failures ? 1 : 0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
