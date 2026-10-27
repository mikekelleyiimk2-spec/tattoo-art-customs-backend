// Tester Hub landing page tests (fix-queue, everything audit
// 2026-10-26). The coordinator (test/run.js) wires this in; do not
// run from here. Covers the /tester-hub contract: the canonical URL
// is a REAL landing page (200, tester-side headline, the ONE signup
// action), the join pipe lands in the same pool the Hub app reads
// (count moves exactly once per Gmail, idempotent, Gmail-only), the
// APK stays one tap away at /download (the old redirect), and the
// honeypot never joins anyone.
const BASE = 'http://localhost:4137';

async function runHttpTests(ok, req) {
  console.log('tester hub (landing page):');
  const call = async (method, p) => {
    const res = await fetch(`${BASE}${p}`, { method, redirect: 'manual' });
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  };
  const count = async () => {
    const res = await fetch(`${BASE}/api/testers/count`);
    const j = await res.json();
    return j.count;
  };

  const before = await count();

  // The landing itself: 200, not a redirect stub, first line carries it.
  const page = await call('GET', '/tester-hub');
  ok(page.status === 200, 'landing: /tester-hub serves 200 (no redirect stub)');
  ok(page.text.includes('BECOME A TESTER — FIRST IN LINE TO TRY THE NEWEST APPS'),
    'landing: first line is the tester-side headline');
  ok(page.text.includes('action="/tester-hub/join"'), 'landing: the ONE action is the pool signup form');
  ok(page.text.includes('href="/tester-hub/download"'), 'landing: APK download is one tap away');
  ok(page.text.includes('THE BOARD — LIVE'), 'landing: the live board section renders');
  ok((page.text.match(/Building an app of your own/g) || []).length === 1,
    'landing: the developer side gets exactly one line');
  if (before > 0) {
    ok(page.text.includes(`<span id="th-count">${before}</span>`) && page.text.includes('already in line'),
      'landing: hero pill shows the REAL live pool count');
  } else {
    ok(page.text.includes('FOUNDING BOARD IS OPEN'),
      'landing: empty pool shows the founding state honestly');
  }

  // The download keeps the old front-door behavior.
  const dl = await call('GET', '/tester-hub/download');
  ok(dl.status === 302 && dl.location === '/api/apps/com.usefulappz.testerhub/apk',
    'landing: /download 302s to the APK bytes (old behavior, one tap)');

  // The wire, end to end: form post -> pool member -> count moves.
  const G = 'landing.tester.test@gmail.com';
  const join = await req('POST', '/tester-hub/join',
    { body: { name: 'Landing Tester', gmail: G }, follow: false });
  ok(join.status === 302 && (join.location || '').startsWith('/tester-hub?joined=1'),
    'landing: join post redirects to the lit joined state');
  ok((await count()) === before + 1, 'landing: the signup landed in the pool (count +1)');

  const joinedPage = await call('GET', '/tester-hub?joined=1');
  ok(joinedPage.text.includes("YOU'RE IN"), 'landing: joined state renders the lit confirmation');

  // Idempotent: the same Gmail again is a refresh, never a second seat.
  const again = await req('POST', '/tester-hub/join',
    { body: { name: 'Landing Tester', gmail: G }, follow: false });
  ok(again.status === 302 && (again.location || '').startsWith('/tester-hub?joined=1'),
    'landing: repeat join is a clean refresh');
  ok((await count()) === before + 1, 'landing: repeat join does not double-count');

  // Gmail-only pool: a non-Gmail address is refused with the honest error.
  const bad = await req('POST', '/tester-hub/join',
    { body: { name: 'Bad Actor', gmail: 'someone@example.com' }, follow: false });
  ok(bad.status === 302 && (bad.location || '').includes('error=gmail'),
    'landing: non-Gmail is refused (the pool is a Gmail pool)');
  ok((await count()) === before + 1, 'landing: refused signup never touches the count');

  // A name is required — the board puts names in lights.
  const noName = await req('POST', '/tester-hub/join',
    { body: { name: '', gmail: 'landing.noname.test@gmail.com' }, follow: false });
  ok(noName.status === 302 && (noName.location || '').includes('error=name'),
    'landing: missing name is refused with its own error');
  ok((await count()) === before + 1, 'landing: nameless signup never touches the count');

  // Honeypot: a bot-filled post gets the silent thanks, joins nobody.
  const bot = await req('POST', '/tester-hub/join',
    { body: { name: 'Bot', gmail: 'landing.bot.test@gmail.com', website: 'http://spam.example' }, follow: false });
  ok(bot.status === 200 && bot.text.includes('Thanks'), 'landing: honeypot post is silently thanked');
  ok((await count()) === before + 1, 'landing: honeypot signup never joins the pool');
}

module.exports = { runHttpTests };
