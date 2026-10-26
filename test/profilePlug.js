// Tester Hub slice 4 — the Profile Plug machine tests (2026-10-26).
// The coordinator (test/run.js) wires this in AFTER testerHub.js;
// do not run from here.
// Covers the settled model (owner strike 2026-10-26 07:07): developer
// profiles keyed to Gmail; per-developer Rolodex entries in the house
// shape; the entitlement gate (first link FREE; further links flat
// $0.99 / 15% ride / plug credit); the allow-check as a structural
// gate; public rendering (live + entitled + checked only, disclosure
// always, no Gmails); feed order + pool count untouched by plugs;
// the redirect click counter (same numbers both sides); and the
// penny split (slices sum to the $0.99 purchase; unreferred penny
// falls into the pot; credit auto-apply consumes $0.99 and writes
// NO new split).
const BASE = 'http://localhost:4137';

async function runHttpTests(ok, req) {
  console.log('tester hub (profile plug):');
  const TOKEN = process.env.MUSE_SERVICE_TOKEN;
  const call = async (method, p, body, token) => {
    const res = await fetch(`${BASE}${p}`, {
      method, redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, text, json, location: res.headers.get('location') };
  };

  const REF = 'plug.referrer.test@gmail.com';
  const DEV = 'plug.dev.test@gmail.com';
  const DEV2 = 'plug.dev2.test@gmail.com'; // no referrer on file
  const LINK1 = 'https://example-shop-one.test/affiliate?ref=dev1';
  const LINK2 = 'https://example-shop-two.test/affiliate?ref=dev1';

  // --- token guards: management is service-token only ---
  const noTok = await call('POST', '/api/testers/profiles', { gmail: DEV, display_name: 'Plug Dev' });
  ok(noTok.status === 401, 'profile create rejects a missing token');
  const badTok = await call('GET', '/api/testers/profiles/admin', undefined, 'wrong-token');
  ok(badTok.status === 401, 'profiles admin rejects a wrong token');
  const adminNoTok = await call('GET', '/api/testers/profiles/admin');
  ok(adminNoTok.status === 401 && !adminNoTok.text.includes(DEV), 'profiles admin leaks nothing without a token');

  // --- profiles: create referrer + developer (attribution at the door) ---
  const mkRef = await call('POST', '/api/testers/profiles', { gmail: REF, display_name: 'Plug Referrer' }, TOKEN);
  ok(mkRef.status === 200 && mkRef.json.created === true, 'referrer profile created');
  const mkDev = await call('POST', '/api/testers/profiles',
    { gmail: DEV, display_name: 'Plug Dev', blurb: 'Makes test apps.', referrer_gmail: REF, rolodex_app_owned: true }, TOKEN);
  ok(mkDev.status === 200 && mkDev.json.profile.referrer_gmail === REF
    && mkDev.json.profile.first_link_free_used === false, 'developer profile created with referrer attribution');
  const mkDevAgain = await call('POST', '/api/testers/profiles',
    { gmail: DEV, display_name: 'Plug Dev', referrer_gmail: 'someone.else@gmail.com' }, TOKEN);
  ok(mkDevAgain.status === 200 && mkDevAgain.json.created === false
    && mkDevAgain.json.profile.referrer_gmail === REF,
    'attribution is set once — a repeat create never rewrites the referrer');

  // Public profiles: names yes, addresses never.
  const pub0 = await call('GET', '/api/testers/profiles');
  ok(pub0.status === 200 && pub0.json.ok === true && typeof pub0.json.pot_cents === 'number',
    'public profiles respond with the pot total');
  ok(!pub0.text.includes(DEV) && !pub0.text.includes(REF), 'public profiles never carry Gmails');
  const pubDev0 = pub0.json.profiles.find((p) => p.display_name === 'Plug Dev');
  ok(!!pubDev0 && pubDev0.links.length === 0 && pubDev0.apps.length === 0,
    'a fresh profile renders no links and no apps');

  // --- a link exists in the book but renders nowhere until gated ---
  const addL1 = await call('POST', '/api/testers/profiles/links', {
    developer_gmail: DEV, name: 'Shop One', network: 'Direct',
    link: LINK1, code: 'DEV1', rate: '10%', subid: 'hub-plug-test',
  }, TOKEN);
  ok(addL1.status === 200 && addL1.json.entry.status === 'pending'
    && addL1.json.entry.entitlement === 'none'
    && typeof addL1.json.entry.disclosure === 'string' && addL1.json.entry.disclosure.length > 0
    && addL1.json.entry.kid_safe === false,
    'link added pending + ungated, with a disclosure locked on and kid_safe false');
  const L1 = addL1.json.entry.id;
  const pub1 = await call('GET', '/api/testers/profiles');
  ok(pub1.json.profiles.find((p) => p.display_name === 'Plug Dev').links.length === 0,
    'an ungated link renders nowhere');
  const goEarly = await call('GET', `/api/testers/go/${L1}`);
  ok(goEarly.status === 404, 'the redirect 404s an ungated link');

  // The allow-check is structural: no grant before it passes.
  const grantEarly = await call('POST', '/api/testers/profiles/links/grant', { entry_id: L1, method: 'free' }, TOKEN);
  ok(grantEarly.status === 400, 'grant before the allow-check is refused');
  const check1 = await call('POST', '/api/testers/profiles/links/check',
    { entry_id: L1, ok: true, note: 'network confirmed placement OK (test)' }, TOKEN);
  ok(check1.status === 200 && check1.json.entry.allow_check_ok === true, 'allow-check recorded');

  // The FIRST link is free — a paid method on it is refused.
  const grantFlatFirst = await call('POST', '/api/testers/profiles/links/grant', { entry_id: L1, method: 'flat' }, TOKEN);
  ok(grantFlatFirst.status === 400, 'a paid grant on the first link is refused (first link is free)');
  const grantFree = await call('POST', '/api/testers/profiles/links/grant', { entry_id: L1, method: 'free' }, TOKEN);
  ok(grantFree.status === 200 && grantFree.json.entitlement === 'free_first'
    && grantFree.json.entry.status === 'live', 'first link granted free and live');

  // Now it renders — whole: redirect URL + code + disclosure.
  const pub2 = await call('GET', '/api/testers/profiles');
  const rendered1 = pub2.json.profiles.find((p) => p.display_name === 'Plug Dev').links;
  ok(rendered1.length === 1 && rendered1[0].go === `/api/testers/go/${L1}`
    && rendered1[0].code === 'DEV1' && /affiliate link/i.test(rendered1[0].disclosure),
    'the plugged link renders with its go URL, code, and disclosure together');
  ok(!pub2.text.includes(LINK1), 'the raw affiliate URL never renders directly (the redirect is the door)');

  // --- the redirect counts the click; both sides read the same number ---
  const go1 = await call('GET', `/api/testers/go/${L1}`);
  ok(go1.status === 302 && go1.location === `${LINK1}&subid=hub-plug-test`,
    'redirect 302s to the link with the Hub SubID appended');
  const adm1 = await call('GET', `/api/testers/profiles/admin?gmail=${encodeURIComponent(DEV)}`, undefined, TOKEN);
  ok(adm1.status === 200 && adm1.json.links.find((l) => l.id === L1).clicks === 1,
    'the click counter moved — the owner-side read shows the same 1');

  // --- the developer's app card carries the plug; feed order/count unmoved ---
  const feedBefore = await call('GET', '/api/testers/apps');
  const orderBefore = feedBefore.json.apps.map((a) => a.package).join('|');
  const addApp = await call('POST', '/api/testers/apps', {
    app_name: 'Plug Test App', package: 'com.example.plugtest',
    optin_url: 'https://play.google.com/apps/testing/com.example.plugtest',
    developer_gmail: DEV, blurb: 'Profile plug test app.',
  });
  ok(addApp.status === 200 && addApp.json.ok === true, 'developer app added to the Hub');
  const feedAfter = await call('GET', '/api/testers/apps');
  const card = feedAfter.json.apps.find((a) => a.package === 'com.example.plugtest');
  ok(!!card && Array.isArray(card.plug_links) && card.plug_links.length === 1
    && card.plug_links[0].id === L1, 'the app card carries the developer\'s plugged link');
  const fleetCard = feedAfter.json.apps.find((a) => a.package === 'com.tattooartcustoms.app');
  ok(!!fleetCard && Array.isArray(fleetCard.plug_links) && fleetCard.plug_links.length === 0,
    'fleet cards carry an empty plug list (no profile, no plug)');
  ok(feedAfter.json.pool_count === feedBefore.json.pool_count,
    'plugging changed no pool count');
  const orderAfter = feedAfter.json.apps.map((a) => a.package).join('|');
  ok(orderAfter === `${orderBefore}|com.example.plugtest`,
    'feed order is exactly as before plus the genuinely new app at the end — plugs move nothing');

  // --- second link: flat purchase fires the penny split ---
  const addL2 = await call('POST', '/api/testers/profiles/links', {
    developer_gmail: DEV, name: 'Shop Two', network: 'Direct', link: LINK2, code: 'DEV2',
  }, TOKEN);
  const L2 = addL2.json.entry.id;
  await call('POST', '/api/testers/profiles/links/check', { entry_id: L2, ok: true, note: 'ok (test)' }, TOKEN);
  const grantFlat = await call('POST', '/api/testers/profiles/links/grant', { entry_id: L2, method: 'flat' }, TOKEN);
  ok(grantFlat.status === 200 && grantFlat.json.entitlement === 'flat'
    && grantFlat.json.simulated_purchase === true, 'second link granted flat (simulated verified purchase)');
  const sp = grantFlat.json.split || {};
  ok(sp.google_fee_cents + sp.referrer_cents + sp.pot_cents + sp.buyer_credit_cents + sp.house_cents === 99
    && sp.google_fee_cents === 15 && sp.referrer_cents === 1 && sp.pot_cents === 1
    && sp.buyer_credit_cents === 1 && sp.house_cents === 81,
    'the penny split sums to the $0.99 purchase: 15 + 1 + 1 + 1 + 81');
  ok(sp.referrer_account === REF, 'the referrer penny went to the referrer on file');
  const adm2 = await call('GET', `/api/testers/profiles/admin?gmail=${encodeURIComponent(DEV)}`, undefined, TOKEN);
  ok(adm2.json.balances.credit_cents === 1, 'buyer credit balance is the 1c penny back');
  const admRef = await call('GET', `/api/testers/profiles/admin?gmail=${encodeURIComponent(REF)}`, undefined, TOKEN);
  ok(admRef.json.balances.referrer_cents === 1, 'referrer balance accrued its penny');
  ok(adm2.json.pot_cents === 1, 'the pot holds its penny');

  // --- no referrer on file: the referrer penny falls into the pot ---
  await call('POST', '/api/testers/profiles', { gmail: DEV2, display_name: 'Plug Dev Two' }, TOKEN);
  const addD2L1 = await call('POST', '/api/testers/profiles/links', {
    developer_gmail: DEV2, name: 'Solo One', network: 'Direct', link: 'https://solo-one.test/x',
  }, TOKEN);
  await call('POST', '/api/testers/profiles/links/check', { entry_id: addD2L1.json.entry.id, ok: true, note: 'ok' }, TOKEN);
  await call('POST', '/api/testers/profiles/links/grant', { entry_id: addD2L1.json.entry.id, method: 'free' }, TOKEN);
  const addD2L2 = await call('POST', '/api/testers/profiles/links', {
    developer_gmail: DEV2, name: 'Solo Two', network: 'Direct', link: 'https://solo-two.test/x',
  }, TOKEN);
  await call('POST', '/api/testers/profiles/links/check', { entry_id: addD2L2.json.entry.id, ok: true, note: 'ok' }, TOKEN);
  const grantD2 = await call('POST', '/api/testers/profiles/links/grant', { entry_id: addD2L2.json.entry.id, method: 'flat' }, TOKEN);
  ok(grantD2.status === 200 && grantD2.json.split.referrer_account === 'pot'
    && grantD2.json.split.pot_cents === 2, 'unreferred: the pot takes both pennies — pennies never vanish');
  const pubPot = await call('GET', '/api/testers/profiles');
  ok(pubPot.json.pot_cents === 3, 'pot total is public and sums across purchases (1 + 2)');

  // --- the ride: renders, no purchase, no split ---
  const addL3 = await call('POST', '/api/testers/profiles/links', {
    developer_gmail: DEV, name: 'Ride Shop', network: 'Network', link: 'https://ride-shop.test/x', rate: '12%',
  }, TOKEN);
  const L3 = addL3.json.entry.id;
  await call('POST', '/api/testers/profiles/links/check', { entry_id: L3, ok: true, note: 'ok' }, TOKEN);
  const grantRide = await call('POST', '/api/testers/profiles/links/grant', { entry_id: L3, method: 'ride' }, TOKEN);
  ok(grantRide.status === 200 && grantRide.json.entitlement === 'ride'
    && grantRide.json.ride_percent === 15, 'a link can ride at the settled 15%');
  const db = require('../src/db');
  const rideRows = await db.all('SELECT * FROM penny_ledger WHERE entry_id = ?', [L3]);
  ok(rideRows.length === 0, 'a ride grant writes no ledger rows (no purchase to split)');

  // --- credit auto-apply: top the credit up (staged earnings), then spend ---
  // The earning path is proven above (flat grants wrote real credit
  // pennies). Here we stage the remaining balance directly on the
  // ledger — the same rows real purchases would have written — to
  // exercise the spend rule: -$0.99, and NO new split for the entry.
  const balNow = (await call('GET', `/api/testers/profiles/admin?gmail=${encodeURIComponent(DEV)}`, undefined, TOKEN)).json.balances.credit_cents;
  const topUp = 99 - balNow;
  for (let i = 0; i < topUp; i++) {
    await db.insert('penny_ledger', {
      account: DEV, kind: 'split_buyer_credit', amount_cents: 1,
      entry_id: null, purchase_ref: 'test-topup', note: 'staged earned credit (test)',
    });
  }
  const addL4 = await call('POST', '/api/testers/profiles/links', {
    developer_gmail: DEV, name: 'Credit Shop', network: 'Direct', link: 'https://credit-shop.test/x',
  }, TOKEN);
  const L4 = addL4.json.entry.id;
  await call('POST', '/api/testers/profiles/links/check', { entry_id: L4, ok: true, note: 'ok' }, TOKEN);
  const grantCredit = await call('POST', '/api/testers/profiles/links/grant', { entry_id: L4, method: 'credit' }, TOKEN);
  ok(grantCredit.status === 200 && grantCredit.json.entitlement === 'credit'
    && grantCredit.json.credit_spent_cents === 99 && grantCredit.json.credit_balance_cents === 0,
    'credit auto-apply: $0.99 of credit plugs the link, balance back to 0');
  const l4Rows = await db.all('SELECT * FROM penny_ledger WHERE entry_id = ?', [L4]);
  ok(l4Rows.length === 1 && l4Rows[0].kind === 'credit_spend' && Number(l4Rows[0].amount_cents) === -99,
    'a credit-paid plug writes ONLY the spend row — no penny is split twice');
  const grantCreditBroke = await call('POST', '/api/testers/profiles/links', {
    developer_gmail: DEV, name: 'Broke Shop', network: 'Direct', link: 'https://broke-shop.test/x',
  }, TOKEN);
  const L5 = grantCreditBroke.json.entry.id;
  await call('POST', '/api/testers/profiles/links/check', { entry_id: L5, ok: true, note: 'ok' }, TOKEN);
  const grantBroke = await call('POST', '/api/testers/profiles/links/grant', { entry_id: L5, method: 'credit' }, TOKEN);
  ok(grantBroke.status === 400, 'credit grant with an empty credit balance is refused');

  // --- a granted link cannot be granted twice; pause hides it ---
  const grantTwice = await call('POST', '/api/testers/profiles/links/grant', { entry_id: L1, method: 'flat' }, TOKEN);
  ok(grantTwice.status === 400, 'an entitled link cannot be granted again');
  const pause = await call('POST', '/api/testers/profiles/links/status', { entry_id: L3, status: 'paused' }, TOKEN);
  ok(pause.status === 200 && pause.json.entry.status === 'paused', 'a link can be paused');
  const pubPaused = await call('GET', '/api/testers/profiles');
  ok(!pubPaused.json.profiles.find((p) => p.display_name === 'Plug Dev').links.some((l) => l.id === L3),
    'a paused link stops rendering');
  const goPaused = await call('GET', `/api/testers/go/${L3}`);
  ok(goPaused.status === 404, 'the redirect 404s a paused link');
  const resume = await call('POST', '/api/testers/profiles/links/status', { entry_id: L3, status: 'live' }, TOKEN);
  ok(resume.status === 200, 'a paused link resumes to live (gate re-checked)');
  const goGhost = await call('GET', '/api/testers/go/deadbeefdeadbeefdeadbeef');
  ok(goGhost.status === 404, 'the redirect 404s an unknown id');
}

module.exports = { runHttpTests };
