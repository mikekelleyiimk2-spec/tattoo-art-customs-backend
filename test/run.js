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

  console.log('sla:');
  const sla = require('../src/lib/slaEnforcer');
  const { getCreditBalance } = require('../src/lib/credits');
  const slaBuyerId = await db.insert('users', { email: 'slabuyer@test.local', password_hash: 'x', role: 'customer', display_name: 'Buyer' });
  const slaDesignerId = await db.insert('users', { email: 'sladesigner@test.local', password_hash: 'x', role: 'design_artist', display_name: 'Designer' });
  const slaNow = Date.now();
  const slaOrderId = await db.insert('orders', {
    buyer_id: slaBuyerId, order_type: 'custom', amount_cents: 12500, deposit_cents: 6250,
    amount_paid_cents: 12500, status: 'paid', custom_status: 'routed_to_artist',
    requested_artist_id: slaDesignerId, custom_brief: 'SLA test custom design brief for penalty math.',
    delivery_due: slaNow - Math.floor(2.5 * 86400000), paid_at: slaNow - 3 * 86400000,
  });
  const slaOrd = await db.get('SELECT * FROM orders WHERE id = ?', [slaOrderId]);
  await comm.recordSaleCommissions(slaOrd);
  const slaOrig = await comm.recordCustomDesignerCommission(slaOrd, slaDesignerId);
  ok(slaOrig === 7500, 'custom designer original commission = 60% of $125 = $75.00');
  // 2.5 days late -> days 1-2 charged
  const slaR1 = await sla.applyPenalties({ now: slaNow });
  ok(slaR1.penalties.length === 2, 'two late days charged at +2.5d');
  const slaPens = await sla.penaltyLedger(slaOrderId);
  ok(slaPens.length === 2 && slaPens[0].day_number === 1 && slaPens[1].day_number === 2, 'penalty ledger holds days 1-2');
  ok(slaPens[0].deduction_cents === 278 && slaPens[0].owner_cents === 150 && slaPens[0].credit_cents === 128,
    'day-1 math: 3.7% of 7500 = 278 deducted; 150 owner; 128 buyer credit');
  const slaDrow = await db.get(
    `SELECT * FROM commission_ledger WHERE order_id = ? AND recipient_type = 'artist' AND recipient_id = ?`,
    [slaOrderId, slaDesignerId]);
  ok(slaDrow.amount_cents === 7500 - 556, 'designer commission reduced by 2x278');
  const slaOwnerId = (await db.get('SELECT id FROM users WHERE email = ?', ['admin@test.local'])).id;
  const slaOrow = await db.get(
    `SELECT COALESCE(SUM(amount_cents),0) AS t FROM commission_ledger
     WHERE order_id = ? AND recipient_type = 'site' AND recipient_id = ? AND status = 'payable'`,
    [slaOrderId, slaOwnerId]);
  ok(slaOrow.t === 300, 'owner payable balance +300 (2 days x 150)');
  ok((await getCreditBalance(slaBuyerId)) === 256, 'buyer late-delivery site credit +256 (2 days x 128)');
  // idempotency
  const slaR2 = await sla.applyPenalties({ now: slaNow });
  ok(slaR2.penalties.length === 0 && (await sla.penaltyLedger(slaOrderId)).length === 2,
    'rerun charges nothing — idempotent');
  ok((await db.get('SELECT late_penalty_days AS d FROM orders WHERE id = ?', [slaOrderId])).d === 2,
    'orders.late_penalty_days = 2');
  // jump to 7.5 days late -> days 3-7 charged, order termination fires
  const slaR3 = await sla.applyPenalties({ now: slaOrd.delivery_due + Math.floor(7.5 * 86400000) });
  ok(slaR3.penalties.length === 5, 'days 3-7 charged at +7.5d');
  ok(slaR3.terminations.length === 1, 'day-7 order termination fired');
  const slaP7 = await sla.penaltyLedger(slaOrderId);
  ok(slaP7.length === 7, 'seven penalty rows total');
  ok(slaP7[4].deduction_cents === 323 && slaP7[4].owner_cents === 150 && slaP7[4].credit_cents === 173,
    'day-5 math: 4.3% of 7500 = 323 deducted; 150 owner; 173 buyer credit');
  const slaD7 = await db.get(
    `SELECT amount_cents FROM commission_ledger WHERE order_id = ? AND recipient_type = 'artist' AND recipient_id = ?`,
    [slaOrderId, slaDesignerId]);
  ok(slaD7.amount_cents === 5419, 'designer keeps 5419 after 7 days (7500 - 2081)');
  ok((await getCreditBalance(slaBuyerId)) === 1031, 'buyer credit total 1031 after 7 days');
  ok((await db.get('SELECT COALESCE(sla_suspended,0) AS s FROM users WHERE id = ?', [slaDesignerId])).s === 0,
    'designer account NEVER auto-suspended at day-7');
  ok((await db.get('SELECT role FROM users WHERE id = ?', [slaDesignerId])).role === 'design_artist',
    'designer role unchanged at day-7');
  const slaO7 = await db.get(
    `SELECT designer_contract_terminated AS t, replacement_status AS r,
            deadline_missed AS m, custom_status AS s FROM orders WHERE id = ?`, [slaOrderId]);
  ok(slaO7.t === 1 && slaO7.r === 'offered' && slaO7.m === 1 && slaO7.s === 'order_terminated',
    'order terminated for the customer: assignment ended, miss recorded, replacement offered');
  const slaConvs = await db.get(
    `SELECT COUNT(*) AS n FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id
     WHERE p.user_id = ? AND c.subject LIKE '%taken care of%'`, [slaBuyerId]);
  ok(slaConvs.n === 1, 'purchaser notified on-site at termination');
  // reminders: idempotent per order+key
  const slaOrder2Id = await db.insert('orders', {
    buyer_id: slaBuyerId, order_type: 'custom', amount_cents: 12500,
    amount_paid_cents: 12500, status: 'paid', custom_status: 'routed_to_artist',
    requested_artist_id: slaDesignerId, custom_brief: 'Second SLA test brief.',
    delivery_due: slaNow + 12 * 3600 * 1000, paid_at: slaNow,
  });
  const slaS1 = await sla.sendDueReminders({ now: slaNow });
  ok(slaS1.some((r) => r.order_id === slaOrder2Id && r.key === 'warn_24h'), '24h-warning reminder sent to artist');
  const slaS2 = await sla.sendDueReminders({ now: slaNow });
  ok(slaS2.length === 0, 'reminders idempotent — nothing re-sent');
  const slaWl = await sla.slaWatchlist({ now: slaNow });
  ok(slaWl.overdue.some((o) => o.id === slaOrderId), 'watchlist lists the overdue order');
  ok(slaWl.atRisk.some((o) => o.id === slaOrder2Id), 'watchlist lists the at-risk order');

  // --- Tier 1 repeat offender: 4+ misses in 30 days -> 2x rates ---
  console.log('sla repeat offender:');
  const repDesignerId = await db.insert('users', { email: 'repdesigner@test.local', password_hash: 'x', role: 'design_artist', display_name: 'Rep' });
  const repBuyerId = await db.insert('users', { email: 'repbuyer@test.local', password_hash: 'x', role: 'customer', display_name: 'RepBuyer' });
  const repMissIds = [];
  for (let i = 0; i < 4; i++) {
    repMissIds.push(await db.insert('orders', {
      buyer_id: repBuyerId, order_type: 'custom', amount_cents: 12500,
      amount_paid_cents: 12500, status: 'paid', custom_status: 'order_terminated',
      designer_contract_terminated: 1, late_penalty_days: 7, replacement_status: 'offered',
      requested_artist_id: repDesignerId, deadline_missed: 1,
      deadline_missed_at: slaNow - i * 5 * 86400000,
      delivery_due: slaNow - 20 * 86400000, paid_at: slaNow - 21 * 86400000,
    }));
  }
  const repInfo = await sla.repeatOffenderInfo(repDesignerId, slaNow);
  ok(repInfo.active && repInfo.misses === 4, '4 misses in 30d -> repeat offender active');
  ok(repInfo.liftsAt > slaNow, 'repeat-offender lift date is in the future');
  const repOrderId = await db.insert('orders', {
    buyer_id: repBuyerId, order_type: 'custom', amount_cents: 12500,
    amount_paid_cents: 12500, status: 'paid', custom_status: 'routed_to_artist',
    requested_artist_id: repDesignerId, custom_brief: 'Repeat offender late order.',
    delivery_due: slaNow - Math.floor(1.5 * 86400000), paid_at: slaNow - 2 * 86400000,
  });
  const repOrd = await db.get('SELECT * FROM orders WHERE id = ?', [repOrderId]);
  await comm.recordCustomDesignerCommission(repOrd, repDesignerId);
  await sla.applyPenalties({ now: slaNow });
  const repPen = (await sla.penaltyLedger(repOrderId))[0];
  ok(repPen.deduction_cents === 555 && repPen.owner_cents === 150 && repPen.credit_cents === 405 && repPen.rate_mult === 2,
    '2x rates: day-1 7.4% of 7500 = 555 deducted; 150 owner; 405 buyer apology credit');
  // status lifts when the oldest miss ages out of the 30d window
  await db.update('orders', repMissIds[0], { deadline_missed_at: slaNow - 31 * 86400000 });
  const repInfo2 = await sla.repeatOffenderInfo(repDesignerId, slaNow);
  ok(!repInfo2.active && repInfo2.misses === 3, '3 misses in 30d -> repeat offender lifts');
  // admin forgive resets the count
  await db.update('orders', repMissIds[0], { deadline_missed_at: slaNow - 2 * 86400000 });
  ok((await sla.repeatOffenderInfo(repDesignerId, slaNow)).active, '4 misses again -> active');
  await db.update('users', repDesignerId, { sla_forgiven_at: slaNow });
  const repInfo3 = await sla.repeatOffenderInfo(repDesignerId, slaNow);
  ok(!repInfo3.active && repInfo3.misses === 0, 'forgive resets the missed-deadline count');

  // --- SLA tone: firm but warm, no hostile language ---
  console.log('sla tone:');
  const toneOrder = { id: 'o123456789', delivery_due: slaNow + 3600000, custom_brief: 'x' };
  const warn = sla.reminderCopy('warn_24h', toneOrder, 0, 'Artist');
  ok(!/FINAL WARNING|shame|stupid|lazy|idiot/i.test(warn.body + warn.subject), 'artist 24h warning has no hostile language');
  const late5 = sla.reminderCopy('late_5', toneOrder, 1000, 'Artist');
  ok(!/FINAL WARNING/i.test(late5.body + late5.subject), 'late-day notice has no FINAL WARNING');
  ok(/reply here and we'll help/i.test(late5.body), 'late-day notice offers help');
  const delay = sla.buyerDelayCopy({ id: 'o123456789' }, 'Buyer', 128);
  ok(/apology credit/i.test(delay.body), 'buyer delay notice frames credit as an apology');
  ok(!/terminated/i.test(delay.body), 'buyer delay notice has no termination language');
  const termMsg = await db.get(
    `SELECT m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id
     JOIN conversation_participants p ON p.conversation_id = c.id
     WHERE p.user_id = ? AND c.subject LIKE '%taken care of%'`, [slaBuyerId]);
  ok(termMsg && /apology/i.test(termMsg.body), 'day-7 buyer message apologizes');
  ok(termMsg && !/contract is terminated|designer.*terminated/i.test(termMsg.body), 'day-7 buyer message has no designer-contract-termination language');
  ok(sla.REPEAT_OFFENDER_NOTICE === 'Late penalties are currently doubled because 4+ deadlines were missed in the last 30 days.',
    'repeat-offender notice wording is plain and neutral');

  // --- Tier 2: commission suspension (6+ misses in 60 days) ---
  console.log('sla tier2:');
  const t2DesignerId = await db.insert('users', { email: 't2designer@test.local', password_hash: 'x', role: 'design_artist', display_name: 'T2' });
  const t2BuyerId = await db.insert('users', { email: 't2buyer@test.local', password_hash: 'x', role: 'customer', display_name: 'T2Buyer' });
  const t2PlanId = (await db.get(`SELECT id FROM plans WHERE slug = 'design_artist'`)).id;
  await db.insert('subscriptions', {
    user_id: t2DesignerId, plan_id: t2PlanId, status: 'active',
    paypal_subscription_id: 'sub-tier2-test', created_at: slaNow,
  });
  const t2MissIds = [];
  for (let i = 0; i < 6; i++) {
    t2MissIds.push(await db.insert('orders', {
      buyer_id: t2BuyerId, order_type: 'custom', amount_cents: 12500,
      amount_paid_cents: 12500, status: 'paid', custom_status: 'order_terminated',
      designer_contract_terminated: 1, late_penalty_days: 7, replacement_status: 'offered',
      requested_artist_id: t2DesignerId, deadline_missed: 1,
      deadline_missed_at: slaNow - i * 7 * 86400000,
      delivery_due: slaNow - 30 * 86400000, paid_at: slaNow - 31 * 86400000,
    }));
  }
  const t2trig = await comm.refreshCommissionSuspensions({ now: slaNow });
  ok(t2trig.length === 1 && t2trig[0].designer_id === t2DesignerId, '6th miss in 60d triggers commission suspension');
  const t2until = await comm.commissionSuspendedUntil(t2DesignerId, slaNow);
  ok(t2until && t2until > slaNow + 29 * 86400000 && t2until <= slaNow + 30 * 86400000 + 60000,
    'suspension lasts 30 days');
  ok(await comm.commissionSuspended(t2DesignerId, slaNow), 'designer is commission-suspended');
  // new custom order during suspension: 0c designer, owner keeps the share
  const t2OrderId = await db.insert('orders', {
    buyer_id: t2BuyerId, order_type: 'custom', amount_cents: 12500,
    amount_paid_cents: 12500, status: 'paid', custom_status: 'new',
    requested_artist_id: t2DesignerId, custom_brief: 'Tier2 custom order during suspension.',
    delivery_due: slaNow + 48 * 3600 * 1000, paid_at: slaNow,
  });
  const t2Ord = await db.get('SELECT * FROM orders WHERE id = ?', [t2OrderId]);
  await comm.recordSaleCommissions(t2Ord);
  const t2c = await comm.recordCustomDesignerCommission(t2Ord, t2DesignerId);
  ok(t2c === 0, 'suspended designer books 0c custom commission');
  const t2crow = await db.get(
    `SELECT amount_cents FROM commission_ledger WHERE order_id = ? AND recipient_type = 'artist' AND recipient_id = ?`,
    [t2OrderId, t2DesignerId]);
  ok(t2crow.amount_cents === 0, 'ledger shows explicit 0c designer row');
  const t2site = await db.get(
    `SELECT COALESCE(SUM(amount_cents),0) AS t FROM commission_ledger WHERE order_id = ? AND recipient_type = 'site'`,
    [t2OrderId]);
  ok(t2site.t === 12500, 'owner keeps the full share while designer is suspended');
  // routing skips suspended designers
  const { routeCustomOrder } = require('../src/lib/customFulfillment');
  const t2routed = await routeCustomOrder({ ...t2Ord, custom_status: 'new' });
  ok(t2routed.custom_status === 'needs_drafts', 'routing skips commission-suspended designers');
  // premade sale: designer 60% redirected to owner payable, shop/site shares unchanged
  const t2DesignId = await db.insert('designs', {
    artist_id: t2DesignerId, title: 'T2 Design', status: 'approved',
    price_cents: 7500, created_at: slaNow,
  });
  const t2PreId = await db.insert('orders', {
    buyer_id: t2BuyerId, order_type: 'premade', amount_cents: 7500,
    amount_paid_cents: 7500, status: 'paid', design_id: t2DesignId, paid_at: slaNow,
  });
  const t2Pre = await db.get('SELECT * FROM orders WHERE id = ?', [t2PreId]);
  await comm.recordSaleCommissions(t2Pre);
  const t2prow = await db.get(
    `SELECT amount_cents FROM commission_ledger WHERE order_id = ? AND recipient_type = 'artist'`, [t2PreId]);
  ok(t2prow.amount_cents === 0, 'premade: suspended designer gets 0c');
  const t2owner = await db.get(
    `SELECT COALESCE(SUM(amount_cents),0) AS t FROM commission_ledger
     WHERE order_id = ? AND recipient_type = 'site' AND recipient_id = ? AND status = 'payable'`,
    [t2PreId, slaOwnerId]);
  ok(t2owner.t === 4500, 'premade: designer 60% ($45) redirected to owner payable');
  // suspension lifts after 30 days when misses age out
  await db.update('users', t2DesignerId, { commission_suspended_until: slaNow - 1000 });
  for (const mid of t2MissIds) await db.update('orders', mid, { deadline_missed_at: slaNow - 61 * 86400000 });
  const t2lift = await comm.refreshCommissionSuspensions({ now: slaNow });
  ok(t2lift.length === 0 && !(await comm.commissionSuspended(t2DesignerId, slaNow)),
    'suspension lifts after 30 days when misses age out');
  // renew: misses still within 60 days when suspension expires
  for (const mid of t2MissIds) await db.update('orders', mid, { deadline_missed_at: slaNow - 10 * 86400000 });
  await db.update('users', t2DesignerId, { commission_suspended_until: slaNow - 1000 });
  const t2renew = await comm.refreshCommissionSuspensions({ now: slaNow });
  const t2until3 = await comm.commissionSuspendedUntil(t2DesignerId, slaNow);
  ok(t2renew.length === 1 && t2until3 > slaNow + 29 * 86400000,
    'suspension renews for 30 more days when misses persist');
  // account + subscription never touched
  const t2u = await db.get(`SELECT role, COALESCE(sla_suspended,0) AS s FROM users WHERE id = ?`, [t2DesignerId]);
  ok(t2u.role === 'design_artist' && t2u.s === 0, 'designer account never auto-suspended');
  const t2sub = await db.get(`SELECT status FROM subscriptions WHERE user_id = ?`, [t2DesignerId]);
  ok(t2sub.status === 'active', 'designer subscription untouched by tier-2 suspension');

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

  // artist dashboard: SLA banner + tier-2 suspension notice render
  const bcrypt = require('bcryptjs');
  const artJar = {};
  async function artreq(method, p, opts = {}) {
    const h = { ...(opts.headers || {}) };
    const cookies = Object.entries(artJar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) h.cookie = cookies;
    let payload = opts.body;
    if (payload && typeof payload === 'object') {
      payload = new URLSearchParams(payload);
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(`http://localhost:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [k, v] = c.split(';')[0].split('=');
      artJar[k.trim()] = (v || '').trim();
    }
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  const bannerArtistId = await db.insert('users', {
    email: 'banner@test.local', password_hash: await bcrypt.hash('ArtistPass123!', 10),
    role: 'design_artist', display_name: 'Banner Artist',
  });
  const artPlanId = (await db.get(`SELECT id FROM plans WHERE slug = 'design_artist'`)).id;
  await db.insert('subscriptions', {
    user_id: bannerArtistId, plan_id: artPlanId, status: 'active',
    paypal_subscription_id: 'sub-banner-test', created_at: Date.now(),
  });
  const bannerBuyerId = await db.insert('users', { email: 'bannerbuyer@test.local', password_hash: 'x', role: 'customer', display_name: 'BB' });
  await db.insert('orders', {
    buyer_id: bannerBuyerId, order_type: 'custom', amount_cents: 12500,
    amount_paid_cents: 12500, status: 'paid', custom_status: 'routed_to_artist',
    requested_artist_id: bannerArtistId, custom_brief: 'Banner test brief.',
    delivery_due: Date.now() + 6 * 3600 * 1000, paid_at: Date.now(),
  });
  r = await artreq('POST', '/login', { body: { email: 'banner@test.local', password: 'ArtistPass123!' } });
  ok(r.status === 302, 'artist login ok');
  r = await artreq('GET', '/artist');
  ok(r.status === 200 && r.text.includes('Delivery deadlines'), 'artist dashboard renders SLA banner');
  ok(!r.text.includes('Commissions are paused until'), 'no suspension notice when not suspended');
  await db.update('users', bannerArtistId, { commission_suspended_until: Date.now() + 10 * 86400000 });
  r = await artreq('GET', '/artist');
  ok(r.status === 200 && r.text.includes('Commissions are paused until'), 'suspended artist sees pause notice');
  ok(r.text.includes('6+ deadlines were missed in the last 60 days'), 'pause notice states the reason plainly');

  sdb.close();
  server.kill();
  await new Promise((res2) => server.on('exit', res2));

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness error:', e); process.exit(1); });
