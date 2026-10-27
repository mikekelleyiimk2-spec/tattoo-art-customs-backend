// OneMind web structure tests (owner directive 2026-10-26 ~20:03–20:09).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers: /onemind as page 1 (the real OneMind sign-in door + the
// preserved flagship board), /onemind/table as page 2 (every branch
// lit, every plug from the Codex), the branch pages as full standalone
// pages at their own links, the kid-wall on the two kid branches
// (kid-safe Rolodex pulls only, no tattoo commerce, no way back into
// grown-up commerce), the tattoo shop as an OUTBOUND link (no hosted
// /onemind/tattoo-shop page — owner correction 20:05), the front
// door law (GET / is ALWAYS the tattoo shop's — the old
// ONEMIND_FRONT_DOOR redirect was retired by owner ruling 2026-10-27
// 09:38: nobody is taken anywhere they didn't ask to go), the
// seated /onemind → /onemind/table redirect (owner ruling 2026-10-27
// 08:57), and the /api/links registry carrying the new structure.
const BASE = 'http://localhost:4137';

async function runDbTests(ok) {
  console.log('onemind web (flag + rolodex kid pull + registry):');
  const web = require('../src/routes/onemindWeb');
  const rolodex = require('../src/lib/rolodex');
  const links = require('../src/lib/links');

  // The front-door redirect is RETIRED (owner ruling 2026-10-27
  // 09:38 CDT): GET / is the tattoo shop's front door, always — the
  // ONEMIND_FRONT_DOOR env flag is inert and ignored, and nobody is
  // funneled to OneMind. The behavioral pin lives in the HTTP phase
  // below (GET / serves 200 with the flag forced ON).

  // The kid pull the kid branches render: kid-safe programs only.
  const kid = rolodex.queryLive({ kidSafe: true });
  ok(kid.length >= 1, 'rolodex serves at least one live kid-safe program');
  ok(kid.every((p) => p.kid_safe === true), 'the kid-safe pull returns kid-safe programs only');
  ok(kid.every((p) => p.link && p.disclosure), 'kid-safe entries arrive whole (link + disclosure, the lock)');

  // The registry carries the new structure as first-class entries.
  const entries = links.publicEntries('web_pages');
  const byUrl = (suffix) => entries.find((e) => String(e.url || '').endsWith(suffix));
  for (const suffix of ['/onemind', '/onemind/table', '/onemind/poppy-and-ziggy', '/onemind/little-inkers',
    '/onemind/killintime', '/onemind/tester-hub', '/onemind/tools', '/tester-hub', '/privacy/onemind', '/folder']) {
    ok(!!byUrl(suffix), `web registry carries ${suffix}`);
  }
  ok(byUrl('/onemind/poppy-and-ziggy').kid_safe === true, 'registry marks the Poppy & Ziggy branch kid-safe');
  ok(byUrl('/onemind/little-inkers').kid_safe === true, 'registry marks the Little Inkers branch kid-safe');
  ok(byUrl('/onemind').kid_safe === false, 'registry keeps the grown-up hub out of kid-safe pulls');
  ok(!byUrl('/onemind/tattoo-shop'), 'registry has NO tattoo-shop branch entry (owner correction: TAC links out, it is not a branch page)');
}

async function runHttpTests(ok) {
  console.log('onemind web (hub, table, branches, kid wall, flag off):');
  const rolodex = require('../src/lib/rolodex');
  const call = async (method, p, { cookie } = {}) => {
    const res = await fetch(`${BASE}${p}`, {
      method, redirect: 'manual', ...(cookie ? { headers: { cookie } } : {}),
    });
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  };
  const form = async (p, fields) => {
    const res = await fetch(`${BASE}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
      redirect: 'manual',
    });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return {
      status: res.status, text: await res.text(),
      location: res.headers.get('location'),
      cookie: setCookies.map((c) => c.split(';')[0]).join('; '),
    };
  };

  // The front door law: / is the site's own front door, ALWAYS —
  // even with the retired flag forced ON, nobody is redirected to
  // OneMind (owner ruling 2026-10-27 09:38).
  const root = await call('GET', '/');
  ok(root.status === 200, 'GET / serves the site front door (no redirect)');
  const savedEnv = process.env.ONEMIND_FRONT_DOOR;
  process.env.ONEMIND_FRONT_DOOR = 'on';
  const rootOn = await call('GET', '/');
  ok(rootOn.status === 200 && !rootOn.location, 'GET / STILL serves the tattoo shop with ONEMIND_FRONT_DOOR=on (flag retired — no funnel)');
  if (savedEnv === undefined) delete process.env.ONEMIND_FRONT_DOOR;
  else process.env.ONEMIND_FRONT_DOOR = savedEnv;

  // Page 1 — the hub: the sign-in IS the OneMind sign-in.
  const hub = await call('GET', '/onemind');
  ok(hub.status === 200, '/onemind serves 200');
  ok(hub.text.includes('All Your AIs, One Team'), '/onemind carries the OneMind name line');
  ok(hub.text.includes('Sign in to OneMind'), '/onemind leads with the OneMind sign-in');
  ok(hub.text.includes('action="/login"'), '/onemind sign-in form posts to the real web door (/login)');
  ok(hub.text.includes('/api/onemind/link/start'), '/onemind wires the one-tap email door (seat-claim machinery)');
  ok(hub.text.includes('logged surface #1'), '/onemind says the website is logged surface #1');
  ok(hub.text.includes('href="/onemind/table"'), '/onemind doors onward to page 2, the Table');
  ok(hub.text.includes('Plug OneMind into your browser'), '/onemind carries the first-class plug door');
  ok(hub.text.includes('Never leave your regular homepage'), '/onemind plug door carries the owner\u2019s line');
  ok(hub.text.includes('Being built'), '/onemind plug door is honestly staged (package not landed yet — no fake link)');
  ok(hub.text.includes('href="/"'), '/onemind links OUT to the tattoo shop\u2019s own home (no hosted branch page)');
  ok(hub.text.includes('paypal.com/ncp/payment/WA9DS6J8ERSHW'), '/onemind carries the mk4 tip jar');
  ok(/SPONSORED/.test(hub.text) && /This spot is open/.test(hub.text), '/onemind sponsor slot is labeled and honestly open');
  const leda = rolodex.findLiveByName('Leda Art Supply');
  ok(leda && hub.text.includes(leda.link), '/onemind placements are pulled live from the Rolodex (REFERRAL-HUB: Leda)');
  ok(!/little-inkers|poppy-and-ziggy/.test(hub.text), '/onemind carries no links into kid-walled surfaces (pin held)');

  // Seated → straight to the Table (owner ruling 2026-10-27 08:57 CDT):
  // a signed-in session IS a seated session (signup runs seatQuietly),
  // so it never stops at the hub — /onemind redirects to page 2. The
  // hub remains the unseated face (the anonymous 200 checks above pin
  // it: hub carries the sign-in door for visitors).
  const su = await form('/signup', {
    email: 'hubtest@test.local', password: 'test-password-123', display_name: 'Hub Test', website: '',
  });
  ok(su.status === 302 && !!su.cookie, 'signup seats a new OneMind account (session issued)');
  const hubIn = await call('GET', '/onemind', { cookie: su.cookie });
  ok(hubIn.status === 302 && hubIn.location === '/onemind/table', 'seated /onemind goes straight to /onemind/table (owner ruling 2026-10-27)');
  const tableIn = await call('GET', '/onemind/table', { cookie: su.cookie });
  ok(tableIn.status === 200, 'the seated redirect lands on a live table (200)');

  // Page 2 — the table: every branch lit, plugs from the Codex.
  const table = await call('GET', '/onemind/table');
  ok(table.status === 200, '/onemind/table serves 200');
  for (const href of ['/onemind/poppy-and-ziggy', '/onemind/little-inkers', '/onemind/killintime',
    '/onemind/tester-hub', '/onemind/tools', '/onemind']) {
    ok(table.text.includes(`href="${href}"`), `/onemind/table branches to ${href}`);
  }
  ok(table.text.includes('href="/"'), '/onemind/table links OUT to the tattoo shop\u2019s own home');
  // Owner ruling 2026-10-27 09:33 CDT: the table face is a BROWSER —
  // Chrome grammar, plumbing invisible. No manifesto copy, no plug
  // cards, no placements furniture on the face; the tie runs
  // underneath, unstated. (Supersedes the old tie-law/plugs pins.)
  ok(!/a login anywhere is a OneMind login/i.test(table.text) && !/tied to OneMind/i.test(table.text), '/onemind/table carries NO manifesto copy (plumbing invisible, owner ruling 2026-10-27)');
  ok(table.text.includes('Search Google or type URL'), '/onemind/table renders the browser search bar');
  ok(table.text.includes('href="https://chatgpt.com"') && table.text.includes('href="https://claude.ai"'), '/onemind/table shortcut tiles open the real AIs');
  ok(!/SPONSORED/.test(table.text), '/onemind/table carries no sponsor/placements furniture on the face');

  // The tattoo shop is NOT a branch page (owner correction, 20:05).
  const tac = await call('GET', '/onemind/tattoo-shop');
  ok(tac.status === 404, '/onemind/tattoo-shop does not exist — the shop\u2019s page is the website itself');

  // The Tester Hub branch routes to the Hub's own standing page.
  const th = await call('GET', '/onemind/tester-hub');
  ok(th.status === 302 && th.location === '/tester-hub', '/onemind/tester-hub routes to /tester-hub');

  // Kid branches: full standalone pages, walled, kid-safe pulls only.
  const kidChecks = async (path, ownHome, label) => {
    const page = await call('GET', path);
    ok(page.status === 200, `${path} serves 200 (a full standalone page at its own link)`);
    ok(page.text.includes('kid-safe page'), `${path} renders in the walled Little Inkers layout`);
    ok(page.text.includes(`href="${ownHome}"`), `${path} links onward to its own home (${ownHome})`);
    const badHrefs = ['href="/gallery"', 'href="/shop"', 'href="/merch"', 'href="/onemind/table"',
      'href="/onemind"', 'href="/apps"', 'href="/advertise"', 'paypal.com/ncp/payment'];
    for (const bad of badHrefs) {
      ok(!page.text.includes(bad), `${path} carries no ${bad} (kid wall: no tattoo commerce, no way back)`);
    }
    for (const p of rolodex.livePrograms()) {
      if (!p.kid_safe && p.link) {
        ok(!page.text.includes(p.link), `${path} never renders the non-kid-safe program ${p.name}`);
      }
    }
    for (const p of rolodex.queryLive({ kidSafe: true })) {
      ok(page.text.includes(p.name), `${path} renders the kid-safe program ${p.name} from the live Rolodex pull`);
    }
    ok(/OneMind/.test(page.text) && /a login anywhere is a OneMind login/.test(page.text),
      `${path} states the tie for grown-ups (words, not a door)`);
    return page;
  };
  await kidChecks('/onemind/poppy-and-ziggy', '/poppy-and-ziggy', 'poppy');
  const pz = await call('GET', '/onemind/poppy-and-ziggy');
  ok(pz.text.includes('Friday') && pz.text.includes('5 PM CT'), 'poppy branch carries the show\u2019s real schedule (Fridays 5 PM CT)');
  ok(pz.text.includes('youtube.com/@ZiggyPoppy-l3b'), 'poppy branch doors to the show\u2019s own channel');
  await kidChecks('/onemind/little-inkers', '/little-inkers-android', 'li');
  const li = await call('GET', '/onemind/little-inkers');
  ok(li.text.includes('Color With Us'), 'little-inkers branch carries the show (Color With Us)');
  ok(li.text.includes('href="/little-inkers-ios"'), 'little-inkers branch doors to the free iOS app page');

  // Grown-up branches: real pages with their own doors and money.
  const kt = await call('GET', '/onemind/killintime');
  ok(kt.status === 200, '/onemind/killintime serves 200');
  ok(/no ads/i.test(kt.text) && /Ever/.test(kt.text), 'killintime branch states the ports rule (no ads, ever)');
  ok(kt.text.includes('href="/onemind/table"'), 'killintime branch links back to the Table');
  ok(kt.text.includes('paypal.com/ncp/payment/WA9DS6J8ERSHW'), 'killintime branch carries the mk4 tip jar');

  const tools = await call('GET', '/onemind/tools');
  ok(tools.status === 200, '/onemind/tools serves 200');
  for (const name of ['Affiliate Rolodex', 'RoboSweeper', 'Money Watch', 'Connection Doctor', 'Tester Hub']) {
    ok(tools.text.includes(name), `/onemind/tools carries ${name}`);
  }
  ok(tools.text.includes('$4.99') && tools.text.includes('$13.99'), '/onemind/tools states settled tool prices');
  ok(tools.text.includes('href="/apps"'), '/onemind/tools doors to the apps page');
}

module.exports = { runDbTests, runHttpTests };
