// Developer Tools for other developers — Bundle B (Oct 28 2026):
// Fill-My-List standalone service face, Rolodex public demo,
// Money Watch for developers (offer + interest register + the real
// PayPal buy door, wired 2026-11-05 for gap G-11).
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
  ok(devtools.fillRegisterCents() === 2635, 'FillMyList register total is exactly $26.35 ($24.99 + $1.36 fee)');
  ok(devtools.ROLODEX_TIERS.affiliate.baseCents === 499
    && devtools.ROLODEX_TIERS.social.baseCents === 499
    && devtools.ROLODEX_TIERS.master.baseCents === 799,
    'Rolodex tiers settled: Affiliate $4.99 / Social $4.99 / Master $7.99');
  ok(devtools.MONEY_WATCH.priceCents === 499, 'Money Watch settled at $4.99 one-time');
  ok(devtools.moneyWatchRegisterCents() === pricing.withFeeCents(499)
    && devtools.moneyWatchRegisterCents() === 565,
    'Money Watch register total = settled price + house fee pass-through ($5.65)');
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
  ok(fill.text.includes('action="/fill-my-list/buy"') && fill.text.includes('/api/testers/fill/status'), 'buy form wires the real PayPal checkout door + status form wires the real fill API');
  ok(fill.text.includes('$26.35'), 'register total ($24.99 + $1.36 fee = $26.35) printed on the fill face');
  ok(fill.text.includes('Checkout is live'), 'fill face states checkout is live');
  ok(!fill.text.includes('being set up') && !fill.text.includes('grants the entitlement by hand'),
    'fill face no longer claims web checkout is being set up / desk-granted by hand');
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

  // The buy door: a mismatched developer Gmail is refused BEFORE any
  // PayPal call (soft landing back on the face, no 500, no charge).
  const badFillBuy = await anon('/fill-my-list/buy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ package: PKG, developer_gmail: 'not-the-dev@gmail.com', website: '' }).toString(),
  });
  ok(badFillBuy.status === 302 && (badFillBuy.location || '').includes('/fill-my-list'),
    'fill buy with a mismatched Gmail lands softly on the face (no PayPal call made)');

  // A valid buy with the suite's fake PayPal credentials degrades
  // gracefully: redirect back to the face, the fill order stays
  // awaiting_payment, and nothing enters the cycle unpaid.
  const gracefulBuy = await anon('/fill-my-list/buy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ package: PKG, developer_gmail: DEV, website: '' }).toString(),
  });
  ok(gracefulBuy.status === 302 && (gracefulBuy.location || '').includes('/fill-my-list'),
    'fill buy degrades gracefully when PayPal cannot create a checkout (no crash, no /login bounce)');
  const stAfterBuy = await call('GET', `/api/testers/fill/status?package=${PKG}&gmail=${encodeURIComponent(DEV)}`);
  ok(stAfterBuy.json && stAfterBuy.json.order.status === 'awaiting_payment',
    'fill order stays awaiting_payment after a failed checkout creation — unpaid never cycles');

  // The cancel return: a soft landing on the face, no charge attempted.
  const cancelled = await anon('/fill-my-list/cancelled');
  ok(cancelled.status === 302 && (cancelled.location || '').includes('/fill-my-list'),
    'fill cancel return lands softly on the face');

  // The approve door over a seeded register row (the guest-app
  // checkout pattern): HMAC-gated, the stubbed capture verifies, the
  // register row pays, and grantFillEntitlement flips the fill to
  // 'filling' server-side — no service token anywhere in the flow.
  {
    const Database = require('better-sqlite3');
    const tdb = new Database(process.env.SQLITE_PATH);
    const guestCheckout = require('../src/lib/guestCheckout');
    const PKG2 = 'com.example.fillbuy';
    const DEV2 = 'fillbuy.dev@gmail.com';
    const added2 = await call('POST', '/api/testers/apps', {
      app_name: 'Fill Buy Demo App', package: PKG2,
      optin_url: `https://play.google.com/apps/testing/${PKG2}`,
      developer_gmail: DEV2, blurb: 'Fill checkout wiring check.',
    });
    ok(added2.json && added2.json.ok === true, 'fill-buy demo app added to the Hub');
    const ord2 = await call('POST', '/api/testers/fill/order', { package: PKG2, developer_gmail: DEV2 });
    ok(ord2.json && ord2.json.order.status === 'awaiting_payment', 'fill-buy order born awaiting_payment');
    tdb.prepare(`INSERT INTO orders
      (id, buyer_id, design_id, order_type, amount_cents, fee_cents, status, payment_method, paypal_order_id, referral_code, guest_email, guest_note, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('ord-fill-buy-1', '', null, 'fill_my_list', 2499, 136,
      'pending', 'paypal', 'pp-fill-buy-1', '', DEV2,
      JSON.stringify({ package: PKG2, developerGmail: DEV2 }), Date.now());
    let a = await anon('/fill-my-list/approve/ord-fill-buy-1');
    ok(a.status === 403, 'fill: approve without the checkout token is 403');
    a = await anon('/fill-my-list/approve/ord-fill-buy-1?gt=ord-fill-buy-1.00000000000000000000000000000000');
    ok(a.status === 403, 'fill: approve with a forged token is 403');
    const fillGt = guestCheckout.guestToken('ord-fill-buy-1', 'fill_my_list');
    a = await anon(`/fill-my-list/approve/ord-fill-buy-1?gt=${encodeURIComponent(fillGt)}`);
    ok(a.status === 302 && (a.location || '').includes('/fill-my-list/welcome/ord-fill-buy-1'),
      'fill: approve captures and redirects to the confirmation page');
    const regRow = tdb.prepare('SELECT status FROM orders WHERE id = ?').get('ord-fill-buy-1');
    ok(regRow && regRow.status === 'paid', 'fill: register order is paid after capture');
    const stFill = await call('GET', `/api/testers/fill/status?package=${PKG2}&gmail=${encodeURIComponent(DEV2)}`);
    ok(stFill.json && stFill.json.order.status === 'filling',
      'fill: verified capture grants the entitlement — the fill is filling (wave routed, no service token)');
    a = await anon(`/fill-my-list/welcome/ord-fill-buy-1?gt=${encodeURIComponent(fillGt)}`);
    ok(a.status === 200 && a.text.includes('Payment complete') && a.text.includes(PKG2),
      'fill: welcome page confirms payment + the started fill');
    a = await anon('/fill-my-list/welcome/ord-fill-buy-1');
    ok(a.status === 403, 'fill: welcome page without the checkout token is 403');
    tdb.close();
  }

  // ---- Rolodex demo ----
  const demo = await anon('/rolodex-demo');
  ok(demo.status === 200, '/rolodex-demo serves 200');
  ok(demo.text.includes('Affiliate Rolodex') && demo.text.includes('Organize it'), 'demo page carries the live demo');
  ok(demo.text.includes('Sample:'), 'demo ships sample messes');
  ok(demo.text.includes('$4.99') && demo.text.includes('$7.99'), 'demo ends at the settled doors ($4.99 / $7.99)');
  ok(demo.text.includes('Social Link Rolodex') && demo.text.includes('Get Social Link Rolodex'), 'demo sells all three tiers — the Social Link Rolodex $4.99 door is present (dead-door fix 2026-10-29)');
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
  ok(mw.text.includes('action="/money-watch/buy"'), 'buy form posts to the real checkout door (G-11 wired)');
  ok(mw.text.includes('$5.65'), 'register total ($4.99 + $0.66 fee) printed on the face');
  ok(/read-only/i.test(mw.text) && /never moves your money/i.test(mw.text), 'read-only-first law printed on the face');
  ok(/takes no payment/i.test(mw.text), 'interest state is honest — joining the list takes no payment');
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

  // The buy door rejects a bad guest email BEFORE any PayPal call —
  // a soft landing back on the offer, no 500, no order chased.
  const badBuy = await anon('/money-watch/buy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'No Email', email: 'not-an-email', sources: '', website: '' }).toString(),
  });
  ok(badBuy.status === 302 && (badBuy.location || '').includes('/money-watch'), 'buy POST with a bad email lands softly on the offer (no PayPal call made)');

  // ---- Codex carries the new doors + prices ----
  const codexRes = await anon('/api/codex');
  ok(codexRes.status === 200 && codexRes.text.includes('FillMyList'), 'codex serves the FillMyList entries');
  ok(codexRes.text.includes('Money Watch for developers'), 'codex serves the Money Watch developer door');
  ok(codexRes.text.includes('/rolodex-demo'), 'codex serves the Rolodex demo door');
}

module.exports = { runDbTests, runHttpTests };
