// CannaDash founding partner fees (Bundle C Build 1, 2026-10-28).
// The coordinator (test/run.js) wires this in; it also runs standalone:
//   node test/cannadashFounding.js
// Covers the owner-strike gate as executable assertions. The gate
// held from 2026-10-28 until the owner struck the price on
// 2026-10-30 at the assessed figures; these assertions now pin the
// STRUCK state:
//  - the fee config exposes tiers + pricesLive:true + the
//    'OWNER-STRUCK — LIVE (2026-10-30)' status;
//  - the founding tiers carry the struck terms from spec §3
//    (founding monthly, standard monthly, per-order toll, 12-month lock);
//  - the public fee rows render the struck figures ($49/mo founding,
//    15% per-order toll, $99/mo standard) — no withheld label anywhere;
//  - the founding page handler renders onemind/cannadash-founding in
//    layout-onemind, and the rendered page carries the lock language,
//    the cohort terms, the fee table with the live price cells, and
//    the existing POST /cannadash/join partner application path;
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

  // --- Config: the strike gate (struck 2026-10-30) ---
  ok(founding.pricesLive === true, 'founding prices are LIVE (pricesLive === true, owner strike 2026-10-30)');
  ok(founding.status === 'OWNER-STRUCK — LIVE (2026-10-30)' && founding.STATUS === 'OWNER-STRUCK — LIVE (2026-10-30)',
    "founding fee status is 'OWNER-STRUCK — LIVE (2026-10-30)'");
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

  // --- Public rows: structure AND the struck figures, live ---
  const rows = founding.publicFeeRows();
  ok(rows.length >= 3, 'public fee table has the structure rows (subscription, per-order toll, standard reference)');
  const cell = (k) => (rows.find((r) => r.key === k) || {}).priceCell;
  ok(cell('platform_subscription') === '$49/mo per location',
    'founding subscription cell renders the struck $49/mo per location');
  ok(cell('per_order_toll') === '15% of order subtotal',
    'per-order toll cell renders the struck 15% of order subtotal');
  ok(cell('standard_subscription_reference') === '$99/mo per location',
    'standard reference cell renders the struck $99/mo per location');
  ok(rows.every((r) => r.priceCell !== founding.WITHHELD_LABEL),
    'no public price cell carries the withheld label after the strike');
  const offer = founding.publicFoundingOffer();
  ok(offer.pricesLive === true && offer.lockMonths === 12 && /locked at joining/i.test(offer.lockPromise),
    'public founding offer carries the lock promise + 12-month term, prices live');
  ok(!/\$\s?\d/.test(JSON.stringify(offer)), 'public founding offer itself carries structure only (figures render via the fee rows)');

  // --- Handler: renders the founding face on the standalone router ---
  const standalone = require('../src/routes/onemindStandalone');
  ok(typeof standalone.handlers.cannadashFoundingHandler === 'function',
    'standalone router exports the founding handler');
  const routerSrc = fs.readFileSync(path.join(__dirname, '../src/routes/onemindStandalone.js'), 'utf8');
  ok(routerSrc.includes("router.get('/herbhaul/founding', cannadashFoundingHandler)"),
    "standalone router mounts GET /herbhaul/founding");
  // --- Main host: the shop's site router mounts the SAME handlers ---
  // (Regression pin for the 2026-10-28 money-sweep find: the founding
  // page was registered only on the standalone router, which index.js
  // mounts only under ONEMIND_STANDALONE=on, so /cannadash/founding
  // 404'd on tattoo-art-customs.onrender.com while serving on the
  // OneMind host.)
  const siteSrc = fs.readFileSync(path.join(__dirname, '../src/routes/site.js'), 'utf8');
  ok(siteSrc.includes("router.get('/herbhaul/founding', cannadashStandalone.handlers.cannadashFoundingHandler)"),
    'site router mounts GET /herbhaul/founding with the shared standalone handler');
  ok(siteSrc.includes("router.post('/herbhaul/join', formLimiter, checkHoneypot, cannadashStandalone.handlers.cannadashJoinHandler)"),
    'site router mounts POST /herbhaul/join with the shared standalone handler (founding form works on the main host)');
  // Rename pins (2026-10-28): pre-rename addresses redirect, never 404.
  ok(routerSrc.includes("router.get('/cannadash'") && routerSrc.includes('res.redirect(301, `/herbhaul${qs}`)'),
    'standalone router 301-redirects GET /cannadash to /herbhaul');
  ok(routerSrc.includes("router.get('/cannadash/founding'") && routerSrc.includes('res.redirect(301, `/herbhaul/founding${qs}`)'),
    'standalone router 301-redirects GET /cannadash/founding to /herbhaul/founding');
  ok(siteSrc.includes("router.get('/privacy/herbhaul'") && siteSrc.includes("router.get('/privacy/cannadash'"),
    'site router serves /privacy/herbhaul and redirects the pre-rename privacy slug');

  const mr = mockRes();
  standalone.handlers.cannadashFoundingHandler({}, mr);
  ok(mr.rendered && mr.rendered.v === 'onemind/cannadash-founding'
    && mr.rendered.l.layout === 'layout-onemind',
  'founding handler renders onemind/cannadash-founding in layout-onemind');
  ok(Array.isArray(mr.rendered.l.feeRows) && mr.rendered.l.feeRows.length === rows.length
    && mr.rendered.l.pricesLive === true,
  'founding handler passes the live fee rows + pricesLive:true to the view');

  // --- Rendered page: lock language, fee table, application path ---
  const ejs = require('ejs');
  const viewPath = path.join(__dirname, '../src/views/onemind/cannadash-founding.ejs');
  const html = await ejs.renderFile(viewPath, { ...mr.rendered.l });
  ok(html.includes('Founding partners'), 'founding page carries the founding partner offer');
  ok(/rate is locked at joining/i.test(html) && html.includes('12 months'),
    'founding page carries the lock language (locked at joining, 12 months)');
  ok(!html.includes(founding.WITHHELD_LABEL), 'founding page price cells no longer read the withheld label');
  ok(html.includes('<table') && html.includes('Platform subscription') && html.includes('Per-order toll'),
    'founding page renders the real fee table from config (structure visible)');
  ok(html.includes('$49/mo per location') && html.includes('$99/mo per location'),
    'founding page renders the struck rates ($49/mo founding, $99/mo standard)');
  ok(html.includes('15% of order subtotal'),
    'founding page renders the struck per-order toll (15% of order subtotal)');
  ok(html.includes('action="/herbhaul/join"') && html.includes('name="role" value="partner"'),
    'founding page application reuses POST /herbhaul/join with role=partner (no second intake)');
  ok(html.includes('/herbhaul?join=partner#join'),
    'founding page links the existing door join with role=partner');
  ok(/not live in any market/i.test(html) && /Licensed dispensaries only/i.test(html),
    'founding page stays honest: not live yet, licensed dispensaries only');

  // --- The door links the founding page ---
  const doorView = fs.readFileSync(path.join(__dirname, '../src/views/onemind/door-cannadash.ejs'), 'utf8');
  ok(doorView.includes('href="/herbhaul/founding"') && doorView.includes('Founding partners'),
    'herbhaul door carries a Founding partners section linking /herbhaul/founding');
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
