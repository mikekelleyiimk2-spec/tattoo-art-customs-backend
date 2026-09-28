// Test suite: `npm test`. Spins up the app on a temp SQLite DB and
// exercises the business rules end to end over HTTP, plus lib unit checks.
// Exits non-zero on the first failure.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tac-test-'));
process.env.NODE_ENV = 'test'; // relaxes rate limits for the suite (production unaffected)
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
  // Member early sale entry: members get the sale price from 6 PM Saturday
  // CT; non-members wait until the public 7 PM window.
  ok(pricing.premadePriceCents(new Date('2026-10-03T18:30:00-05:00'), true) === 5000, 'member early entry: $50 at 6:30pm CT');
  ok(pricing.premadePriceCents(new Date('2026-10-03T18:30:00-05:00'), false) === 7500, 'nonmember still $75 at 6:30pm CT');
  ok(pricing.premadePriceCents(new Date('2026-10-03T17:59:00-05:00'), true) === 7500, 'member early entry starts at 6:00pm sharp');
  ok(pricing.premadePriceCents(new Date('2026-10-03T19:00:00-05:00')) === 5000, 'public sale still starts at 7pm');
  ok(pricing.premadePriceCents(new Date('2026-10-05T12:00:00-05:00'), true) === 7500, 'member pays regular outside sale');

  console.log('subscription incentives (config + paypal billing):');
  const cfg = require('../src/config');
  ok(cfg.pricing.firstMonth.priceCents === 100, '$1 first-month price');
  ok(cfg.pricing.foundingShop.priceCents === 7999, '$79.99 founding-shop price');
  ok(cfg.pricing.plans.customer_annual && cfg.pricing.plans.customer_annual.priceCents === 5000, 'annual customer plan $50/year');
  ok(cfg.foundingShopActive(), 'founding-shop window open (fallback ends 2027-03-01)');
  ok(cfg.foundingShopWindowEnd === Date.parse('2027-03-01T00:00:00-06:00'), 'founding window is a fixed date, not rolling');
  const paypal = require('../src/lib/paypal');
  const trial = paypal.firstMonthTrialCycles(500);
  ok(trial[0].pricing_scheme.fixed_price.value === '1.00' && trial[1].pricing_scheme.fixed_price.value === '5.00', '$1 first month then $5/mo billing cycles');
  ok(trial[0].total_cycles === 1 && trial[1].sequence === 2, 'trial cycle count/sequence');
  const founding = paypal.foundingShopCycles();
  ok(founding[0].pricing_scheme.fixed_price.value === '79.99' && founding[0].total_cycles === 1, 'founding shop first year $79.99 for 1 cycle');
  ok(founding[1].pricing_scheme.fixed_price.value === '99.99', 'founding shop renews at $99.99');

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
  ok(byType.artist === 5250, 'artist gets 70% (60% + half the unassigned 20% shop share)');
  ok(byType.site === 2250, 'site keeps 20% owner + 10% site of the unassigned shop share');
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
  ok(slaOrig === 8750, 'custom designer original commission = 70% of $125 = $87.50');
  // 2.5 days late -> days 1-2 charged
  const slaR1 = await sla.applyPenalties({ now: slaNow });
  ok(slaR1.penalties.length === 2, 'two late days charged at +2.5d');
  const slaPens = await sla.penaltyLedger(slaOrderId);
  ok(slaPens.length === 2 && slaPens[0].day_number === 1 && slaPens[1].day_number === 2, 'penalty ledger holds days 1-2');
  ok(slaPens[0].deduction_cents === 324 && slaPens[0].owner_cents === 175 && slaPens[0].credit_cents === 149,
    'day-1 math: 3.7% of 8750 = 324 deducted; 175 owner; 149 buyer credit');
  const slaDrow = await db.get(
    `SELECT * FROM commission_ledger WHERE order_id = ? AND recipient_type = 'artist' AND recipient_id = ?`,
    [slaOrderId, slaDesignerId]);
  ok(slaDrow.amount_cents === 8750 - 648, 'designer commission reduced by 2x324');
  const slaOwnerId = (await db.get('SELECT id FROM users WHERE email = ?', ['admin@test.local'])).id;
  const slaOrow = await db.get(
    `SELECT COALESCE(SUM(amount_cents),0) AS t FROM commission_ledger
     WHERE order_id = ? AND recipient_type = 'site' AND recipient_id = ? AND status = 'payable'`,
    [slaOrderId, slaOwnerId]);
  ok(slaOrow.t === 350, 'owner payable balance +350 (2 days x 175)');
  ok((await getCreditBalance(slaBuyerId)) === 298, 'buyer late-delivery site credit +298 (2 days x 149)');
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
  ok(slaP7[4].deduction_cents === 376 && slaP7[4].owner_cents === 175 && slaP7[4].credit_cents === 201,
    'day-5 math: 4.3% of 8750 = 376 deducted; 175 owner; 201 buyer credit');
  const slaD7 = await db.get(
    `SELECT amount_cents FROM commission_ledger WHERE order_id = ? AND recipient_type = 'artist' AND recipient_id = ?`,
    [slaOrderId, slaDesignerId]);
  ok(slaD7.amount_cents === 6326, 'designer keeps 6326 after 7 days (8750 - 2424)');
  ok((await getCreditBalance(slaBuyerId)) === 1199, 'buyer credit total 1199 after 7 days');
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
  ok(repPen.deduction_cents === 648 && repPen.owner_cents === 175 && repPen.credit_cents === 473 && repPen.rate_mult === 2,
    '2x rates: day-1 7.4% of 8750 = 648 deducted; 175 owner; 473 buyer apology credit');
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
  // premade sale: designer 70% (60% + no-shop half-share) redirected to owner payable, shop/site shares unchanged
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
  ok(t2owner.t === 5250, 'premade: designer 70% ($52.50) redirected to owner payable');
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

  console.log('refer-a-friend + $1 first month:');
  const refs = require('../src/lib/referrals');
  const referrerId = await db.insert('users', { email: 'referrer@test.local', password_hash: 'x', role: 'customer', display_name: 'Referrer' });
  const friendId = await db.insert('users', { email: 'friend@test.local', password_hash: 'x', role: 'customer', display_name: 'Friend' });
  const refCode = await refs.ensureReferralCode(referrerId);
  ok(/^TAC-[A-Z0-9]{6}$/.test(refCode), 'referral code generated in TAC-XXXXXX form');
  ok((await refs.ensureReferralCode(referrerId)) === refCode, 'referral code stable on repeat');
  ok((await refs.recordSignupReferral(friendId, refCode)) === referrerId, 'signup records referred_by');
  const friendOwnCode = await refs.ensureReferralCode(friendId);
  ok(!(await refs.recordSignupReferral(friendId, friendOwnCode)), 'no self-referral with own code');
  ok(await refs.firstMonthDiscountEligible(friendId), 'friend eligible for $1 first month');
  await refs.markFirstMonthUsed(friendId);
  ok(!(await refs.firstMonthDiscountEligible(friendId)), '$1 first month applies exactly once');
  // Friend becomes a paying subscriber -> referrer earns one free month.
  const { randomUUID } = require('crypto');
  const cplanId = (await db.get("SELECT id FROM plans WHERE slug = 'customer'")).id;
  const fsubId = await db.insert('subscriptions', { id: randomUUID(), user_id: friendId, plan_id: cplanId, status: 'active', created_at: db.now() });
  const grant1 = await refs.grantReferralReward(friendId, fsubId);
  ok(!!grant1 && grant1.referrer_id === referrerId, 'referral reward granted');
  const referrerAfter = await db.get('SELECT membership_extended_until FROM users WHERE id = ?', [referrerId]);
  ok(referrerAfter.membership_extended_until > Date.now(), 'referrer membership extended by one free month');
  const grant2 = await refs.grantReferralReward(friendId, fsubId);
  ok(grant2.id === grant1.id, 'referral reward idempotent per subscription (no double free month)');
  const { hasAnyActiveSubscription } = require('../src/middleware/auth');
  ok(await hasAnyActiveSubscription(referrerId), 'free-month extension counts as active subscription');
  // Resume job: a past-due free month (PayPal unavailable in tests -> marked used, no crash).
  const dueSubId = randomUUID();
  const dueRedId = await db.insert('referral_redemptions', {
    id: randomUUID(), referrer_id: referrerId, referred_user_id: friendId, subscription_id: dueSubId,
    granted_at: Date.now() - 40 * 86400000, free_month_start: Date.now() - 40 * 86400000,
    free_month_end: Date.now() - 10 * 86400000, paypal_subscription_id: 'I-TESTFAKE', status: 'active',
  });
  const resumed = await refs.resumeReferralSubscriptions();
  ok((await db.get('SELECT status FROM referral_redemptions WHERE id = ?', [dueRedId])).status === 'used',
    'past-due referral free month marked used by the daily job');

  console.log('colorization (admin-only approval):');
  const colorz = require('../src/lib/colorization');
  const colDesignerId = await db.insert('users', { email: 'coldesigner@test.local', password_hash: 'x', role: 'design_artist', display_name: 'Col Designer' });
  const colDesignId = await db.insert('designs', {
    artist_id: colDesignerId, title: 'Col Piece', status: 'awaiting_color', color_source: 'none',
    price_cents: 7500, created_at: Date.now(),
  });
  fs.mkdirSync(path.join(process.env.ASSET_DIR, 'designs', 'color'), { recursive: true });
  const colAbs = path.join(process.env.ASSET_DIR, 'designs', 'color', 'col-test.jpg');
  fs.writeFileSync(colAbs, 'fake color');
  await colorz.attachColorVersion(colDesignId, colAbs);
  const colAfter = await db.get('SELECT status, color_path FROM designs WHERE id = ?', [colDesignId]);
  ok(colAfter.status === 'pending_color_approval' && colAfter.color_path, 'attach moves piece to pending_color_approval');
  const colConvs = await db.all(
    `SELECT c.id FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id
     WHERE p.user_id = ? AND c.subject LIKE '%colorized%'`, [colDesignerId]);
  ok(colConvs.length >= 1, 'designer notified when color is attached');
  let approveErr = '';
  try { await colorz.approveColorVersion(colDesignId, 'not-a-real-admin'); } catch (e) { approveErr = e.message; }
  ok(approveErr === '', 'approveColorVersion validates status only (route enforces admin role)');
  const colApproved = await db.get('SELECT status, color_source FROM designs WHERE id = ?', [colDesignId]);
  ok(colApproved.status === 'pending' && colApproved.color_source === 'site', 'admin approval sets color_source=site, status=pending');
  await colorz.notifyDesignLive(colDesignId);
  const colLiveConvs = await db.all(
    `SELECT c.id FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id
     WHERE p.user_id = ? AND c.subject LIKE '%is live%'`, [colDesignerId]);
  ok(colLiveConvs.length >= 1, 'designer notified when the piece goes live');

  await require('./founding').runDbTests(ok);

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
  await require('./founding').runHttpTests(ok, req, areq);
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

  // member-exclusive designs: hidden from non-members everywhere
  const moid = 'testdesignm01';
  sdb.prepare(`INSERT INTO designs (id, title, description, price_cents, status, color_path, linework_path, linework_wm_path, categories, sale_count, members_only, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(moid, 'Members Only Fox', 'desc', 7500, 'approved',
    'designs/color/w.jpg', 'designs/linework/w.jpg', 'designs/linework-wm/w-wm.jpg', '[]', 0, 1, Date.now());
  r = await req('GET', `/design/${moid}`, { follow: false });
  ok(r.status === 404, 'non-member gets 404 on member-only design page');
  r = await req('POST', `/orders/buy/${moid}`, { follow: false });
  ok(r.status === 302 && (r.location || '').includes('/membership'), 'non-member cannot buy member-only design');
  const apiAnon = await fetch(`http://localhost:${PORT}/api/designs`);
  const apiAnonBody = await apiAnon.json();
  ok(apiAnonBody.ok && !apiAnonBody.designs.some((d) => d.id === moid), 'member-only design hidden from app API for non-members');
  r = await req('GET', '/gallery');
  ok(r.status === 200 && !r.text.includes('Members Only Fox'), 'member-only design hidden from gallery for non-members');
  // admin can flip members_only back to public
  r = await areq('POST', `/admin/designs/${moid}/members-only`, { body: { members_only: '0' } });
  ok(r.status === 302 && sdb.prepare('SELECT members_only FROM designs WHERE id = ?').get(moid).members_only === 0, 'admin toggles members-only off');
  r = await areq('POST', `/admin/designs/${moid}/members-only`, { body: { members_only: '1' } });
  ok(r.status === 302 && sdb.prepare('SELECT members_only FROM designs WHERE id = ?').get(moid).members_only === 1, 'admin toggles members-only on');

  // refer-a-friend signup: friend code recorded; membership page shows the
  // referral link, the $1 first-month note, and the annual plan
  const buyerCode = sdb.prepare('SELECT referral_code FROM users WHERE email = ?').get('buyer@test.local').referral_code;
  ok(!!buyerCode, 'signup generated the buyer\u2019s referral code');
  r = await req('POST', '/signup', { body: { display_name: 'Friend', email: 'friend2@test.local', password: 'password123', referral_code: buyerCode }, follow: false });
  const friendReferred = sdb.prepare('SELECT referred_by FROM users WHERE email = ?').get('friend2@test.local').referred_by;
  const buyerRowId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('buyer@test.local').id;
  ok(friendReferred === buyerRowId, 'friend signup records who referred them');
  r = await req('GET', '/membership');
  ok(r.status === 200 && r.text.includes('free month') && r.text.includes('Annual'), 'membership page shows referral link, $1 first month, annual plan');
  ok(r.text.includes('Annual plan coming soon') || r.text.includes('/subscribe/customer_annual'), 'annual plan shown (or coming soon when PayPal plan ID missing)');

  // removed designer color-approval routes are gone
  r = await req('POST', '/signup', { body: { display_name: 'ColorDesigner', email: 'colordesigner@test.local', password: 'password123' }, follow: false });
  const cdId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('colordesigner@test.local').id;
  const djPlan = sdb.prepare("SELECT id FROM plans WHERE slug = 'design_artist'").get().id;
  sdb.prepare('INSERT INTO subscriptions (id, user_id, plan_id, status, created_at) VALUES (?,?,?,?,?)')
    .run(randomUUID(), cdId, djPlan, 'active', Date.now());
  sdb.prepare("UPDATE users SET role = 'design_artist' WHERE id = ?").run(cdId);
  const desigJar = {};
  async function dreq(method, p, opts = {}) {
    const h = { ...(opts.headers || {}) };
    const cookies = Object.entries(desigJar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) h.cookie = cookies;
    let payload = opts.body;
    if (payload && typeof payload === 'object') {
      payload = new URLSearchParams(payload);
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(`http://localhost:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [k, v] = c.split(';')[0].split('=');
      desigJar[k.trim()] = (v || '').trim();
    }
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  r = await dreq('POST', '/login', { body: { email: 'colordesigner@test.local', password: 'password123' } });
  r = await dreq('POST', '/artist/portfolio/someid/approve-color', { follow: false });
  ok(r.status === 404, 'designer color-approval route removed');
  r = await dreq('POST', '/artist/portfolio/someid/request-changes', { follow: false });
  ok(r.status === 404, 'designer color change-request route removed');
  r = await dreq('GET', '/artist/portfolio');
  ok(r.status === 200 && !r.text.includes('approve-color'), 'portfolio shows no designer color-approval controls');

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

  // head admin: seed account bootstraps as head_admin
  const seedRole = sdb.prepare('SELECT role FROM users WHERE email = ?').get('admin@test.local').role;
  ok(seedRole === 'head_admin', 'bootstrap admin is head_admin');
  // admin management UI: admins page loads, add/remove works (head admin)
  r = await areq('GET', '/admin/admins');
  ok(r.status === 200 && r.text.includes('Add admin') && r.text.includes('head admin'), 'admins page loads with head-admin badge');
  r = await areq('POST', '/admin/admins/add', { body: { email: 'buyer@test.local' } });
  const roleAfter = sdb.prepare('SELECT role FROM users WHERE email = ?').get('buyer@test.local').role;
  ok(roleAfter === 'admin', 'head admin promotes buyer to admin');
  r = await areq('POST', '/admin/admins/remove', { body: { id: buyerId } });
  const roleBack = sdb.prepare('SELECT role FROM users WHERE email = ?').get('buyer@test.local').role;
  ok(roleBack === 'customer', 'head admin demotes admin back to customer');
  // head admin cannot remove their own head-admin access (last head admin)
  r = await areq('POST', '/admin/admins/remove', { body: { id: adminId } });
  const stillHead = sdb.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'admin@test.local' AND role = 'head_admin'").get().n;
  ok(stillHead === 1, 'last head admin cannot demote themselves');
  // normal admins are blocked from admin management entirely
  r = await req('POST', '/signup', { body: { display_name: 'NormAdmin', email: 'normadmin@test.local', password: 'password123' }, follow: false });
  ok(r.status === 302, 'normadmin signup ok');
  r = await areq('POST', '/admin/admins/add', { body: { email: 'normadmin@test.local' } });
  const normRole = sdb.prepare('SELECT role FROM users WHERE email = ?').get('normadmin@test.local').role;
  ok(normRole === 'admin', 'normadmin promoted to normal admin');
  const normJar = {};
  async function nreq(method, p, opts = {}) {
    const h = { ...(opts.headers || {}) };
    const cookies = Object.entries(normJar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) h.cookie = cookies;
    let payload = opts.body;
    if (payload && typeof payload === 'object') {
      payload = new URLSearchParams(payload);
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(`http://localhost:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [k, v] = c.split(';')[0].split('=');
      normJar[k.trim()] = (v || '').trim();
    }
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  r = await nreq('POST', '/login', { body: { email: 'normadmin@test.local', password: 'password123' } });
  ok(r.status === 302, 'normal admin login ok');
  r = await nreq('GET', '/admin', { follow: false });
  ok(r.status === 200, 'normal admin still reaches the admin dashboard');
  r = await nreq('GET', '/admin/admins', { follow: false });
  ok(r.status === 403, 'normal admin blocked from admin management page');
  r = await nreq('POST', '/admin/admins/remove', { body: { id: adminId }, follow: false });
  const headStill = sdb.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'admin@test.local' AND role = 'head_admin'").get().n;
  ok(r.status === 403 && headStill === 1, 'normal admin cannot demote the head admin');
  // cleanup: head admin demotes the normal admin back to customer
  r = await areq('POST', '/admin/admins/remove', { body: { id: sdb.prepare('SELECT id FROM users WHERE email = ?').get('normadmin@test.local').id } });
  ok(sdb.prepare('SELECT role FROM users WHERE email = ?').get('normadmin@test.local').role === 'customer', 'head admin removes normal admin');

  // cashout options: destinations + early cashout with 3% fee
  const cashout = require('../src/lib/cashout');
  await db.init(); // re-open: the commissions unit test closed the handle above
  const q = cashout.earlyQuote(10000);
  ok(q.penaltyCents === 300 && q.netCents === 9700, 'early cashout quote: 3% fee');
  ok(Object.keys(cashout.DEST_TYPES).join(',').includes('bank') && cashout.DEST_TYPES.paypal.auto === 'paypal', 'destination types include bank + PayPal');
  // seed a payable artist balance for the buyer + grant an active designer
  // subscription with a payout email (payouts require both)
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
  ok(r.status === 302 && r.location === '/artist/portfolio/upload', 'artist upload redirects to portfolio upload page');
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

  console.log('portfolios:');
  // The SLA banner test above left the artist commission-suspended; the
  // portfolio purchase tests need a clean slate first.
  await db.update('users', bannerArtistId, { commission_suspended_until: null });
  const sharp = require('sharp');
  // Site watermark images must exist under ASSET_DIR for the pipeline
  // (the pipeline also falls back to the repo-bundled watermarks/ dir).
  const wmSrcDir = path.join(ROOT, 'watermarks');
  const wmDstDir = path.join(process.env.ASSET_DIR, 'watermarks');
  fs.mkdirSync(wmDstDir, { recursive: true });
  for (const f of fs.readdirSync(wmSrcDir)) fs.copyFileSync(path.join(wmSrcDir, f), path.join(wmDstDir, f));

  async function testJpeg(abs, w, h) {
    await sharp({ create: { width: w, height: h, channels: 3, background: { r: 250, g: 250, b: 250 } } })
      .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><circle cx="${w / 2}" cy="${h / 2}" r="${Math.floor(Math.min(w, h) / 3)}" fill="none" stroke="black" stroke-width="10"/></svg>`) }])
      .jpeg().toFile(abs);
  }
  // Watermark pipeline unit check (both choices).
  const { applyWatermarkedLinework } = require('../src/lib/watermark');
  const wmTestDir = path.join(process.env.ASSET_DIR, 'uploads', 'designs');
  fs.mkdirSync(wmTestDir, { recursive: true });
  await testJpeg(path.join(wmTestDir, 'lw.jpg'), 700, 900);
  await testJpeg(path.join(wmTestDir, 'mywm.jpg'), 400, 300);
  let wmRel = await applyWatermarkedLinework({ designId: 'wmunit1', lineworkAbs: path.join(wmTestDir, 'lw.jpg'), choice: 'site' });
  ok(wmRel === 'designs/linework-wm/wmunit1-auto.jpg' && fs.existsSync(path.join(process.env.ASSET_DIR, wmRel)), 'site watermark pipeline generates public linework');
  wmRel = await applyWatermarkedLinework({ designId: 'wmunit2', lineworkAbs: path.join(wmTestDir, 'lw.jpg'), choice: 'custom', customWatermarkAbs: path.join(wmTestDir, 'mywm.jpg') });
  ok(fs.existsSync(path.join(process.env.ASSET_DIR, wmRel)), 'custom watermark pipeline generates public linework');
  const wmMeta = await sharp(path.join(process.env.ASSET_DIR, wmRel)).metadata();
  ok(wmMeta.width === 700 && wmMeta.height === 900, 'watermarked output keeps linework dimensions');
  // Repo-bundled fallback: pipeline still works when ASSET_DIR has no copies.
  fs.rmSync(wmDstDir, { recursive: true, force: true });
  wmRel = await applyWatermarkedLinework({ designId: 'wmunit3', lineworkAbs: path.join(wmTestDir, 'lw.jpg'), choice: 'site' });
  ok(fs.existsSync(path.join(process.env.ASSET_DIR, wmRel)), 'site watermark falls back to repo-bundled copies');
  fs.mkdirSync(wmDstDir, { recursive: true });
  for (const f of fs.readdirSync(wmSrcDir)) fs.copyFileSync(path.join(wmSrcDir, f), path.join(wmDstDir, f));

  // multipart POST helper (fresh jar per caller)
  async function mpost(p, fields, files, jarObj) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const [k, f] of Object.entries(files)) form.append(k, new Blob([f.buffer], { type: f.type }), f.filename);
    const cookies = Object.entries(jarObj).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`http://localhost:${PORT}${p}`, {
      method: 'POST', headers: cookies ? { cookie: cookies } : {}, body: form, redirect: 'manual',
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [k, v] = c.split(';')[0].split('=');
      jarObj[k.trim()] = (v || '').trim();
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  const colorBuf = await sharp(path.join(wmTestDir, 'lw.jpg')).toBuffer();
  const lwBuf = await sharp(path.join(wmTestDir, 'lw.jpg')).toBuffer();
  const myWmBuf = await sharp(path.join(wmTestDir, 'mywm.jpg')).toBuffer();

  // Portfolio pages (artist jar = subscribed design_artist).
  r = await artreq('GET', '/artist/portfolio');
  ok(r.status === 200 && r.text.includes('My portfolio'), 'portfolio management page renders');
  r = await artreq('GET', '/artist/portfolio/upload');
  ok(r.status === 200 && r.text.includes('Custom portfolio piece') && r.text.includes('Pre-design'), 'upload form offers listing-type choice');
  ok(r.text.includes('anti-trace'), 'upload form states black anti-trace marks apply in both cases');
  r = await artreq('GET', '/artist');
  ok(r.text.includes('My portfolio') && r.text.includes('Upload new piece'), 'dashboard links portfolio prominently');

  // Unsubscribed design_artist cannot reach the portfolio.
  const unsubJar = {};
  async function unsubreq(method, p, opts = {}) {
    const h = { ...(opts.headers || {}) };
    const cookies = Object.entries(unsubJar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) h.cookie = cookies;
    let payload = opts.body;
    if (payload && typeof payload === 'object') { payload = new URLSearchParams(payload); h['content-type'] = 'application/x-www-form-urlencoded'; }
    const res = await fetch(`http://localhost:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [k, v] = c.split(';')[0].split('=');
      unsubJar[k.trim()] = (v || '').trim();
    }
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  const unsubId = await db.insert('users', { email: 'unsub@test.local', password_hash: await bcrypt.hash('UnsubPass123!', 10), role: 'design_artist', display_name: 'Unsub' });
  r = await unsubreq('POST', '/login', { body: { email: 'unsub@test.local', password: 'UnsubPass123!' } });
  r = await unsubreq('GET', '/artist/portfolio', {});
  ok(r.status === 302 && (r.location || '').includes('/membership'), 'unsubscribed artist blocked from portfolio');

  // Default upload: custom portfolio piece, site watermark.
  r = await mpost('/artist/portfolio/upload',
    { title: 'Portfolio Dragon', description: 'A dragon.', style: 'japanese', categories: 'animals', listing_type: 'custom', watermark_choice: 'site' },
    { color: { buffer: colorBuf, filename: 'c.jpg', type: 'image/jpeg' }, linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    artJar);
  ok(r.status === 302 && r.location === '/artist/portfolio', 'portfolio upload redirects to portfolio');
  const prow = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Portfolio Dragon');
  ok(prow && prow.listing_scope === 'portfolio' && prow.listing_type === 'custom', 'default upload is portfolio-only custom');
  ok(prow.watermark_choice === 'site', 'watermark choice stored');
  ok(prow.linework_wm_path && fs.existsSync(path.join(process.env.ASSET_DIR, prow.linework_wm_path)), 'watermarked linework auto-generated at upload');
  ok(prow.status === 'pending', 'upload waits for admin approval');
  ok(prow.style === 'japanese', 'style stored at upload');

  // Pre-design opt-in with the artist's own watermark image.
  r = await mpost('/artist/portfolio/upload',
    { title: 'Gallery Koi', description: 'Koi fish.', style: 'animals', listing_type: 'predesign', watermark_choice: 'custom' },
    { color: { buffer: colorBuf, filename: 'c.jpg', type: 'image/jpeg' }, linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' }, watermark: { buffer: myWmBuf, filename: 'w.jpg', type: 'image/jpeg' } },
    artJar);
  ok(r.status === 302, 'pre-design upload accepted');
  const grow = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Gallery Koi');
  ok(grow && grow.listing_scope === 'gallery' && grow.listing_type === 'predesign', 'pre-design opt-in is gallery scoped');
  ok(grow.style === 'animals' && JSON.parse(grow.categories).includes('animals'), 'pre-design category fixed at upload');
  ok(grow.watermark_choice === 'custom' && grow.custom_watermark_path, 'custom watermark choice + file stored');

  // Approve both via admin.
  r = await areq('POST', `/admin/designs/${prow.id}/approve`);
  r = await areq('POST', `/admin/designs/${grow.id}/approve`);
  ok(sdb.prepare('SELECT status FROM designs WHERE id = ?').get(prow.id).status === 'approved', 'portfolio piece approved');

  // Gallery inclusion rules.
  r = await req('GET', '/gallery');
  ok(!r.text.includes('Portfolio Dragon'), 'portfolio custom piece NOT in main gallery');
  ok(r.text.includes('Gallery Koi'), 'pre-design opt-in IS in main gallery');
  r = await req('GET', '/api/designs');
  const apiList = JSON.parse(r.text);
  ok(apiList.ok && apiList.designs.some((d) => d.title === 'Gallery Koi'), 'app designs API includes pre-design opt-in');
  ok(!apiList.designs.some((d) => d.title === 'Portfolio Dragon'), 'app designs API excludes portfolio-only piece');

  // Public artist page: bio + both pieces, watermarked linework only.
  r = await req('GET', `/artists/${bannerArtistId}`);
  ok(r.status === 200 && r.text.includes('Portfolio Dragon') && r.text.includes('Gallery Koi'), 'public artist page shows portfolio pieces');
  ok(!r.text.includes('/uploads/'), 'public artist page never exposes clean upload paths');
  r = await req('GET', '/api/artists/' + bannerArtistId);
  const apiArtist = JSON.parse(r.text);
  ok(apiArtist.ok && apiArtist.pieces.length === 2, 'app artist API returns portfolio pieces');
  ok(apiArtist.pieces.some((p) => p.listing_type === 'custom' && p.price_cents === pricing.customFullCents()), 'app artist API prices custom piece at custom price');

  // Design page: custom piece shows the custom price.
  r = await req('GET', `/design/${prow.id}`);
  ok(r.status === 200 && r.text.includes(pricing.money(pricing.customFullCents())), 'design page shows custom price for portfolio piece');
  ok(r.text.includes('custom portfolio piece'), 'design page labels custom piece');

  // Portfolio edit + delete rules (before any sales on these pieces).
  r = await artreq('POST', `/artist/portfolio/${grow.id}/edit`, { body: { title: 'Gallery Koi v2', description: 'Koi v2.', style: 'animals', categories: 'fish' } });
  ok(r.status === 302, 'portfolio edit redirects');
  ok(sdb.prepare('SELECT title FROM designs WHERE id = ?').get(grow.id).title === 'Gallery Koi v2', 'portfolio edit updates the piece');
  // Upload a throwaway piece to exercise successful deletion.
  r = await mpost('/artist/portfolio/upload',
    { title: 'Deletable Sketch', description: '', style: 'animals', listing_type: 'custom', watermark_choice: 'site' },
    { color: { buffer: colorBuf, filename: 'c.jpg', type: 'image/jpeg' }, linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    artJar);
  const delRow = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Deletable Sketch');
  r = await areq('POST', `/admin/designs/${delRow.id}/approve`);
  r = await artreq('POST', `/artist/portfolio/${delRow.id}/delete`, {});
  ok(!sdb.prepare('SELECT id FROM designs WHERE id = ?').get(delRow.id), 'unsold piece can be deleted');

  // Purchase the portfolio custom piece: custom price, instant premade path.
  r = await req('POST', `/orders/buy/${prow.id}`, { follow: false });
  ok(r.status === 302 && r.location.includes('/orders/manual/'), 'custom piece checkout starts');
  const pOrderId = r.location.split('/orders/manual/')[1];
  const pOrder = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(pOrderId);
  ok(pOrder.amount_cents === pricing.customFullCents(), 'custom piece charged at current custom price');
  ok(pOrder.order_type === 'premade' && pOrder.custom_status === 'new', 'custom piece uses instant fulfillment, not the 48h pipeline');
  // buyer records the manual payment, then admin confirms
  r = await req('POST', `/orders/manual/${pOrderId}`, { body: { method: 'cashapp', note: 'test' }, follow: false });
  ok(r.status === 302, 'manual payment recorded for portfolio order');
  r = await areq('POST', `/admin/orders/${pOrderId}/confirm-manual`);
  ok(r.status === 302, 'admin confirms portfolio order payment');
  const pLedger = sdb.prepare('SELECT recipient_type, amount_cents, status FROM commission_ledger WHERE order_id = ?').all(pOrderId);
  const pArtist = pLedger.find((l) => l.recipient_type === 'artist');
  ok(pArtist && pArtist.amount_cents === Math.round(pOrder.amount_cents * 0.70), 'portfolio custom sale: designer gets 70% (60% + no-shop half-share)');
  const pSite = pLedger.filter((l) => l.recipient_type === 'site').reduce((a, l) => a + l.amount_cents, 0);
  const pShop = pLedger.filter((l) => l.recipient_type === 'shop').reduce((a, l) => a + l.amount_cents, 0);
  // Instant-fulfillment custom piece: premade path, no referring shop —
  // designer 70%, owner 20% + site 10% (the unassigned shop share split
  // 50/50), no shop share.
  ok(pSite === Math.round(pOrder.amount_cents * 0.30) && pShop === 0, 'portfolio custom sale: site keeps 20% owner + 10% site, no shop share without referral');
  ok(pArtist.amount_cents + pSite + pShop === pOrder.amount_cents, 'commission splits sum to the order total');
  // Instant delivery: buyer can mint a download token for the clean files.
  r = await req('POST', `/orders/${pOrderId}/download-token`, { follow: false });
  ok(r.status === 302 && (r.location || '').includes('/orders/download/'), 'paid portfolio order unlocks instant download');

  // Commission-suspended designer: 70% redirected to the owner.
  await db.update('users', bannerArtistId, { commission_suspended_until: Date.now() + 86400000 });
  r = await req('POST', `/orders/buy/${grow.id}`, { follow: false });
  const sOrderId = r.location.split('/orders/manual/')[1];
  const sOrder = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(sOrderId);
  r = await req('POST', `/orders/manual/${sOrderId}`, { body: { method: 'cashapp', note: 'test' }, follow: false });
  ok(r.status === 302, 'manual payment recorded for pre-design order');
  r = await areq('POST', `/admin/orders/${sOrderId}/confirm-manual`);
  const sLedger = sdb.prepare('SELECT recipient_type, recipient_id, amount_cents, status FROM commission_ledger WHERE order_id = ?').all(sOrderId);
  const sArtist = sLedger.find((l) => l.recipient_type === 'artist');
  ok(sArtist && sArtist.amount_cents === 0 && sArtist.status === 'site_kept', 'suspended designer earns 0 on portfolio sales');
  const ownerId = sdb.prepare("SELECT id FROM users WHERE email = 'admin@test.local'").get().id;
  const sOwner = sLedger.find((l) => l.recipient_type === 'site' && l.recipient_id === ownerId);
  ok(sOwner && sOwner.amount_cents === Math.round(sOrder.amount_cents * 0.70), 'suspended designer 70% redirected to owner payable');
  await db.update('users', bannerArtistId, { commission_suspended_until: null });

  // A piece with sales cannot be deleted.
  r = await artreq('POST', `/artist/portfolio/${prow.id}/delete`, {});
  ok(sdb.prepare('SELECT id FROM designs WHERE id = ?').get(prow.id), 'piece with sales cannot be deleted');

  // ===== Linework-only uploads + site colorization workflow =====
  // Linework-only upload (no color file) is accepted and held.
  r = await mpost('/artist/portfolio/upload',
    { title: 'Ink Sketch', description: 'Linework only.', style: 'japanese', categories: 'animals', listing_type: 'custom', watermark_choice: 'site' },
    { linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    artJar);
  ok(r.status === 302 && r.location === '/artist/portfolio', 'linework-only upload accepted');
  const lwRow = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Ink Sketch');
  ok(lwRow && lwRow.color_source === 'none' && lwRow.status === 'awaiting_color' && !lwRow.color_path,
    'linework-only upload held as awaiting_color with no color version');
  ok(pricing.LINEWORK_ONLY_DISCOUNT === 0.03 && pricing.LINEWORK_ONLY_DISCOUNT <= 0.03,
    'linework-only discount constant is 0.03 and clamped');
  // Hidden from every public surface.
  r = await req('GET', '/gallery');
  ok(!r.text.includes('Ink Sketch'), 'linework-only piece hidden from the gallery');
  r = await req('GET', `/artists/${bannerArtistId}`);
  ok(!r.text.includes('Ink Sketch'), 'linework-only piece hidden from the public portfolio');
  r = await req('GET', '/api/designs');
  ok(!JSON.parse(r.text).designs.some((d) => d.title === 'Ink Sketch'), 'linework-only piece hidden from the app designs API');
  // Owner notified on-site that a color version needs creating.
  const ownerNotif = sdb.prepare(
    `SELECT c.id FROM conversations c JOIN messages m ON m.conversation_id = c.id
     WHERE c.subject LIKE '%Color version needed%' AND m.body LIKE '%Ink Sketch%'`).get();
  ok(!!ownerNotif, 'owner notified on-site that a color version needs creating');
  // Admin colorization queue lists it.
  r = await areq('GET', '/admin/colorization');
  ok(r.status === 200 && r.text.includes('Ink Sketch') && r.text.includes('awaiting_color'),
    'admin colorization queue lists the linework-only piece');

  // Admin attaches the finished site-created color file.
  r = await mpost(`/admin/colorization/${lwRow.id}/attach`, {},
    { color: { buffer: colorBuf, filename: 'c.jpg', type: 'image/jpeg' } }, adminJar);
  ok(r.status === 302 && r.location === '/admin/colorization', 'admin attaches the color version');
  const afterAttach = sdb.prepare('SELECT * FROM designs WHERE id = ?').get(lwRow.id);
  ok(afterAttach.status === 'pending_color_approval' && afterAttach.color_path
    && fs.existsSync(path.join(process.env.ASSET_DIR, afterAttach.color_path)),
    'attaching color moves the piece to pending_color_approval');
  ok(afterAttach.color_path.includes('sitecolor'), 'site-created color stored under its own filename');
  // Designer is notified for information only — there is no approval gate.
  const artistNotif = sdb.prepare(
    `SELECT c.id FROM conversations c JOIN messages m ON m.conversation_id = c.id
     WHERE c.subject LIKE '%was colorized%' AND m.body LIKE '%Ink Sketch%'`).get();
  ok(!!artistNotif, 'designer notified that the color version was created (informational)');
  // The old designer preview/approval routes are gone; the admin has a
  // private preview instead.
  r = await artreq('GET', `/artist/portfolio/${lwRow.id}/color`);
  ok(r.status === 404, 'designer private color preview route removed');
  r = await areq('GET', `/admin/colorization/${lwRow.id}/preview`);
  ok(r.status === 200, 'admin can privately preview the site-created color');
  const anonPrev = await fetch(`http://localhost:${PORT}/admin/colorization/${lwRow.id}/preview`, { redirect: 'manual' });
  ok(anonPrev.status !== 200, 'color preview is not reachable without login');
  // A site administrator approves the color version: color_source becomes
  // 'site', back into normal admin approval.
  r = await areq('POST', `/admin/colorization/${lwRow.id}/approve`);
  const afterApprove = sdb.prepare('SELECT * FROM designs WHERE id = ?').get(lwRow.id);
  ok(afterApprove.color_source === 'site' && afterApprove.status === 'pending',
    'admin color approval sets color_source=site and status=pending');
  r = await areq('POST', `/admin/designs/${lwRow.id}/approve`);
  ok(sdb.prepare('SELECT status FROM designs WHERE id = ?').get(lwRow.id).status === 'approved',
    'admin approves the piece after color approval');
  // The designer is notified when the piece goes live.
  const liveNotif = sdb.prepare(
    `SELECT c.id FROM conversations c JOIN messages m ON m.conversation_id = c.id
     WHERE c.subject LIKE '%is live%' AND m.body LIKE '%Ink Sketch%'`).get();
  ok(!!liveNotif, 'designer notified when the site-colored piece goes live');
  // The site-created color never appears anywhere public.
  r = await req('GET', `/artists/${bannerArtistId}`);
  ok(r.text.includes('Ink Sketch') && !r.text.includes('sitecolor') && !r.text.includes('/uploads/'),
    'public portfolio shows the piece but never the site-created color file');
  r = await req('GET', '/gallery');
  ok(!r.text.includes('sitecolor'), 'gallery never exposes the site-created color');
  r = await req('GET', `/design/${lwRow.id}`);
  ok(r.status === 200 && !r.text.includes('sitecolor') && r.text.includes('Clean linework only'),
    'design page offers the linework-only choice and never shows the site color');

  // Approving color on a piece with no color attached is rejected.
  r = await mpost('/artist/portfolio/upload',
    { title: 'Ink Sketch 2', description: 'Linework only.', style: 'japanese', listing_type: 'custom', watermark_choice: 'site' },
    { linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    artJar);
  const lw2 = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Ink Sketch 2');
  r = await areq('POST', `/admin/colorization/${lw2.id}/approve`);
  const lw2Still = sdb.prepare('SELECT status FROM designs WHERE id = ?').get(lw2.id);
  ok(lw2Still.status === 'awaiting_color', 'color approval rejected when no color is attached');
  r = await req('GET', '/gallery');
  ok(!r.text.includes('Ink Sketch 2'), 'uncolorized piece stays hidden publicly');

  // ===== Linework-only checkout discount =====
  const customList = pricing.customFullCents();
  const lwPrice = pricing.lineworkOnlyPriceCents(customList);
  ok(lwPrice === Math.round(customList * 0.97), 'linework-only price is 3% off the list price');
  // Buyer chooses linework only on the site-colored piece.
  r = await req('POST', `/orders/buy/${lwRow.id}`, { body: { linework_only: '1' }, follow: false });
  const inkOrderId = r.location.split('/orders/manual/')[1];
  const inkOrder = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(inkOrderId);
  ok(inkOrder.amount_cents === lwPrice && inkOrder.linework_only === 1,
    'linework-only choice charged at the 3%-off price and stored on the order');
  r = await req('POST', `/orders/manual/${inkOrderId}`, { body: { method: 'cashapp', note: 't' }, follow: false });
  r = await areq('POST', `/admin/orders/${inkOrderId}/confirm-manual`);
  const inkLedger = sdb.prepare('SELECT recipient_type, amount_cents, commission_type FROM commission_ledger WHERE order_id = ?').all(inkOrderId);
  const inkArtist = inkLedger.find((l) => l.recipient_type === 'artist');
  const inkFee = inkLedger.find((l) => l.commission_type === 'colorization_fee');
  ok(inkArtist && inkArtist.amount_cents === Math.round(inkOrder.amount_cents * 0.65), 'site-colored sale: designer gets 65% (55% + no-shop half-share)');
  ok(inkFee && inkFee.recipient_type === 'site' && inkFee.amount_cents === Math.round(inkOrder.amount_cents * 0.05),
    'site-colored sale: 5-point website colorization fee recorded distinctly');
  ok(inkLedger.reduce((s, l) => s + l.amount_cents, 0) === inkOrder.amount_cents, 'colorization-fee splits sum to the order total');
  // Download page offers only linework for the linework-only purchase.
  r = await req('POST', `/orders/${inkOrderId}/download-token`, { follow: false });
  const inkToken = r.location.split('/orders/download/')[1].replace('/view', '');
  r = await req('GET', `/orders/download/${inkToken}/view`);
  ok(r.status === 200 && !r.text.includes('Download full color') && r.text.includes('clean linework only'),
    'linework-only download page hides the color option');
  r = await req('GET', `/orders/download/${inkToken}?file=color`);
  ok(r.status === 403, 'color download blocked for linework-only purchases');
  // Full-color purchase of the site-colored piece still records the fee.
  r = await req('POST', `/orders/buy/${lwRow.id}`, { follow: false });
  const fullOrderId = r.location.split('/orders/manual/')[1];
  const fullOrder = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(fullOrderId);
  ok(fullOrder.amount_cents === customList && !fullOrder.linework_only, 'full-color purchase charged at list price');
  r = await req('POST', `/orders/manual/${fullOrderId}`, { body: { method: 'cashapp', note: 't' }, follow: false });
  r = await areq('POST', `/admin/orders/${fullOrderId}/confirm-manual`);
  const fullLedger = sdb.prepare('SELECT recipient_type, amount_cents, commission_type FROM commission_ledger WHERE order_id = ?').all(fullOrderId);
  ok(fullLedger.some((l) => l.commission_type === 'colorization_fee' && l.amount_cents === Math.round(fullOrder.amount_cents * 0.05)),
    'colorization fee applies on the site-colored piece even for full-color purchases');
  // color_source='none' automatically gets the discounted linework-only price.
  await db.update('designs', lw2.id, { status: 'approved' });
  r = await req('POST', `/orders/buy/${lw2.id}`, { follow: false });
  const noneOrderId = r.location.split('/orders/manual/')[1];
  const noneOrder = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(noneOrderId);
  ok(noneOrder.amount_cents === lwPrice && noneOrder.linework_only === 1,
    "color_source='none' piece auto-priced at the 3%-off linework-only price");
  r = await req('POST', `/orders/manual/${noneOrderId}`, { body: { method: 'cashapp', note: 't' }, follow: false });
  r = await areq('POST', `/admin/orders/${noneOrderId}/confirm-manual`);
  const noneFee = sdb.prepare("SELECT amount_cents FROM commission_ledger WHERE order_id = ? AND commission_type = 'colorization_fee'").get(noneOrderId);
  ok(noneFee && noneFee.amount_cents === Math.round(noneOrder.amount_cents * 0.05), 'linework-only sale records the colorization fee');
  // Suspended designer still earns 0 on a site-colored sale.
  await db.update('users', bannerArtistId, { commission_suspended_until: Date.now() + 86400000 });
  r = await req('POST', `/orders/buy/${lwRow.id}`, { follow: false });
  const suspOrderId = r.location.split('/orders/manual/')[1];
  r = await req('POST', `/orders/manual/${suspOrderId}`, { body: { method: 'cashapp', note: 't' }, follow: false });
  r = await areq('POST', `/admin/orders/${suspOrderId}/confirm-manual`);
  const suspLedger = sdb.prepare('SELECT recipient_type, amount_cents, status FROM commission_ledger WHERE order_id = ?').all(suspOrderId);
  const suspArtist = suspLedger.find((l) => l.recipient_type === 'artist');
  ok(suspArtist && suspArtist.amount_cents === 0, 'suspended designer earns 0 on site-colored sales');
  await db.update('users', bannerArtistId, { commission_suspended_until: null });

  // ===== Daily owner sweep =====
  const { runOwnerSweep } = require('../src/lib/ownerSweep');
  const dayAgo = Date.now() - 25 * 3600 * 1000;
  // Isolate from older paid orders left behind by earlier test sections:
  // treat every other order as already swept.
  await db.query(
    `UPDATE commission_ledger SET cleared_at = ? WHERE recipient_type = 'site'
     AND order_id NOT IN (?, ?, ?, ?)`,
    [Date.now(), inkOrderId, fullOrderId, noneOrderId, suspOrderId]);
  await db.query('UPDATE orders SET paid_at = ? WHERE id IN (?, ?, ?)', [dayAgo, inkOrderId, fullOrderId, noneOrderId]);
  // An order on hold (dispute/review) must NOT be swept.
  await db.query('UPDATE orders SET on_hold = 1 WHERE id = ?', [fullOrderId]);
  const artistBefore = sdb.prepare("SELECT status, cleared_at FROM commission_ledger WHERE order_id = ? AND recipient_type = 'artist'").get(inkOrderId);
  const sweep = await runOwnerSweep({ now: Date.now() });
  ok(sweep.swept_orders === 2, 'sweep clears exactly the two eligible past-24h paid orders');
  ok(sweep.gross_cents === inkOrder.amount_cents + noneOrder.amount_cents, 'sweep gross matches the cleared orders');
  ok(sweep.report.includes('Gross sales cleared') && sweep.report.includes('Commissions owed'),
    'sweep report covers gross sales, owner net, and commissions owed');
  ok(sweep.colorization_fees_cents === (inkFee.amount_cents + noneFee.amount_cents),
    'sweep report breaks out the colorization fees');
  const inkSiteRows = sdb.prepare("SELECT cleared_at FROM commission_ledger WHERE order_id = ? AND recipient_type = 'site'").all(inkOrderId);
  ok(inkSiteRows.length > 0 && inkSiteRows.every((x) => x.cleared_at), "owner's rows marked cleared on swept orders");
  const fullSiteRows = sdb.prepare("SELECT cleared_at FROM commission_ledger WHERE order_id = ? AND recipient_type = 'site'").all(fullOrderId);
  ok(fullSiteRows.every((x) => !x.cleared_at), 'on-hold order is excluded from the sweep');
  const artistStillOwed = sdb.prepare("SELECT status, cleared_at FROM commission_ledger WHERE order_id = ? AND recipient_type = 'artist'").get(inkOrderId);
  ok(artistStillOwed.status === artistBefore.status && !artistStillOwed.cleared_at,
    'artist commissions untouched by the sweep — stay on their own payout schedule');

  sdb.close();
  server.kill();
  await new Promise((res2) => server.on('exit', res2));

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness error:', e); process.exit(1); });
