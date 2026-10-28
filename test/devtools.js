// Developer Tools for other developers — Bundle B (Oct 28 2026):
// Fill-My-List standalone service face, Rolodex public demo,
// Money Watch for developers (offer + interest register).
// DB phase: settled-price invariants + the interest register.
// HTTP phase: the three own-face pages, the demo's no-house-data
// guarantee, the fill-order wiring, and the codex entries.
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const devtools = require('../src/lib/devtools');
const fillCycle = require('../src/lib/fillCycle');
const pricing = require('../src/lib/pricing');

async function runDbTests(ok) {
  console.log('developer tools (bundle B config + register):');
  // Settled prices, exactly once, never re-priced.
  ok(devtools.FILL.baseCents === 2499, 'FillMyList settled at $24.99');
  ok(devtools.FILL.baseCents === fillCycle.PRICE_CENTS, 'the service page price and the fill machine price can never disagree');
  ok(devtools.FILL.target === 12, 'a fill runs until FULL = 12 confirmed opt-ins');
  ok(devtools.fillRegisterCents() === pricing.withFeeCents(2499), 'register total applies the house fee pass-through');
  ok(devtools.ROLODEX_TIERS.affiliate.baseCents === 499
    && devtools.ROLODEX_TIERS.social.baseCents === 499
    && devtools.ROLODEX_TIERS.master.baseCents === 799,
    'Rolodex tiers settled: Affiliate $4.99 / Social $4.99 / Master $7.99');
  ok(devtools.MONEY_WATCH.priceCents === 499, 'Money Watch settled at $4.99 one-time');
  ok(devtools.MONEY_WATCH.sourceDoors.length === 5
    && devtools.MONEY_WATCH.sourceDoors.every((d) => d.name && d.state && d.note),
    'Money Watch source doors carry honest states');
  ok(devtools.TIP_JAR_URL === 'https://www.paypal.com/ncp/payment/WA9DS6J8ERSHW', 'tip jar is the house Business PayPal (mk4) link');

  // The pool count is a real read (0 on a fresh estate), never invented.
  const n = await devtools.poolCount();
  ok(typeof n === 'number' && n >= 0, 'pool count reads from the Hub table');

  // Interest lands in the register as a pending_review orders row.
  const id = await devtools.recordMoneyWatchInterest({
    name: 'Dev Tester', email: 'devtools.interest@gmail.com',
    sources: 'Play payouts + PayPal', userId: '',
  });
  const row = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
  ok(!!row && row.order_type === 'money_watch_dev_interest' && row.status === 'pending_review',
    'Money Watch interest records a pending_review register row');
  ok(row.guest_email === 'devtools.interest@gmail.com' && Number(row.amount_cents) === 499,
    'interest row carries the email + the settled $4.99 it registered against');
}

async function runHttpTests(ok, req) {
  console.log('developer tools (bundle B faces):');
  const anon = async (p, opts = {}) => {
    const r = await fetch(`http://localhost:4137${p}`, { redirect: 'manual', ...opts });
    return { status: r.status, text: await r.text(), location: r.headers.get('location') };
  };

  // ---- FillMyList ----
  const fill = await anon('/fill-my-list');
  ok(fill.status === 200, '/fill-my-list serves 200');
  ok(fill.text.includes('FillMyList') && fill.text.includes('Developer Tools'), 'fill page carries its own face (dev-tools layout)');
  ok(fill.text.includes('$24.99'), 'fill price shown at the settled $24.99');
  ok(fill.text.includes('awaiting_payment'), 'the honest checkout state is printed on the face');
  ok(/tap your app’s Play opt-in link themselves|tap.*opt-in link themselves/.test(fill.text), 'the tester tap is stated plainly — never described away');
  ok(fill.text.includes('sign-up IS the opt-in'), 'pool copy states sign-up IS the opt-in');
  ok(fill.text.includes('/api/testers/fill/order') && fill.text.includes('/api/testers/fill/status'), 'order + status forms wire the real fill API');
  ok(fill.text.includes('https://www.paypal.com/ncp/payment/WA9DS6J8ERSHW'), 'tip jar (Penny Sweeper) on the fill page');
  ok(fill.text.includes('/rolodex-demo') && fill.text.includes('/money-watch') && fill.text.includes('/onemind'), 'sister cross-links on the fill page');

  // The order wiring itself: an app on the Hub + a fill order through
  // the same public API the page's form posts to.
  const call = async (method, p, body) => {
    const r = await fetch(`http://localhost:4137${p}`, {
      method, redirect: 'manual',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const PKG = 'com.example.bundleb';
  const DEV = 'bundleb.dev@gmail.com';
  const added = await call('POST', '/api/testers/apps', {
    app_name: 'Bundle B Demo App', package: PKG,
    optin_url: `https://play.google.com/apps/testing/${PKG}`,
    developer_gmail: DEV, blurb: 'Bundle B wiring check.',
  });
  ok(added.json && added.json.ok === true, 'demo app added to the Hub through the public door');
  const ord = await call('POST', '/api/testers/fill/order', { package: PKG, developer_gmail: DEV });
  ok(ord.json && ord.json.ok === true && ord.json.order && ord.json.order.status === 'awaiting_payment',
    'fill order recorded awaiting_payment — an unpaid app never cycles');
  ok(ord.json.order.price_cents === 2499 && ord.json.order.target === 12, 'fill order carries the settled price + FULL target');
  const st = await call('GET', `/api/testers/fill/status?package=${PKG}&gmail=${encodeURIComponent(DEV)}`);
  ok(st.json && st.json.ok === true && st.json.order.confirmed === 0, 'fill status reads back through the page’s status door');

  // ---- Rolodex demo ----
  const demo = await anon('/rolodex-demo');
  ok(demo.status === 200, '/rolodex-demo serves 200');
  ok(demo.text.includes('Affiliate Rolodex') && demo.text.includes('Organize it'), 'demo page carries the live demo');
  ok(demo.text.includes('Sample:'), 'demo ships sample messes');
  ok(demo.text.includes('$4.99') && demo.text.includes('$7.99'), 'demo ends at the settled doors ($4.99 / $7.99)');
  ok(/in your browser/i.test(demo.text) && /nothing you paste leaves this page/i.test(demo.text), 'demo states its in-browser honesty');
  // The guarantee: no house rolodex link leaks into the demo page.
  let houseLinks = [];
  try {
    const book = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'rolodex.json'), 'utf8'));
    houseLinks = (book.programs || []).filter((p) => p.status === 'live' && p.link).map((p) => p.link);
  } catch (e) { /* a missing book means no links to leak */ }
  ok(houseLinks.length > 0 && houseLinks.every((l) => !demo.text.includes(l)), 'demo page contains NONE of the house rolodex’s live links');

  // ---- Money Watch ----
  const mw = await anon('/money-watch');
  ok(mw.status === 200, '/money-watch serves 200');
  ok(mw.text.includes('Money Watch') && mw.text.includes('$4.99'), 'money watch offer carries the settled $4.99');
  ok(mw.text.includes('action="/money-watch/interest"'), 'interest form posts to the register door');
  ok(/read-only/i.test(mw.text) && /never moves your money/i.test(mw.text), 'read-only-first law printed on the face');
  ok(/no payment is taken/i.test(mw.text), 'interest state is honest — no payment taken today');
  ok(mw.text.includes('https://www.paypal.com/ncp/payment/WA9DS6J8ERSHW'), 'tip jar (Penny Sweeper) on the money watch page');

  // NOTE: this phase of run.js runs with the shared DB handle closed
  // (it re-opens later) — the register-row write itself is proven in
  // runDbTests via recordMoneyWatchInterest; here we prove the door.
  const post = await anon('/money-watch/interest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'HTTP Dev', email: 'bundleb.http@gmail.com', sources: 'Play payouts', website: '' }).toString(),
  });
  ok(post.status === 302 && (post.location || '').includes('/money-watch'), 'interest POST redirects back to the offer');
  const badPost = await anon('/money-watch/interest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'No Email', email: 'not-an-email', sources: '', website: '' }).toString(),
  });
  ok(badPost.status === 302, 'interest POST with a bad email still lands softly (flash, no 500)');

  // ---- Codex carries the new doors + prices ----
  const codexRes = await anon('/api/codex');
  ok(codexRes.status === 200 && codexRes.text.includes('FillMyList'), 'codex serves the FillMyList entries');
  ok(codexRes.text.includes('Money Watch for developers'), 'codex serves the Money Watch developer door');
  ok(codexRes.text.includes('/rolodex-demo'), 'codex serves the Rolodex demo door');
}

module.exports = { runDbTests, runHttpTests };
