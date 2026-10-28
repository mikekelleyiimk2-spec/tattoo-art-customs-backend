// CannaDash founding partner fees (Bundle C Build 1, 2026-10-28).
// The coordinator (test/run.js) wires this in; it also runs standalone:
//   node test/cannadashFounding.js
// Covers the owner-strike gate as executable assertions:
//  - the fee config exposes tiers + pricesLive:false + the
//    'PENDING OWNER STRIKE' status;
//  - the founding tiers carry the assessed terms from spec §3
//    (founding monthly, standard monthly, per-order toll, 12-month lock);
//  - the public fee rows withhold EVERY assessed figure while
//    pricesLive is false — structure visible, numbers withheld;
//  - the founding page handler renders onemind/cannadash-founding in
//    layout-onemind, and the rendered page carries the lock language,
//    the cohort terms, the fee table with withheld price cells, and
//    the existing POST /cannadash/join partner application path —
//    and NO dollar figure anywhere;
//  - the CannaDash door links the founding page.
const fs = require('fs');
const path = require('path');

const founding = require('../src/lib/cannadashFounding');

function mockRes() {
  return {
    locals: {}, rendered: null, redirected: null,
    render(v, l) { this.rendered = { v, l }; },
    redirect(c, u) { this.redirected = { c, u }; },
  };
}

async function checkAll(ok) {
  console.log('cannadash founding fees:');

  // --- Config: the strike gate ---
  ok(founding.pricesLive === false, 'founding prices are NOT live (pricesLive === false)');
  ok(founding.status === 'PENDING OWNER STRIKE' && founding.STATUS === 'PENDING OWNER STRIKE',
    "founding fee status is 'PENDING OWNER STRIKE'");
  ok(Array.isArray(founding.tiers) && founding.tiers.length >= 2, 'config exposes the partner tiers');

  // --- Config: assessed terms align to spec §3 ---
  const ft = founding.foundingTier();
  ok(!!ft && ft.id === 'founding-partner', 'founding partner tier exists');
  ok(typeof ft.assessedMonthly === 'number' && ft.assessedMonthly > 0,
    'founding tier carries an assessedMonthly figure (config/report only)');
  ok(ft.assessedMonthly === 49, 'founding assessedMonthly is the spec §3 founding rate ($49/mo)');
  ok(ft.lockMonths === 12, 'founding rate locks for 12 months (spec §3)');
  ok(typeof ft.assessedPerOrderPercent === 'number' && ft.assessedPerOrderPercent === 15,
    'founding per-order toll is the spec §3 toll (15%)');
  ok(typeof ft.cohortCapLocations === 'number' && ft.cohortCapLocations > 0,
    'founding cohort carries a location cap');
  ok(ft.includes.some((i) => /listing/i.test(i)) && ft.includes.some((i) => /badge/i.test(i)),
    'founding tier includes launch listing + founding badge');
  const st = founding.tier('standard-partner');
  ok(!!st && st.assessedMonthly === 99, 'standard tier is the spec §3 standard rate ($99/mo) the founding rate locks against');

  // --- Public rows: structure visible, numbers withheld ---
  const rows = founding.publicFeeRows();
  ok(rows.length >= 3, 'public fee table has the structure rows (subscription, per-order toll, standard reference)');
  ok(rows.every((r) => r.priceCell === founding.WITHHELD_LABEL),
    'every public price cell is the withheld label while pricesLive is false');
  const rowsText = JSON.stringify(rows);
  ok(!/\$\s?\d/.test(rowsText), 'public fee rows contain NO dollar figure while pricesLive is false');
  ok(!/\d+(?:\.\d+)?\s?%/.test(rowsText), 'public fee rows contain NO percentage figure while pricesLive is false');
  const offer = founding.publicFoundingOffer();
  ok(offer.pricesLive === false && offer.lockMonths === 12 && /locked at joining/i.test(offer.lockPromise),
    'public founding offer carries the lock promise + 12-month term, prices withheld');
  ok(!/\$\s?\d/.test(JSON.stringify(offer)), 'public founding offer contains NO dollar figure');

  // --- Handler: renders the founding face on the standalone router ---
  const standalone = require('../src/routes/onemindStandalone');
  ok(typeof standalone.handlers.cannadashFoundingHandler === 'function',
    'standalone router exports the founding handler');
  const routerSrc = fs.readFileSync(path.join(__dirname, '../src/routes/onemindStandalone.js'), 'utf8');
  ok(routerSrc.includes("router.get('/cannadash/founding', cannadashFoundingHandler)"),
    "standalone router mounts GET /cannadash/founding");
  // --- Main host: the shop's site router mounts the SAME handlers ---
  // (Regression pin for the 2026-10-28 money-sweep find: the founding
  // page was registered only on the standalone router, which index.js
  // mounts only under ONEMIND_STANDALONE=on, so /cannadash/founding
  // 404'd on tattoo-art-customs.onrender.com while serving on the
  // OneMind host.)
  const siteSrc = fs.readFileSync(path.join(__dirname, '../src/routes/site.js'), 'utf8');
  ok(siteSrc.includes("router.get('/cannadash/founding', cannadashStandalone.handlers.cannadashFoundingHandler)"),
    'site router mounts GET /cannadash/founding with the shared standalone handler');
  ok(siteSrc.includes("router.post('/cannadash/join', formLimiter, checkHoneypot, cannadashStandalone.handlers.cannadashJoinHandler)"),
    'site router mounts POST /cannadash/join with the shared standalone handler (founding form works on the main host)');

  const mr = mockRes();
  standalone.handlers.cannadashFoundingHandler({}, mr);
  ok(mr.rendered && mr.rendered.v === 'onemind/cannadash-founding'
    && mr.rendered.l.layout === 'layout-onemind',
  'founding handler renders onemind/cannadash-founding in layout-onemind');
  ok(Array.isArray(mr.rendered.l.feeRows) && mr.rendered.l.feeRows.length === rows.length
    && mr.rendered.l.pricesLive === false,
  'founding handler passes the gated fee rows + pricesLive:false to the view');

  // --- Rendered page: lock language, fee table, application path ---
  const ejs = require('ejs');
  const viewPath = path.join(__dirname, '../src/views/onemind/cannadash-founding.ejs');
  const html = await ejs.renderFile(viewPath, { ...mr.rendered.l });
  ok(html.includes('Founding partners'), 'founding page carries the founding partner offer');
  ok(/rate is locked at joining/i.test(html) && html.includes('12 months'),
    'founding page carries the lock language (locked at joining, 12 months)');
  ok(html.includes(founding.WITHHELD_LABEL), 'founding page price cells read the withheld label');
  ok(html.includes('<table') && html.includes('Platform subscription') && html.includes('Per-order toll'),
    'founding page renders the real fee table from config (structure visible)');
  ok(!/\$\s?\d/.test(html) && !html.includes('$'),
    'founding page contains NO dollar figure while pricesLive is false');
  ok(!/\d+(?:\.\d+)?\s?% of order/.test(html),
    'founding page contains NO per-order percentage figure while pricesLive is false');
  ok(html.includes('action="/cannadash/join"') && html.includes('name="role" value="partner"'),
    'founding page application reuses POST /cannadash/join with role=partner (no second intake)');
  ok(html.includes('/cannadash?join=partner#join'),
    'founding page links the existing door join with role=partner');
  ok(/not live in any market/i.test(html) && /Licensed dispensaries only/i.test(html),
    'founding page stays honest: not live yet, licensed dispensaries only');

  // --- The door links the founding page ---
  const doorView = fs.readFileSync(path.join(__dirname, '../src/views/onemind/door-cannadash.ejs'), 'utf8');
  ok(doorView.includes('href="/cannadash/founding"') && doorView.includes('Founding partners'),
    'cannadash door carries a Founding partners section linking /cannadash/founding');
}

// House wiring: the DB phase runs the checks pre-close (they need no DB
// rows — config + handler + template only), and the HTTP phase repeats
// them so a coordinator wiring either entry point gets full coverage.
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
  checkAll(ok).then(() => {
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nall cannadash founding tests passed');
    process.exit(failures ? 1 : 0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
