// Test suite: `npm test`. Spins up the app on a temp SQLite DB and
// exercises the business rules end to end over HTTP, plus lib unit checks.
// Exits non-zero on the first failure.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tac-test-'));
process.env.SQLITE_PATH = path.join(TMP, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.BASE_URL = 'http://localhost:4137';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminTest123!';
process.env.ASSET_DIR = path.join(TMP, 'assets');

const PORT = 4137;
let failures = 0;
function ok(cond, name) {
  if (cond) console.log('  ok -', name);
  else { failures++; console.error('  FAIL -', name); }
}

// Minimal cookie jar for fetch.
const jar = {};
async function req(method, p, { body, headers = {}, follow = true } = {}) {
  const h = { ...headers };
  const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookies) h.cookie = cookies;
  let payload;
  if (body && typeof body === 'object' && !(body instanceof URLSearchParams)) {
    payload = new URLSearchParams(body);
    h['content-type'] = 'application/x-www-form-urlencoded';
  } else payload = body;
  const res = await fetch(`http://localhost:${PORT}${p}`, {
    method, headers: h, body: payload, redirect: follow ? 'follow' : 'manual',
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookies) {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    jar[k.trim()] = (v || '').trim();
  }
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get('location') };
}

async function main() {
  // --- lib unit checks ---
  const { screenText } = require('../src/lib/screening');
  const pricing = require('../src/lib/pricing');

  console.log('screening:');
  ok(screenText('I draw blackwork roses.').ok, 'clean bio passes');
  ok(!screenText('email me at a@b.com').ok, 'email blocked');
  ok(!screenText('call 555-123-4567').ok, 'phone blocked');
  ok(!screenText('DM me on instagram').ok, 'DM solicitation blocked');
  ok(!screenText('pay via venmo').ok, 'payment info blocked');
  ok(screenText('123 Main Street, Dallas, TX', { allow: ['street_address'] }).ok, 'shop location address allowed');
  ok(!screenText('bob@mail.com', { allow: ['street_address'] }).ok, 'shop location email still blocked');

  console.log('pricing:');
  ok(pricing.money(7500) === '$75.00', 'money formats');
  ok(pricing.money(9999) === '$99.99', 'money formats 99.99');
  // Saturday 8pm CT = Sunday 02:00 UTC (CDT, UTC-5)
  ok(pricing.isSaleWindow(new Date('2026-10-03T20:30:00-05:00')), 'sale window: Sat 8:30pm CT');
  ok(!pricing.isSaleWindow(new Date('2026-10-03T18:30:00-05:00')), 'no sale: Sat 6:30pm CT');
  ok(!pricing.isSaleWindow(new Date('2026-10-04T06:00:00-05:00')), 'no sale: Sun 6am CT');
  ok(pricing.premadePriceCents(new Date('2026-10-03T20:30:00-05:00')) === 5000, 'sale price $50');
  ok(pricing.premadePriceCents(new Date('2026-10-05T12:00:00-05:00')) === 7500, 'regular price $75');

  console.log('commissions:');
  const db = require('../src/db');
  await db.init();
  // Seed plans + admin for the HTTP tests below.
  const { seed } = require('../src/db/seed');
  await seed();
  const comm = require('../src/lib/commissions');
  const realGet = db.get, realInsert = db.insert;
  const rows = [];
  db.get = async (sql) => {
    if (sql.includes('commission_ledger')) return null;
    if (sql.includes('artist_id')) return { artist_id: 'artist1' };
    if (sql.includes('FROM users')) return { id: 'artist1', role: 'design_artist' };
    if (sql.includes('subscriptions')) return { id: 's1' };
    if (sql.includes('profiles')) return { payout_paypal_email: 'a@x.com' };
    return null;
  };
  db.insert = async (t, d) => { rows.push(d); return 'x'; };
  await comm.recordSaleCommissions({ id: 'o1', amount_paid_cents: 7500, design_id: 'd1', referred_shop_id: null });
  const byType = {};
  for (const r of rows) byType[r.recipient_type] = (byType[r.recipient_type] || 0) + r.amount_cents;
  ok(byType.artist === 4500, 'artist gets exactly 60%');
  ok(byType.site === 3000, 'site keeps 10% + 10% residual + 20% unassigned shop share');
  ok(rows.reduce((s, r) => s + r.amount_cents, 0) === 7500, 'splits sum to the sale total');
  db.get = realGet; db.insert = realInsert;
  await db.close();

  // --- HTTP integration ---
  console.log('http:');
  const server = spawn('node', [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
    server.stderr.on('data', (d) => process.stderr.write(d));
  });

  let r = await req('GET', '/health');
  ok(r.status === 200 && r.text.includes('"ok":true'), 'health check');

  r = await req('GET', '/');
  ok(r.status === 200 && r.text.includes('Tattoo Art Customs'), 'homepage renders');

  r = await req('GET', '/gallery');
  ok(r.status === 200, 'gallery renders');

  r = await req('GET', '/account', { follow: false });
  ok(r.status === 302, 'account requires login');

  // signup + login
  r = await req('POST', '/signup', { body: { display_name: 'Tester', email: 'buyer@test.local', password: 'password123' }, follow: false });
  ok(r.status === 302 && r.location.includes('/account'), 'signup redirects to account');
  r = await req('GET', '/account');
  ok(r.status === 200 && r.text.includes('buyer@test.local'), 'logged in after signup');

  // auth: bad login rejected
  const jar2 = {};
  const badLogin = await fetch(`http://localhost:${PORT}/login`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'buyer@test.local', password: 'wrongpass' }), redirect: 'manual',
  });
  ok(badLogin.status === 302 && badLogin.headers.get('location').includes('/login'), 'bad password rejected');

  // seed a design directly
  const Database = require('better-sqlite3');
  const sdb = new Database(process.env.SQLITE_PATH);
  const did = 'testdesign0001';
  sdb.prepare(`INSERT INTO designs (id, title, description, price_cents, status, color_path, linework_path, linework_wm_path, categories, sale_count, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(did, 'HTTP Wolf', 'desc', 7500, 'approved',
    'designs/color/w.jpg', 'designs/linework/w.jpg', 'designs/linework-wm/w-wm.jpg', '[]', 0, Date.now());
  fs.mkdirSync(path.join(process.env.ASSET_DIR, 'designs', 'linework-wm'), { recursive: true });
  fs.writeFileSync(path.join(process.env.ASSET_DIR, 'designs', 'linework-wm', 'w-wm.jpg'), 'fake');
  fs.mkdirSync(path.join(process.env.ASSET_DIR, 'designs', 'color'), { recursive: true });
  fs.writeFileSync(path.join(process.env.ASSET_DIR, 'designs', 'color', 'w.jpg'), 'fake');

  r = await req('GET', `/design/${did}`);
  ok(r.status === 200 && r.text.includes('HTTP Wolf'), 'design page renders');
  ok(!r.text.includes('designs/color/w.jpg'), 'clean color path never leaks to public page');

  // buy flow (PayPal unconfigured -> manual payment page)
  r = await req('POST', `/orders/buy/${did}`, { follow: false });
  ok(r.status === 302 && r.location.includes('/orders/manual/'), 'buy falls back to manual payment when PayPal is off');
  const orderId = r.location.split('/orders/manual/')[1];
  r = await req('POST', `/orders/manual/${orderId}`, { body: { method: 'cashapp', note: 'test' }, follow: false });
  ok(r.status === 302, 'manual payment recorded');

  // buyer cannot download before admin confirms
  r = await req('POST', `/orders/${orderId}/download-token`, { follow: false });
  ok(r.status === 302, 'download token blocked while unpaid');

  // admin login + confirm
  const adminJar = {};
  async function areq(method, p, opts = {}) {
    const h = { ...(opts.headers || {}) };
    const cookies = Object.entries(adminJar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) h.cookie = cookies;
    let payload = opts.body;
    if (payload && typeof payload === 'object') {
      payload = new URLSearchParams(payload);
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(`http://localhost:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [k, v] = c.split(';')[0].split('=');
      adminJar[k.trim()] = (v || '').trim();
    }
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  r = await areq('POST', '/login', { body: { email: 'admin@test.local', password: 'AdminTest123!' } });
  ok(r.status === 302 && (r.location || '').includes('/account'), 'admin login ok');
  r = await areq('GET', '/admin');
  ok(r.status === 200, 'admin dashboard loads');
  r = await areq('POST', `/admin/orders/${orderId}/confirm-manual`);
  ok(r.status === 302, 'admin confirms manual payment');

  // commission ledger recorded for the sale
  const ledger = sdb.prepare('SELECT recipient_type, amount_cents, status FROM commission_ledger WHERE order_id = ?').all(orderId);
  ok(ledger.length > 0 && ledger.reduce((s, x) => s + x.amount_cents, 0) === 7500, 'commissions recorded for manual sale');

  // secure download: token works, direct color path is not mounted
  r = await req('POST', `/orders/${orderId}/download-token`, { follow: false });
  ok(r.status === 302 && r.location.includes('/orders/download/') && r.location.endsWith('/view'), 'download token links to landing page');
  const token = r.location.split('/orders/download/')[1].replace('/view', '');
  r = await req('GET', `/orders/download/${token}/view`);
  ok(r.status === 200 && r.text.includes('Download full color'), 'download landing page shows both files');
  r = await req('GET', '/designs/color/w.jpg');
  ok(r.status === 404, 'private color file not reachable via public static');
  r = await req('GET', '/img/designs/w.jpg');
  ok(r.status === 404, 'private color file not reachable via img mount');

  // messaging with contact info gets flagged
  const buyerId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('buyer@test.local').id;
  const adminId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('admin@test.local').id;
  r = await req('POST', '/messages/start', { body: { to_user_id: adminId, subject: 'hi' }, follow: false });
  ok(r.status === 302 && r.location.includes('/messages/'), 'conversation started');
  const convId = r.location.split('/messages/')[1];
  r = await req('POST', `/messages/${convId}`, { body: { body: 'email me at x@y.com' }, follow: false });
  const flagged = sdb.prepare("SELECT COUNT(*) AS n FROM review_queue WHERE item_type = 'message' AND status = 'open'").get().n;
  ok(flagged >= 1, 'message with contact info flagged for review');

  // admin-only routes reject non-admins
  r = await req('GET', '/admin', { follow: false });
  ok(r.status === 403 || r.status === 302, 'non-admin blocked from admin area');

  // custom order: brief too short rejected
  r = await req('POST', '/orders/custom', { body: { brief: 'short' }, follow: false });
  ok(r.status === 302, 'short custom brief rejected');

  // SEO: robots + sitemap
  r = await req('GET', '/robots.txt');
  ok(r.status === 200 && r.text.includes('sitemap.xml'), 'robots.txt serves sitemap reference');
  r = await req('GET', '/sitemap.xml');
  ok(r.status === 200 && r.text.includes('<urlset'), 'sitemap.xml serves urlset');

  // account linking: bad creds rejected, good creds mint token, /api/me works
  const linkRes = await fetch(`http://localhost:${PORT}/api/link-account`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'buyer@test.local', password: 'wrong' }),
  });
  ok(linkRes.status === 401, 'link-account rejects bad password');
  const linkOk = await fetch(`http://localhost:${PORT}/api/link-account`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'buyer@test.local', password: 'password123' }),
  });
  const linkBody = await linkOk.json();
  ok(linkOk.status === 200 && linkBody.ok && linkBody.api_token, 'link-account mints token');
  const meRes = await fetch(`http://localhost:${PORT}/api/me`, {
    headers: { 'x-api-token': linkBody.api_token },
  });
  const meBody = await meRes.json();
  ok(meRes.status === 200 && meBody.email === 'buyer@test.local', '/api/me returns linked user');

  // bootstrap without token rejected
  r = await req('GET', '/api/bootstrap', { follow: false });
  ok(r.status === 401, 'bootstrap rejects missing token');

  // admin promotion UI: admins page loads, add/remove works
  r = await areq('GET', '/admin/admins');
  ok(r.status === 200 && r.text.includes('Add admin'), 'admins page loads');
  r = await areq('POST', '/admin/admins/add', { body: { email: 'buyer@test.local' } });
  const roleAfter = sdb.prepare('SELECT role FROM users WHERE email = ?').get('buyer@test.local').role;
  ok(roleAfter === 'admin', 'promote buyer to admin');
  r = await areq('POST', '/admin/admins/remove', { body: { id: buyerId } });
  const roleBack = sdb.prepare('SELECT role FROM users WHERE email = ?').get('buyer@test.local').role;
  ok(roleBack === 'customer', 'demote admin back to customer');
  // cannot remove own admin access
  r = await areq('POST', '/admin/admins/remove', { body: { id: adminId } });
  const stillAdmin = sdb.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'admin@test.local' AND role = 'admin'").get().n;
  ok(stillAdmin === 1, 'cannot remove own admin access');

  // cashout options: destinations + early cashout with 3% fee
  const cashout = require('../src/lib/cashout');
  await db.init(); // re-open: the commissions unit test closed the handle above
  const q = cashout.earlyQuote(10000);
  ok(q.penaltyCents === 300 && q.netCents === 9700, 'early cashout quote: 3% fee');
  ok(Object.keys(cashout.DEST_TYPES).join(',').includes('bank') && cashout.DEST_TYPES.paypal.auto === 'paypal', 'destination types include bank + PayPal');
  // seed a payable artist balance for the buyer + grant an active designer
  // subscription with a payout email (payouts require both)
  const { randomUUID } = require('crypto');
  sdb.prepare("INSERT INTO commission_ledger (id, order_id, recipient_type, recipient_id, amount_cents, status, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(randomUUID(), 'o-test', 'artist', buyerId, 10000, 'payable', Date.now());
  const dplanId = sdb.prepare("SELECT id FROM plans WHERE slug = 'design_artist'").get().id;
  sdb.prepare("INSERT INTO subscriptions (id, user_id, plan_id, status, created_at) VALUES (?,?,?,?,?)")
    .run(randomUUID(), buyerId, dplanId, 'active', Date.now());
  const { upsertProfile } = require('../src/lib/profiles');
  await upsertProfile('artist_profiles', buyerId, { payout_paypal_email: 'buyer@pay.test' });
  const zelleId = await cashout.addDestination({ userId: buyerId, recipientType: 'artist', destType: 'zelle', details: { identifier: 'buyer@test.local' } });
  ok(!!zelleId, 'zelle destination added');
  const req1 = await cashout.requestEarlyCashout({ userId: buyerId, recipientType: 'artist', destinationId: zelleId });
  ok(req1.status === 'pending' && req1.penalty_cents === 300 && req1.net_cents === 9700, 'early cashout to manual rail queues pending with 3% fee');
  const queuedN = sdb.prepare("SELECT COUNT(*) AS n FROM commission_ledger WHERE cashout_id = ? AND status = 'queued'").get(req1.id).n;
  ok(queuedN === 1, 'ledger rows claimed by cashout');
  let cooldownHit = false;
  try { await cashout.requestEarlyCashout({ userId: buyerId, recipientType: 'artist', destinationId: zelleId }); }
  catch (e) { cooldownHit = /once a day/.test(e.message); }
  ok(cooldownHit, 'second early cashout within 24h rejected');
  // admin marks it sent -> ledger paid
  await cashout.completeCashout(req1.id, 'test send');
  const paidN = sdb.prepare("SELECT COUNT(*) AS n FROM commission_ledger WHERE cashout_id = ? AND status = 'paid'").get(req1.id).n;
  ok(paidN === 1, 'admin send marks ledger paid');
  // cashout mode toggle
  await cashout.setCashoutMode(buyerId, 'artist', 'manual');
  ok((await cashout.getCashoutMode(buyerId, 'artist')) === 'manual', 'cashout mode set to manual');

  // /wallet hub: customer lands on their site credit
  r = await req('GET', '/wallet', { follow: false });
  ok(r.status === 302 && r.location === '/account#credit', 'wallet hub redirects customer to site credit');

  // site credit: top-up ledger, commissions-to-credit, withdrawal, pay-with-credit
  const credits = require('../src/lib/credits');
  await credits.addCredit({ userId: buyerId, amountCents: 5000, kind: 'topup', note: 'test topup' });
  ok((await credits.getCreditBalance(buyerId)) === 5000, 'credit balance sums ledger');
  // move payable commissions to credit (no fee)
  sdb.prepare("INSERT INTO commission_ledger (id, order_id, recipient_type, recipient_id, amount_cents, status, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(randomUUID(), 'o-test2', 'artist', buyerId, 8000, 'payable', Date.now());
  const moved = await credits.moveCommissionsToCredit({ userId: buyerId, recipientType: 'artist' });
  ok(moved.creditedCents === 8000 && (await credits.getCreditBalance(buyerId)) === 13000, 'commissions moved to site credit, no fee');
  // withdrawal: separate user to avoid the 24h cashout cooldown
  r = await req('POST', '/signup', { body: { display_name: 'Wallet', email: 'wallet@test.local', password: 'password123' }, follow: false });
  const walletId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('wallet@test.local').id;
  await credits.addCredit({ userId: walletId, amountCents: 10000, kind: 'topup', note: 'test' });
  const wdest = await cashout.addDestination({ userId: walletId, recipientType: 'customer', destType: 'venmo', details: { handle: '@wallettest' } });
  const wd = await credits.requestWithdrawal({ userId: walletId, destinationId: wdest, amountCents: 10000 });
  ok(wd.status === 'pending' && wd.penalty_cents === 300 && wd.net_cents === 9700 && wd.source === 'credit', 'withdrawal queues pending with 3% auto-withheld');
  ok((await credits.getCreditBalance(walletId)) === 0, 'withdrawal debits credit');
  await cashout.completeCashout(wd.id, 'test send');
  ok((await credits.getCreditBalance(walletId)) === 0, 'completed withdrawal keeps credit debited');
  // pay for an order with site credit
  const worderId = randomUUID();
  sdb.prepare("INSERT INTO orders (id, buyer_id, design_id, order_type, amount_cents, status, payment_method, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(worderId, walletId, did, 'premade', 7500, 'pending', 'paypal', Date.now());
  await credits.addCredit({ userId: walletId, amountCents: 8000, kind: 'topup', note: 'test' });
  const paid = await credits.payOrderWithCredit({ userId: walletId, orderId: worderId });
  ok(paid.order.status === 'paid' && paid.order.payment_method === 'credit', 'order paid with site credit');
  const commRows = sdb.prepare('SELECT COUNT(*) AS n FROM commission_ledger WHERE order_id = ?').get(worderId).n;
  ok(commRows > 0, 'commissions recorded for credit-paid order');

  // free art uploads: any logged-in account (customer, no subscription)
  r = await req('POST', '/signup', { body: { display_name: 'Cust', email: 'cust@test.local', password: 'password123' }, follow: false });
  const custId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('cust@test.local').id;
  r = await req('GET', '/account/upload');
  ok(r.status === 200 && r.text.includes('Upload your art'), 'upload page open to any logged-in user');
  const upForm = new FormData();
  upForm.append('title', 'Customer Doodle');
  upForm.append('color', new Blob(['colorbytes'], { type: 'image/jpeg' }), 'c.jpg');
  upForm.append('linework', new Blob(['linebytes'], { type: 'image/png' }), 'l.png');
  const upRes = await fetch(`http://localhost:${PORT}/account/upload`, {
    method: 'POST',
    headers: { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
    body: upForm, redirect: 'manual',
  });
  ok(upRes.status === 302 && upRes.headers.get('location') === '/account', 'customer uploads art free, no subscription needed');
  const upDesign = sdb.prepare('SELECT status, artist_id FROM designs WHERE title = ?').get('Customer Doodle');
  ok(upDesign && upDesign.status === 'pending' && upDesign.artist_id === custId, 'upload held pending admin approval');
  const galCount = sdb.prepare("SELECT COUNT(*) AS n FROM designs WHERE title = 'Customer Doodle' AND status = 'approved'").get().n;
  ok(galCount === 0, 'unapproved upload is not live');

  // payouts require an active designer/shop subscription (customer = never)
  sdb.prepare("INSERT INTO commission_ledger (id, order_id, recipient_type, recipient_id, amount_cents, status, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(randomUUID(), 'o-elig', 'artist', walletId, 6000, 'payable', Date.now());
  let eligErr = '';
  try { await cashout.requestEarlyCashout({ userId: walletId, recipientType: 'artist', destinationId: wdest }); }
  catch (e) { eligErr = e.message; }
  ok(/subscription/i.test(eligErr), 'early cashout blocked without designer/shop subscription');
  let moveErr = '';
  try { await credits.moveCommissionsToCredit({ userId: walletId, recipientType: 'artist' }); }
  catch (e) { moveErr = e.message; }
  ok(/subscription/i.test(moveErr), 'commission-to-credit blocked without subscription');
  // commission-derived site credit cannot be withdrawn without subscription…
  await credits.addCredit({ userId: custId, amountCents: 20000, kind: 'commission_move', note: 'test commission credit' });
  const custDest = await cashout.addDestination({ userId: custId, recipientType: 'customer', destType: 'zelle', details: { identifier: 'cust@test.local' } });
  let wdErr = '';
  try { await credits.requestWithdrawal({ userId: custId, destinationId: custDest, amountCents: 20000 }); }
  catch (e) { wdErr = e.message; }
  ok(/subscription/i.test(wdErr), 'commission credit withdrawal blocked without subscription');
  // …but your own topped-up money is always withdrawable
  sdb.prepare("UPDATE cashout_requests SET created_at = ? WHERE user_id = ?").run(Date.now() - 25 * 3600 * 1000, walletId);
  const wOwn = await credits.requestWithdrawal({ userId: walletId, destinationId: wdest, amountCents: 500 });
  ok(wOwn.status === 'pending' && wOwn.net_cents === 485, 'own top-up money withdrawable without subscription');

  // grant the customer an active designer subscription + payout email
  const planId = sdb.prepare("SELECT id FROM plans WHERE slug = 'design_artist'").get().id;
  sdb.prepare("INSERT INTO subscriptions (id, user_id, plan_id, status, created_at) VALUES (?,?,?,?,?)")
    .run(randomUUID(), custId, planId, 'active', Date.now());
  await cashout.setCashoutMode(custId, 'artist', 'manual');
  sdb.prepare("UPDATE artist_profiles SET payout_paypal_email = ? WHERE user_id = ?").run('cust@pay.test', custId);
  r = await req('GET', '/artist/upload', { follow: false });
  ok(r.status === 302 && r.location === '/account/upload', 'artist upload redirects to shared free upload page');
  const wSub = await credits.requestWithdrawal({ userId: custId, destinationId: custDest, amountCents: 20000 });
  ok(wSub.status === 'pending' && wSub.net_cents === 19400, 'subscribed designer can withdraw commission credit');

  // weekly autopayout skips recipients whose subscription lapsed
  const autopayout = require('../src/lib/autopayout');
  const summary = await autopayout.runWeeklyPayouts();
  ok(summary.skipped.some((s) => s.recipient_id === walletId && /subscription/i.test(s.reason)),
    'weekly payout holds balance when subscription is not active');

  sdb.close();
  server.kill();
  await new Promise((res2) => server.on('exit', res2));

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness error:', e); process.exit(1); });
