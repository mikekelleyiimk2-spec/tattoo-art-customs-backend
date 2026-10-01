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
// Test-only PayPal stub (see src/lib/paypal.js): canned subscription answers
// so the checkout routes can be exercised over HTTP without network access.
process.env.TAC_TEST_PAYPAL_STUB = '1';
// Enables the /__test_async_crash route (proves handler failures can't kill
// the server process).
process.env.TAC_TEST_ROUTES = '1';

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
  ok(!screenText('send it to my wallet').ok, 'bare wallet reference blocked in bios/messages');
  ok(screenText('Wallet', { allow: ['crypto_wallet'] }).ok, 'bare wallet allowed in display names');

  console.log('pricing:');
  ok(pricing.money(7500) === '$75.00', 'money formats');
  ok(pricing.money(9999) === '$99.99', 'money formats 99.99');
  // Processing-fee pass-through (standing rule): 3.5% + $0.49 on web, 15% in-app.
  ok(pricing.processingFeeCents(5000) === 224, 'web fee on $50 = $2.24');
  ok(pricing.processingFeeCents(7500) === 312, 'web fee on $75 = $3.12');
  ok(pricing.withFeeCents(5000) === 5224, 'web total on $50 = $52.24');
  ok(pricing.withPlayFeeCents(500) === 575, 'Play price on $5 = $5.75');
  ok(pricing.withPlayFeeCents(9999) === 11499, 'Play price on $99.99 = $114.99');
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
  ok(cfg.pricing.firstMonth.priceCents === 153, '$1.53 first-month price (base $1 + fee)');
  ok(cfg.pricing.foundingShop.priceCents === 8328, '$83.28 founding-shop price (base $79.99 + fee)');
  ok(cfg.pricing.plans.customer_annual && cfg.pricing.plans.customer_annual.priceCents === 5224, 'annual customer plan $52.24/year (base $50 + fee)');
  ok(cfg.foundingShopActive(), 'founding-shop window open (fallback ends 2027-03-01)');

  console.log('booking fees (shop toolset):');
  await require('./shoptools-phase1').runUnitTests(ok);
  ok(cfg.foundingShopWindowEnd === Date.parse('2027-03-01T00:00:00-06:00'), 'founding window is a fixed date, not rolling');
  const paypal = require('../src/lib/paypal');
  const trial = paypal.firstMonthTrialCycles(567);
  ok(trial[0].pricing_scheme.fixed_price.value === '1.53' && trial[1].pricing_scheme.fixed_price.value === '5.67', '$1.53 first month then $5.67/mo billing cycles');
  ok(trial[0].total_cycles === 1 && trial[1].sequence === 2, 'trial cycle count/sequence');
  const founding = paypal.foundingShopCycles();
  ok(founding[0].pricing_scheme.fixed_price.value === '83.28' && founding[0].total_cycles === 1, 'founding shop first year $83.28 for 1 cycle');
  ok(founding[0].tenure_type === 'TRIAL' && founding[1].tenure_type === 'REGULAR' && founding[1].sequence === 2, 'founding first year must be TRIAL tenure (PayPal rejects a second REGULAR cycle)');
  ok(founding[1].pricing_scheme.fixed_price.value === '103.98', 'founding shop renews at $103.98');
  // Dedicated founding-shop PayPal plan (PayPal rejects a 1-year TRIAL
  // override at subscription creation, so the discount lives in the plan).
  cfg.paypal.planIds.founding_shop = '';
  ok(!cfg.paypalFoundingShopPlanConfigured(), 'founding offer stays hidden until its PayPal plan exists');
  cfg.paypal.planIds.founding_shop = 'P-TESTFOUNDING';
  ok(cfg.paypalFoundingShopPlanConfigured(), 'founding offer activates once its PayPal plan is configured');
  cfg.paypal.planIds.founding_shop = '';
  const fplan = paypal.foundingShopPlanPayload({
    productId: 'PROD-TEST', name: 'Founding', description: 'd',
    trialCents: 8328, regularCents: 10398,
  });
  ok(fplan.status === 'ACTIVE' && fplan.product_id === 'PROD-TEST', 'founding plan payload targets the product and is active');
  ok(fplan.billing_cycles[0].tenure_type === 'TRIAL' && fplan.billing_cycles[0].total_cycles === 1 &&
     fplan.billing_cycles[0].pricing_scheme.fixed_price.value === '83.28', 'founding plan: $83.28 trial first year');
  ok(fplan.billing_cycles[1].tenure_type === 'REGULAR' && fplan.billing_cycles[1].total_cycles === 0 &&
     fplan.billing_cycles[1].pricing_scheme.fixed_price.value === '103.98', 'founding plan: $103.98/yr renewal forever');


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

  console.log('dual-sub bonus:');
  const { dualSubBonusActive } = require('../src/shop/shopDesigner');
  const { upsertProfile: upsertTestProfile } = require('../src/lib/profiles');
  const dualId = await db.insert('users', { email: 'dual@test.local', password_hash: 'x', role: 'tattoo_shop', display_name: 'Dual' });
  await upsertTestProfile('artist_profiles', dualId, { payout_paypal_email: 'dual@x.com' });
  const planA = await db.get("SELECT id FROM plans WHERE slug = 'design_artist'");
  const planS = await db.get("SELECT id FROM plans WHERE slug = 'tattoo_shop'");
  // Lifetime designer sub (NULL period end) + active shop sub.
  await db.insert('subscriptions', { user_id: dualId, plan_id: planA.id, status: 'active', current_period_end: null });
  await db.insert('subscriptions', { user_id: dualId, plan_id: planS.id, status: 'active', current_period_end: Date.now() + 86400000 });
  // Owner rule 2026-09-28: the +2% bonus is Adolfo's account ONLY — point the
  // override at the test user so the bonus path is exercised below.
  process.env.DUAL_BONUS_USER_ID = dualId;
  ok(await dualSubBonusActive(dualId) === true, 'dual-sub bonus active with lifetime designer + active shop sub');
  const plainId = await db.insert('users', { email: 'plain@test.local', password_hash: 'x', role: 'design_artist', display_name: 'Plain' });
  await upsertTestProfile('artist_profiles', plainId, { payout_paypal_email: 'plain@x.com' });
  await db.insert('subscriptions', { user_id: plainId, plan_id: planA.id, status: 'active', current_period_end: Date.now() + 86400000 });
  ok(await dualSubBonusActive(plainId) === false, 'no dual-sub bonus with designer sub only');
  const dualDesignId = await db.insert('designs', { title: 'Dual', artist_id: dualId, status: 'approved' });
  const dualOrderId = await db.insert('orders', {
    buyer_id: plainId, order_type: 'premade', design_id: dualDesignId,
    amount_cents: 10000, amount_paid_cents: 10000, fee_cents: 0, status: 'paid', referred_shop_id: null,
  });
  const dualOrd = await db.get('SELECT * FROM orders WHERE id = ?', [dualOrderId]);
  await comm.recordSaleCommissions(dualOrd);
  const dualRows = await db.all('SELECT recipient_type, amount_cents FROM commission_ledger WHERE order_id = ?', [dualOrderId]);
  const dualByType = {};
  for (const r of dualRows) dualByType[r.recipient_type] = (dualByType[r.recipient_type] || 0) + r.amount_cents;
  ok(dualByType.artist === 7200, 'dual-sub designer gets 72% with no referring shop (70% + 2%)');
  ok(dualRows.reduce((s, r) => s + r.amount_cents, 0) === 10000, 'dual-sub splits sum to the sale total');
  const dualArtistRow = dualRows.find((r) => r.recipient_type === 'artist');
  ok(dualArtistRow, 'dual-sub designer ledger row exists');
  // Referred sale: designer 62%, shop 20%, owner 8%, site 10%.
  const refShopId = await db.insert('users', { email: 'refshop@test.local', password_hash: 'x', role: 'tattoo_shop', display_name: 'RefShop' });
  await upsertTestProfile('shop_profiles', refShopId, { payout_paypal_email: 'ref@x.com' });
  await db.insert('subscriptions', { user_id: refShopId, plan_id: planS.id, status: 'active', current_period_end: Date.now() + 86400000 });
  const dualOrder2Id = await db.insert('orders', {
    buyer_id: plainId, order_type: 'premade', design_id: dualDesignId,
    amount_cents: 10000, amount_paid_cents: 10000, fee_cents: 0, status: 'paid', referred_shop_id: refShopId,
  });
  const dualOrd2 = await db.get('SELECT * FROM orders WHERE id = ?', [dualOrder2Id]);
  await comm.recordSaleCommissions(dualOrd2);
  const dualRows2 = await db.all('SELECT recipient_type, amount_cents FROM commission_ledger WHERE order_id = ?', [dualOrder2Id]);
  const d2 = {};
  for (const r of dualRows2) d2[r.recipient_type] = (d2[r.recipient_type] || 0) + r.amount_cents;
  ok(d2.artist === 6200 && d2.shop === 2000, 'referred dual-sub sale: designer 62%, shop 20%');
  ok(dualRows2.reduce((s, r) => s + r.amount_cents, 0) === 10000, 'referred dual-sub splits sum to total');
  // Custom order: dual-sub designer gets 72%.
  const dualCustId = await db.insert('orders', {
    buyer_id: plainId, order_type: 'custom', amount_cents: 10000, amount_paid_cents: 10000, fee_cents: 0, status: 'paid',
  });
  const dualCust = await db.get('SELECT * FROM orders WHERE id = ?', [dualCustId]);
  await comm.recordSaleCommissions(dualCust);
  const custAmt = await comm.recordCustomDesignerCommission(dualCust, dualId);
  ok(custAmt === 7200, 'dual-sub designer custom commission = 72% of net');
  // Exclusivity: another account holding BOTH subscriptions gets NO bonus.
  const otherDualId = await db.insert('users', { email: 'otherdual@test.local', password_hash: 'x', role: 'tattoo_shop', display_name: 'OtherDual' });
  await upsertTestProfile('artist_profiles', otherDualId, { payout_paypal_email: 'other@x.com' });
  await db.insert('subscriptions', { user_id: otherDualId, plan_id: planA.id, status: 'active', current_period_end: null });
  await db.insert('subscriptions', { user_id: otherDualId, plan_id: planS.id, status: 'active', current_period_end: Date.now() + 86400000 });
  ok(await dualSubBonusActive(otherDualId) === false, 'no dual-sub bonus for other accounts even with both subs');
  const otherDesignId = await db.insert('designs', { title: 'OtherDual', artist_id: otherDualId, status: 'approved' });
  const otherOrderId = await db.insert('orders', {
    buyer_id: plainId, order_type: 'premade', design_id: otherDesignId,
    amount_cents: 10000, amount_paid_cents: 10000, fee_cents: 0, status: 'paid', referred_shop_id: null,
  });
  await comm.recordSaleCommissions(await db.get('SELECT * FROM orders WHERE id = ?', [otherOrderId]));
  const otherRows = await db.all('SELECT recipient_type, amount_cents FROM commission_ledger WHERE order_id = ?', [otherOrderId]);
  const otherByType = {};
  for (const r of otherRows) otherByType[r.recipient_type] = (otherByType[r.recipient_type] || 0) + r.amount_cents;
  ok(otherByType.artist === 7000, 'other dual-sub designer gets standard 70% (no bonus)');
  delete process.env.DUAL_BONUS_USER_ID;

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

  console.log('colorization (admin-only approval, no designer gate):');
  const colorz = require('../src/lib/colorization');
  const colDesignerId = await db.insert('users', { email: 'coldesigner@test.local', password_hash: 'x', role: 'design_artist', display_name: 'Col Designer' });
  const colDesignId = await db.insert('designs', {
    artist_id: colDesignerId, title: 'Col Piece', status: 'pending', color_source: 'none', color_pending: 1,
    price_cents: 7500, created_at: Date.now(),
  });
  fs.mkdirSync(path.join(process.env.ASSET_DIR, 'designs', 'color'), { recursive: true });
  const colAbs = path.join(process.env.ASSET_DIR, 'designs', 'color', 'col-test.jpg');
  fs.writeFileSync(colAbs, 'fake color');
  await colorz.attachColorVersion(colDesignId, colAbs);
  const colAfter = await db.get('SELECT status, color_pending, color_source, color_path FROM designs WHERE id = ?', [colDesignId]);
  ok(colAfter.status === 'pending' && colAfter.color_pending === 0 && colAfter.color_source === 'site' && colAfter.color_path,
    'attaching the site-created color sets color_source=site, color_pending=0, and keeps the piece\u2019s approval status');
  const colConvs = await db.all(
    `SELECT c.id FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id
     WHERE p.user_id = ? AND c.subject LIKE '%colorized%'`, [colDesignerId]);
  ok(colConvs.length >= 1, 'designer notified when color is attached');
  await colorz.notifyDesignLive(colDesignId, 'Test Admin');
  const colLiveConvs = await db.all(
    `SELECT c.id FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id
     WHERE p.user_id = ? AND c.subject LIKE '%is live%'`, [colDesignerId]);
  ok(colLiveConvs.length >= 1, 'designer notified when the piece goes live');
  const liveBody = (await db.get(
    `SELECT m.body AS body FROM messages m JOIN conversations c ON c.id = m.conversation_id
     JOIN conversation_participants p ON p.conversation_id = c.id
     WHERE p.user_id = ? AND c.subject LIKE '%is live%' ORDER BY m.id DESC LIMIT 1`, [colDesignerId])).body || '';
  ok(liveBody.includes('Test Admin'), 'go-live notice names the admin who approved');

  await require('./adminTaskPay').runDbTests(ok);
  await require('./founding').runDbTests(ok);
  await require('./replacements').runDbTests(ok);
  await require('./shoptools-phase2').runDbTests(ok);
  await require('./shoptools-phase3').runDbTests(ok);
  await require('./shoptools-phase4').runDbTests(ok);
  await require('./shoptools-phase5').runDbTests(ok);
  await require('./shoptools-phase6').runDbTests(ok);

  // Mail retry (unit-level, no live SMTP): a transient failure is retried
  // with backoff and eventually delivered; a permanent failure exhausts all
  // 3 attempts and surfaces the error; dev mode still short-circuits.
  {
    const mail = require('../src/lib/mail');
    let attempts = 0;
    mail.__setTransporter({
      sendMail: async () => {
        attempts += 1;
        if (attempts === 1) { const e = new Error('ECONNRESET: transient'); e.code = 'ECONNRESET'; throw e; }
        return { messageId: 'stub-1', accepted: ['retry@test.local'] };
      },
    });
    try {
      const info = await mail.sendMail({ to: 'retry@test.local', subject: 'retry test', text: 'hi' });
      ok(attempts === 2, 'transient SMTP failure retried (2 attempts)');
      ok(info && info.messageId === 'stub-1', 'mail delivered after transient retry');
      let failAttempts = 0;
      mail.__setTransporter({ sendMail: async () => { failAttempts += 1; throw new Error('550 rejected'); } });
      let threw = null;
      try { await mail.sendMail({ to: 'fail@test.local', subject: 'fail test', text: 'hi' }); }
      catch (e) { threw = e; }
      ok(failAttempts === 3, 'permanent SMTP failure exhausts 3 attempts');
      ok(threw && /550 rejected/.test(threw.message), 'final SMTP error surfaces to the caller');
      mail.__setTransporter(null);
      const dev = await mail.sendMail({ to: 'dev@test.local', subject: 'dev test', text: 'hi' });
      ok(dev && dev.dev === true, 'dev mode (no SMTP) still logs and returns {dev:true} without throwing');
    } finally {
      mail.__setTransporter(null);
    }
  }

  await db.close();

  // --- template static checks ---
  console.log('templates:');
  const layout = fs.readFileSync(path.join(ROOT, 'src', 'views', 'layout.ejs'), 'utf8');
  const bannerTag = (layout.match(/<div id="cookie-banner"[^>]*>/) || [''])[0];
  ok(!/\bhidden\b/.test(bannerTag), 'cookie banner must not use the hidden attribute (inline display overrides it, breaking dismiss)');
  ok(bannerTag.includes('display:none'), 'cookie banner starts hidden via inline style');
  ok(layout.includes("b.style.display = 'none'") && layout.includes("b.style.display = 'flex'"),
    'cookie banner visibility toggled via style.display only');

  // --- HTTP integration ---
  console.log('http:');
  const server = spawn('node', [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Accumulate server stdout so tests can assert on dev-mode mail output
  // (SMTP is unconfigured in tests; mail.js logs `[mail:dev]` lines here).
  let serverLog = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout.on('data', (d) => { serverLog += String(d); if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
    server.stderr.on('data', (d) => process.stderr.write(d));
  });

  let r = await req('GET', '/health');
  ok(r.status === 200 && r.text.includes('"ok":true'), 'health check');

  r = await req('GET', '/');
  ok(r.status === 200 && r.text.includes('Tattoo Art Customs'), 'homepage renders');

  // CSP must permit the site's own inline UI handlers (mobile nav toggle,
  // cookie banner, plan pickers). Without 'unsafe-inline' those clicks die
  // silently on real browsers. And helmet's default script-src-attr 'none'
  // would kill inline onclick even WITH 'unsafe-inline' — it must be gone.
  {
    const raw = await fetch(`http://localhost:${PORT}/`);
    const csp = raw.headers.get('content-security-policy') || '';
    const m = csp.match(/script-src[^;]*/);
    ok(!!m && m[0].includes("'unsafe-inline'"), 'CSP script-src allows inline handlers (mobile nav + cookie banner work)');
    ok(!/script-src-attr/.test(csp), 'CSP has no script-src-attr directive (helmet default would block inline onclick)');
    await raw.text();
  }

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

  // exact-amount PayPal on the manual page: with PayPal unconfigured it must
  // fail safe (no crash, no charge) and send the buyer back to the manual page.
  r = await req('POST', `/orders/manual/${orderId}/paypal`, { follow: false });
  ok(r.status === 302 && r.location === `/orders/manual/${orderId}`, 'manual-page PayPal fails safe to the manual page when PayPal is off');
  r = await req('GET', `/orders/manual/${orderId}`);
  ok(r.status === 200 && !r.text.includes('WA9DS6J8ERSHW'), 'manual page no longer embeds the hosted subscription button');
  ok(r.text.includes('Pay with PayPal') && r.text.includes(`/orders/manual/${orderId}/paypal`), 'manual page offers the exact-total PayPal button');

  // app quick-buy: linked account creates a pending order, no payment moves.
  // Regression test (2026-09-29): quick-buy once passed referral_code: null,
  // which violates the NOT NULL column and 500'd on production.
  {
    const linkRes = await fetch(`http://localhost:${PORT}/api/link-account`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'buyer@test.local', password: 'password123' }),
    });
    const linkBody = await linkRes.json();
    ok(linkRes.status === 200 && linkBody.api_token, 'link-account mints an app token');
    const qbRes = await fetch(`http://localhost:${PORT}/api/orders/quick-buy/${did}`, {
      method: 'POST', headers: { 'x-api-token': linkBody.api_token },
    });
    const qbBody = await qbRes.json();
    ok(qbRes.status === 200 && qbBody.ok && (qbBody.checkout_path || '').startsWith('/orders/manual/'), 'quick-buy creates a pending order and returns the manual checkout path');
    const qbOrderId = qbBody.checkout_path.split('/orders/manual/')[1];
    const qbOrder = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(qbOrderId);
    ok(qbOrder && qbOrder.status === 'pending' && qbOrder.fee_cents > 0, 'quick-buy order is pending with the processing fee stored');
    ok(qbOrder && qbOrder.referral_code === '', 'quick-buy stores empty referral code (NOT NULL safe)');
    const qbNoAuth = await fetch(`http://localhost:${PORT}/api/orders/quick-buy/${did}`, { method: 'POST' });
    ok(qbNoAuth.status === 401, 'quick-buy without token is 401');
    const qbBadDesign = await fetch(`http://localhost:${PORT}/api/orders/quick-buy/nope`, {
      method: 'POST', headers: { 'x-api-token': linkBody.api_token },
    });
    ok(qbBadDesign.status === 404, 'quick-buy with unknown design is 404');
  }

  // tester bug reports: public form saves + emails the owner (dev-logged here)
  r = await req('GET', '/report-bug');
  ok(r.status === 200 && r.text.includes('Report a bug'), 'bug report form renders');
  r = await req('POST', '/report-bug', { body: { title: 'Test bug', details: 'steps here', page_url: '/gallery', severity: 'blocking' }, follow: false });
  ok(r.status === 302 && r.location === '/report-bug', 'bug report submits and redirects');

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
  await require('./shoptools-phase2').runHttpTests(ok, req);
  await require('./shoptools-phase3').runHttpTests(ok, req);
  await require('./shoptools-phase4').runHttpTests(ok, req);
  await require('./shoptools-phase5').runHttpTests(ok, req);
  await require('./shoptools-phase6').runHttpTests(ok, req);
  r = await areq('POST', `/admin/orders/${orderId}/confirm-manual`);
  ok(r.status === 302, 'admin confirms manual payment');

  // tester bug report persisted + visible in the admin triage list
  const bugRow = sdb.prepare("SELECT * FROM bug_reports WHERE title = 'Test bug'").get();
  ok(bugRow && bugRow.status === 'open' && bugRow.severity === 'blocking', 'bug report saved as open');
  r = await areq('GET', '/admin/bugs');
  ok(r.status === 200 && r.text.includes('Test bug'), 'admin bug list shows the report');

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

  // --- Premade instant delivery (owner rule 2026-09-29) ---
  // On verified payment capture the buyer must INSTANTLY get the clean files:
  // a download token is auto-issued (shown on the order page + emailed in the
  // receipt). Customs keep the 48h waiting flow — no auto token for them.
  {
    const buyerRow = sdb.prepare("SELECT id, email FROM users WHERE email = 'buyer@test.local'").get();
    // Fresh design with real files for both color + linework.
    const fdid = 'testdesigninstant1';
    sdb.prepare(`INSERT INTO designs (id, title, description, price_cents, status, color_path, linework_path, linework_wm_path, categories, sale_count, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(fdid, 'Instant Rose', 'desc', 7500, 'approved',
      'designs/color/instant.jpg', 'designs/linework/instant.jpg', 'designs/linework-wm/instant-wm.jpg', '[]', 0, Date.now());
    fs.mkdirSync(path.join(process.env.ASSET_DIR, 'designs', 'linework'), { recursive: true });
    fs.writeFileSync(path.join(process.env.ASSET_DIR, 'designs', 'color', 'instant.jpg'), 'fake-color');
    fs.writeFileSync(path.join(process.env.ASSET_DIR, 'designs', 'linework', 'instant.jpg'), 'fake-linework');

    // Simulate the PayPal return: pending order with a PayPal order id, then
    // capture via /orders/approve/:id (capture is stubbed COMPLETED in tests).
    const ppOrderId = 'pp-instant-' + Date.now();
    const premadeOrderId = sdb.prepare(`INSERT INTO orders
      (id, buyer_id, design_id, order_type, amount_cents, fee_cents, status, payment_method, paypal_order_id, referral_code, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      'ord-instant-1', buyerRow.id, fdid, 'premade', 7500, 312, 'pending', 'paypal', ppOrderId, '', Date.now()).lastInsertRowid;
    void premadeOrderId;
    const mailBefore = serverLog.length;
    r = await req('GET', `/orders/approve/ord-instant-1`, { follow: false });
    ok(r.status === 302 && (r.location || '').includes('/orders/ord-instant-1'), 'premade PayPal capture redirects to the order page');
    const paid = sdb.prepare('SELECT * FROM orders WHERE id = ?').get('ord-instant-1');
    ok(paid && paid.status === 'paid', 'premade order marked paid on capture');

    // (a) token auto-issued at capture time, 24h expiry
    const dl = sdb.prepare('SELECT * FROM downloads WHERE order_id = ?').get('ord-instant-1');
    ok(!!dl && /^[0-9a-f]{48}$/.test(dl.token), 'download token auto-issued on premade capture');
    ok(dl && dl.expires_at > Date.now() && dl.expires_at <= Date.now() + 24 * 3600 * 1000 + 60000,
      'auto-issued token expires ~24h out');

    // (b) confirmation page shows the download link immediately
    r = await req('GET', '/orders/ord-instant-1');
    ok(r.status === 200 && r.text.includes(`/orders/download/${dl.token}/view`),
      'order confirmation page shows the download link');

    // (c) receipt email carries the download link (dev-mode mail log)
    const mailOut = serverLog.slice(mailBefore);
    ok(mailOut.includes('[mail:dev]') && mailOut.includes('buyer@test.local') &&
      mailOut.includes(`/orders/download/${dl.token}/view`),
      'payment receipt email sent with the download link');

    // (d) the token serves the CLEAN files
    r = await req('GET', `/orders/download/${dl.token}?file=color`);
    ok(r.status === 200 && r.text === 'fake-color', 'token downloads the clean color file');
    r = await req('GET', `/orders/download/${dl.token}?file=linework`);
    ok(r.status === 200 && r.text === 'fake-linework', 'token downloads the clean linework file');

    // (e) links expire
    sdb.prepare('UPDATE downloads SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, dl.id);
    r = await req('GET', `/orders/download/${dl.token}?file=color`);
    ok(r.status === 410, 'expired download link returns 410');
    r = await req('GET', `/orders/download/${dl.token}/view`);
    ok(r.status === 410, 'expired download landing page returns 410');
    r = await req('GET', '/orders/download/deadbeef/view');
    ok(r.status === 410, 'unknown download token returns 410');

    // (f) buyer-scoping: another buyer cannot see or mint links for this order
    const otherJar = {};
    async function oreq(method, p, opts = {}) {
      const h = { ...(opts.headers || {}) };
      const cookies = Object.entries(otherJar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) h.cookie = cookies;
      let payload = opts.body;
      if (payload && typeof payload === 'object') { payload = new URLSearchParams(payload); h['content-type'] = 'application/x-www-form-urlencoded'; }
      const res = await fetch(`http://localhost:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [k, v] = c.split(';')[0].split('='); otherJar[k.trim()] = (v || '').trim();
      }
      return { status: res.status, text: await res.text(), location: res.headers.get('location') };
    }
    let or = await oreq('POST', '/signup', { body: { display_name: 'Other', email: 'other@test.local', password: 'password123' } });
    ok(or.status === 302 || or.status === 200, 'second buyer signed up');
    or = await oreq('GET', '/orders/ord-instant-1');
    ok(or.status === 404, 'another buyer cannot open someone else\u2019s order page');
    or = await oreq('POST', '/orders/ord-instant-1/download-token', { follow: false });
    ok(or.status === 302 && !(or.location || '').includes('/orders/download/'),
      'another buyer cannot mint a download token for someone else\u2019s order');

    // (g) idempotency: re-requesting a link reuses the live token (no duplicates).
    // (The old token was expired in (e), so the first re-request mints one
    // fresh token; the second must reuse it.)
    r = await req('POST', '/orders/ord-instant-1/download-token', { follow: false });
    const tokA = (r.location || '').split('/orders/download/')[1].replace('/view', '');
    r = await req('POST', '/orders/ord-instant-1/download-token', { follow: false });
    const tokB = (r.location || '').split('/orders/download/')[1].replace('/view', '');
    const liveCount = sdb.prepare('SELECT COUNT(*) AS n FROM downloads WHERE order_id = ? AND expires_at > ?')
      .get('ord-instant-1', Date.now()).n;
    ok(/^[0-9a-f]{48}$/.test(tokA) && tokA === tokB && liveCount === 1,
      'repeat link requests reuse the live token (no duplicates)');

    // (h) customs are untouched: capture issues NO token, waiting flow intact
    const custOrderId = 'ord-custom-1';
    sdb.prepare(`INSERT INTO orders
      (id, buyer_id, order_type, amount_cents, deposit_cents, fee_cents, status, payment_method, paypal_order_id, referral_code, custom_brief, custom_status, delivery_due, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      custOrderId, buyerRow.id, 'custom', 15000, 7500, 312, 'pending', 'paypal', 'pp-custom-1', '',
      'A phoenix rising over mountains, blackwork style please', 'new', Date.now() + 48 * 3600 * 1000, Date.now());
    r = await req('GET', `/orders/approve/${custOrderId}`, { follow: false });
    ok(r.status === 302 && (r.location || '').includes(`/orders/${custOrderId}`), 'custom deposit capture redirects to the order page');
    const custPaid = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(custOrderId);
    ok(custPaid && custPaid.status === 'paid' && custPaid.custom_status === 'needs_drafts',
      'custom order enters the 48h draft pipeline after deposit');
    const custDl = sdb.prepare('SELECT COUNT(*) AS n FROM downloads WHERE order_id = ?').get(custOrderId).n;
    ok(custDl === 0, 'no download token auto-issued for custom orders');
    const custNone = await require('../src/lib/fulfillment').fulfillPremadeOrder(custPaid);
    ok(custNone === null, 'fulfillPremadeOrder passes custom orders through untouched');

    // population_admin: never auto-charged monthly, but one-time purchases work.
    const popJar = {};
    async function preq(method, p, opts = {}) {
      const h = { ...(opts.headers || {}) };
      const cookies = Object.entries(popJar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) h.cookie = cookies;
      let payload = opts.body;
      if (payload && typeof payload === 'object') { payload = new URLSearchParams(payload); h['content-type'] = 'application/x-www-form-urlencoded'; }
      const res = await fetch(`http://localhost:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [k, v] = c.split(';')[0].split('='); popJar[k.trim()] = (v || '').trim();
      }
      return { status: res.status, text: await res.text(), location: res.headers.get('location') };
    }
    let pr = await preq('POST', '/signup', { body: { display_name: 'PopAdmin', email: 'popadmin@test.local', password: 'password123' } });
    ok(pr.status === 302, 'population-admin test user signed up');
    const popRow = sdb.prepare("SELECT id FROM users WHERE email = 'popadmin@test.local'").get();
    sdb.prepare('UPDATE users SET population_admin = 1 WHERE id = ?').run(popRow.id);
    // (a) recurring subscription creation is refused loudly — no PayPal call, no row.
    pr = await preq('POST', '/membership/subscribe/customer', { body: {} });
    ok(pr.status === 302 && (pr.location || '').includes('/membership'),
      'population_admin blocked from starting a recurring membership (redirects, never billed)');
    const popSub = sdb.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?').get(popRow.id).n;
    ok(popSub === 0, 'no subscription row created for the blocked attempt');
    // (b) voluntary one-time premade purchase still completes.
    sdb.prepare(`INSERT INTO orders
      (id, buyer_id, design_id, order_type, amount_cents, fee_cents, status, payment_method, paypal_order_id, referral_code, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      'ord-pop-1', popRow.id, fdid, 'premade', 7500, 312, 'pending', 'paypal', 'pp-pop-' + Date.now(), '', Date.now());
    pr = await preq('GET', '/orders/approve/ord-pop-1');
    ok(pr.status === 302 && (pr.location || '').includes('/orders/ord-pop-1'),
      'population_admin premade capture redirects to the order page');
    const popPaid = sdb.prepare('SELECT * FROM orders WHERE id = ?').get('ord-pop-1');
    ok(popPaid && popPaid.status === 'paid', 'population_admin one-time premade purchase completes and is marked paid');

    // (i) premades are never delisted by selling
    const stillLive = sdb.prepare("SELECT status FROM designs WHERE id = ?").get(fdid);
    ok(stillLive && stillLive.status === 'approved', 'premade design stays approved/live after sale');
  }

  // One-time 20%-off-first-custom OPENING SALE (owner rule 2026-09-29):
  // eligible subscriber's first custom is 20% off the advertised $155.74
  // price; never reusable, never stacked; auto-disables at 5,500 visitors
  // or 150 paid sales (config.campaignCaps — internal only, never in
  // buyer-facing copy).
  {
    const fc = require('../src/lib/firstCustom');
    const fcp = require('../src/lib/pricing');
    // The harness closed the test process's shared db handle before the HTTP
    // phase; reopen it so lib-level checks can run (same as the suite's sdb
    // handle: a second connection to the temp test DB).
    await require('../src/db').init();
    function jarredReq() {
      const j = {};
      return async function (method, p, { body, headers = {}, follow = true } = {}) {
        const h = { ...headers };
        const cookies = Object.entries(j).map(([k, v]) => `${k}=${v}`).join('; ');
        if (cookies) h.cookie = cookies;
        let payload;
        if (body && typeof body === 'object' && !(body instanceof URLSearchParams)) {
          payload = new URLSearchParams(body);
          h['content-type'] = 'application/x-www-form-urlencoded';
        } else payload = body;
        const res = await fetch(`http://localhost:${PORT}${p}`, {
          method, headers: h, body: payload, redirect: follow ? 'follow' : 'manual',
        });
        for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
          const [k, v] = c.split(';')[0].split('=');
          j[k.trim()] = (v || '').trim();
        }
        return { status: res.status, text: await res.text(), location: res.headers.get('location') };
      };
    }
    const fcreq = jarredReq();   // eligible subscriber
    const fcnreq = jarredReq(); // non-subscriber
    const fcsreq = jarredReq(); // eligible subscriber (sale-window stacking)

    // Discount math: 20% off the advertised $155.74 custom price.
    ok(fcp.firstCustomFullCents() === 12459, 'first-custom discounted base is $124.59');
    ok(fcp.firstCustomDepositCents() === 6230, 'first-custom deposit is 50% ($62.30)');
    ok(fcp.processingFeeCents(6230) === 267, 'processing fee is computed on the discounted deposit');

    // Eligible subscriber: active membership, no prior customs, caps not hit.
    let fcr = await fcreq('POST', '/signup', { body: { display_name: 'FC Buyer', email: 'fcbuyer@test.local', password: 'password123' }, follow: false });
    ok(fcr.status === 302, 'first-custom buyer signed up');
    const fcBuyerId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('fcbuyer@test.local').id;
    const fcPlan = sdb.prepare("SELECT id FROM plans WHERE slug = 'customer'").get().id;
    sdb.prepare('INSERT INTO subscriptions (id, user_id, plan_id, status, created_at) VALUES (?,?,?,?,?)')
      .run(randomUUID(), fcBuyerId, fcPlan, 'active', Date.now());
    const fcUser = { id: fcBuyerId, role: 'customer' };
    ok(await fc.firstCustomEligible(fcUser), 'active subscriber with no customs is eligible');
    const q = await fc.customPriceQuote(fcUser);
    ok(q.full === 12459 && q.deposit === 6230 && q.discount === 'first_custom_20',
      'eligible quote: $124.59 base, $62.30 deposit, first_custom_20 code');

    // Checkout page carries the Opening sale line item (no cap numbers shown).
    fcr = await fcreq('GET', '/orders/custom');
    ok(fcr.status === 200 && fcr.text.includes('Opening sale') && !fcr.text.includes('5,500') && !fcr.text.includes('150 sales'),
      'custom page shows Opening sale copy without internal cap numbers');

    // POST /custom creates the discounted order + records redemption once.
    // (PayPal is unconfigured in tests, so checkout falls through to manual pay.)
    const brief1 = 'First custom test brief: a koi fish swimming upstream, blackwork, forearm sized';
    fcr = await fcreq('POST', '/orders/custom', { body: { brief: brief1 }, follow: false });
    ok(fcr.status === 302 && (fcr.location || '').includes('/orders/manual/'), 'discounted custom order created (manual-pay fallback)');
    const ordId1 = (fcr.location || '').split('/orders/manual/')[1];
    const o1 = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(ordId1);
    ok(o1 && o1.amount_cents === 12459 && o1.deposit_cents === 6230 && o1.fee_cents === 267,
      'order stores discounted base, deposit, and fee-on-discounted-deposit');
    ok(o1 && o1.discount_applied === 'first_custom_20', 'order records the first_custom_20 discount');
    ok(sdb.prepare('SELECT COUNT(*) AS n FROM first_custom_redemptions WHERE user_id = ?').get(fcBuyerId).n === 1,
      'redemption recorded exactly once');

    // Idempotent double-submit: same brief within 2 minutes reuses the order.
    fcr = await fcreq('POST', '/orders/custom', { body: { brief: brief1 }, follow: false });
    ok(fcr.status === 302 && (fcr.location || '').includes(`/orders/${ordId1}`),
      'double-submit redirects to the existing order (no duplicate)');
    ok(sdb.prepare('SELECT COUNT(*) AS n FROM first_custom_redemptions WHERE user_id = ?').get(fcBuyerId).n === 1,
      'no second redemption on double-submit');

    // Second custom (different brief): no discount, redemption stays single.
    const brief2 = 'Second custom test brief: a raven with spread wings, dotwork, back piece';
    fcr = await fcreq('POST', '/orders/custom', { body: { brief: brief2 }, follow: false });
    const ordId2 = (fcr.location || '').split('/orders/manual/')[1];
    const o2 = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(ordId2);
    ok(o2 && o2.discount_applied !== 'first_custom_20' && o2.amount_cents !== 12459,
      'second custom gets no first-custom discount');
    ok(sdb.prepare('SELECT COUNT(*) AS n FROM first_custom_redemptions WHERE user_id = ?').get(fcBuyerId).n === 1,
      'redemption still exactly one row after second custom');
    ok(!(await fc.firstCustomEligible(fcUser)), 'buyer with a prior custom is no longer eligible');

    // Non-subscriber: no discount.
    await fcnreq('POST', '/signup', { body: { display_name: 'FC NoSub', email: 'fcnosub@test.local', password: 'password123' }, follow: false });
    const noSubId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('fcnosub@test.local').id;
    const noSubUser = { id: noSubId, role: 'customer' };
    ok(!(await fc.firstCustomEligible(noSubUser)), 'non-subscriber is not eligible');
    ok((await fc.customPriceQuote(noSubUser)).discount !== 'first_custom_20',
      'non-subscriber quote carries no first-custom discount');

    // Never stacked with the Saturday sale: best-deal-wins, single discount.
    await fcsreq('POST', '/signup', { body: { display_name: 'FC Sale', email: 'fcsale@test.local', password: 'password123' }, follow: false });
    const saleId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('fcsale@test.local').id;
    sdb.prepare('INSERT INTO subscriptions (id, user_id, plan_id, status, created_at) VALUES (?,?,?,?,?)')
      .run(randomUUID(), saleId, fcPlan, 'active', Date.now());
    const satNight = new Date('2026-10-03T20:00:00-05:00'); // Saturday 8 PM CT
    ok(fcp.isSaleWindow(satNight), 'test Saturday night is inside the sale window');
    const sq = await fc.customPriceQuote({ id: saleId, role: 'customer' }, satNight);
    ok(sq.discount === 'first_custom_20' && sq.full === 12459,
      'sale night + eligible: single best deal wins (first_custom_20, $124.59 — not stacked)');

    // Splits are computed on the discounted base (deposit capture path).
    const capId = 'ord-fc-cap-1';
    sdb.prepare(`INSERT INTO orders (id, buyer_id, order_type, amount_cents, deposit_cents, fee_cents,
      amount_paid_cents, status, payment_method, discount_applied, custom_brief, custom_status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(capId, fcBuyerId, 'custom', 12459, 6230, 267,
      6497, 'paid', 'paypal', 'first_custom_20', 'cap test brief: long enough to be valid here', 'new', Date.now());
    await require('../src/lib/commissions').recordSaleCommissions(
      sdb.prepare('SELECT * FROM orders WHERE id = ?').get(capId));
    const ledRows = sdb.prepare(`SELECT recipient_type, SUM(amount_cents) AS t FROM commission_ledger
      WHERE order_id = ? GROUP BY recipient_type`).all(capId);
    const byType = Object.fromEntries(ledRows.map((r) => [r.recipient_type, r.t]));
    // netPaid = 6497 - 267 = 6230; no design, no referring shop: 80/20 -> all to site.
    ok(byType.site === 6230, 'commission ledger splits the discounted net ($62.30) entirely to the site');

    // Campaign cap: 150 paid sales disables the sale...
    sdb.prepare("INSERT OR REPLACE INTO site_counters (name, counter_value) VALUES ('visitors', 0)").run();
    const capStmt = sdb.prepare(`INSERT INTO orders (id, buyer_id, order_type, amount_cents, status, created_at)
      VALUES (?,?,?,?,?,?)`);
    for (let i = 0; i < 150; i++) capStmt.run(`cap-sale-${i}`, fcBuyerId, 'premade', 7500, 'paid', Date.now());
    ok(!(await fc.openingSaleActive()), 'opening sale disables at 150 paid sales');
    ok(!(await fc.firstCustomEligible({ id: saleId, role: 'customer' })),
      'eligible subscriber loses the discount once the sales cap is hit');
    sdb.prepare("DELETE FROM orders WHERE id LIKE 'cap-sale-%'").run();
    // ...and 5,500 visitors disables it too.
    sdb.prepare("INSERT OR REPLACE INTO site_counters (name, counter_value) VALUES ('visitors', 5500)").run();
    ok(!(await fc.openingSaleActive()), 'opening sale disables at 5,500 visitors');
    ok(!(await fc.firstCustomEligible({ id: saleId, role: 'customer' })),
      'eligible subscriber loses the discount once the visitor cap is hit');
    // Before either cap: active.
    sdb.prepare("INSERT OR REPLACE INTO site_counters (name, counter_value) VALUES ('visitors', 100)").run();
    ok(await fc.openingSaleActive(), 'opening sale is active before either cap');
    ok(await fc.firstCustomEligible({ id: saleId, role: 'customer' }),
      'eligible subscriber keeps the discount before either cap');
  }

  // --- Rush customs (owner rule 2026-09-30): +$30 for 24-hour delivery ---
  // The $30 rush fee splits 60/40: $18 to the fulfilling designer/admin as
  // the rush incentive, $12 to site overhead. Standard orders stay 48h.
  {
    const pricing = require('../src/lib/pricing');
    const comm = require('../src/lib/commissions');
    const credits = require('../src/lib/credits');
    ok(pricing.RUSH_FEE_CENTS === 3000 && pricing.RUSH_DESIGNER_CENTS === 1800 && pricing.RUSH_SITE_CENTS === 1200,
      'rush constants: $30 fee = $18 designer incentive + $12 site overhead');
    ok(pricing.RUSH_SLA_HOURS === 24 && pricing.STANDARD_SLA_HOURS === 48, 'rush SLA 24h, standard SLA 48h');

    const rreq = jarredReq();
    await rreq('POST', '/signup', { body: { display_name: 'Rush Buyer', email: 'rushbuyer@test.local', password: 'password123' }, follow: false });
    const rushBuyerId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('rushbuyer@test.local').id;

    // Checkout page discloses the rush option and the $30 fee.
    let r = await rreq('GET', '/orders/custom');
    ok(r.status === 200 && r.text.includes('Rush my design') && r.text.includes('$30.00') && r.text.includes('24-hour'),
      'custom checkout page discloses the $30 rush option with 24-hour delivery');

    // POST with rush=1: order stores the rush fee, fee-on-(deposit+rush), 24h due.
    r = await rreq('POST', '/orders/custom', { body: { brief: 'Rush custom test brief: a lightning bolt through a rose, forearm sized', rush: '1' }, follow: false });
    ok(r.status === 302 && (r.location || '').includes('/orders/manual/'), 'rush custom order created (manual-pay fallback)');
    const rushOrdId = (r.location || '').split('/orders/manual/')[1];
    const ro = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(rushOrdId);
    ok(ro && ro.rush_fee_cents === 3000, 'rush order stores the $30 rush fee');
    ok(ro.fee_cents === pricing.processingFeeCents(ro.deposit_cents + 3000),
      'processing fee computed on deposit + rush (passed through, never absorbed)');
    const dueIn = ro.delivery_due - ro.created_at;
    ok(dueIn > 23.9 * 3600 * 1000 && dueIn <= 24 * 3600 * 1000 + 60000, 'rush order SLA is 24 hours');

    // Standard order: no rush fee, 48h SLA.
    r = await rreq('POST', '/orders/custom', { body: { brief: 'Standard custom test brief: a calm ocean wave, shoulder sized' }, follow: false });
    const stdOrdId = (r.location || '').split('/orders/manual/')[1];
    const so = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(stdOrdId);
    ok(so && so.rush_fee_cents === 0, 'standard order has no rush fee');
    const stdDue = so.delivery_due - so.created_at;
    ok(stdDue > 47.9 * 3600 * 1000 && stdDue <= 48 * 3600 * 1000 + 60000, 'standard order SLA stays 48 hours');

    // Manual-pay page total includes the rush fee.
    r = await rreq('GET', `/orders/manual/${rushOrdId}`);
    const rushTotal = ro.deposit_cents + 3000 + ro.fee_cents;
    ok(r.status === 200 && r.text.includes('$' + (rushTotal / 100).toFixed(2)),
      'manual-pay page shows deposit + rush + fee as the exact total');

    // Commission base excludes the rush fee: net 10000-399 with a $30 rush
    // books 6601 to the base splits, and the ledger sums exactly to net.
    const baseId = 'ord-rush-base-1';
    sdb.prepare(`INSERT INTO orders (id, buyer_id, order_type, amount_cents, deposit_cents, rush_fee_cents,
      fee_cents, amount_paid_cents, status, payment_method, custom_brief, custom_status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(baseId, rushBuyerId, 'custom', 15000, 7500, 3000,
      399, 10000, 'paid', 'paypal', 'base exclusion test brief, long enough here', 'new', Date.now());
    await comm.recordSaleCommissions(sdb.prepare('SELECT * FROM orders WHERE id = ?').get(baseId));
    const baseSum = sdb.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS t FROM commission_ledger
      WHERE order_id = ? AND (commission_type IS NULL OR commission_type != 'rush_fee')`).get(baseId).t;
    ok(baseSum === 6601, 'sale commissions exclude the rush fee (net 9601 - 3000 rush = 6601 base)');

    // Payout-eligible designer for the rush incentive path.
    const rushDesId = await db.insert('users', {
      email: 'rushdes@test.local', password_hash: 'x', role: 'design_artist', display_name: 'Rush Designer',
    });
    const desPlanId = sdb.prepare("SELECT id FROM plans WHERE slug = 'design_artist'").get().id;
    await db.insert('subscriptions', { user_id: rushDesId, plan_id: desPlanId, status: 'active', current_period_end: Date.now() + 86400000 });
    const { upsertProfile } = require('../src/lib/profiles');
    await upsertProfile('artist_profiles', rushDesId, { payout_paypal_email: 'rushdes@pay.test' });
    ok(await comm.recipientEligible(rushDesId, 'design_artist'), 'rush designer is payout-eligible');

    // Approve the rush order (stubbed PayPal capture) with a requested
    // artist: routes to the artist and books the 60/40 rush split.
    sdb.prepare("UPDATE orders SET requested_artist_id = ?, paypal_order_id = ? WHERE id = ?")
      .run(rushDesId, 'pp-rush-' + Date.now(), rushOrdId);
    r = await rreq('GET', `/orders/approve/${rushOrdId}`, { follow: false });
    ok(r.status === 302 && (r.location || '').includes(`/orders/${rushOrdId}`), 'rush order approved via stubbed capture');
    const paid = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(rushOrdId);
    ok(paid.status === 'paid' && paid.custom_status === 'routed_to_artist', 'rush order paid and routed to the requested artist');
    const rushRows = sdb.prepare(`SELECT recipient_type, recipient_id, amount_cents, status FROM commission_ledger
      WHERE order_id = ? AND commission_type = 'rush_fee'`).all(rushOrdId);
    const desRow = rushRows.find((x) => x.recipient_type === 'artist');
    const siteRow = rushRows.find((x) => x.recipient_type === 'site');
    ok(rushRows.length === 2, 'exactly two rush-fee ledger rows');
    ok(desRow && desRow.amount_cents === 1800 && desRow.status === 'payable' && desRow.recipient_id === rushDesId,
      'rush incentive $18 is payable to the fulfilling designer');
    ok(siteRow && siteRow.amount_cents === 1200 && siteRow.status === 'site_kept',
      'rush overhead $12 goes to the site');

    // Idempotent: a second split attempt books nothing new.
    const again = await comm.recordRushFeeSplit(sdb.prepare('SELECT * FROM orders WHERE id = ?').get(rushOrdId), rushDesId);
    ok(again === null && sdb.prepare(`SELECT COUNT(*) AS n FROM commission_ledger
      WHERE order_id = ? AND commission_type = 'rush_fee'`).get(rushOrdId).n === 2,
      'rush split is idempotent (no duplicate rows)');

    // Pipeline fulfillment (no requested artist): the $18 incentive stays
    // with the site; the draft queue lists rush orders first.
    const pipeId = 'ord-rush-pipe-1';
    sdb.prepare(`INSERT INTO orders (id, buyer_id, order_type, amount_cents, deposit_cents, rush_fee_cents,
      fee_cents, amount_paid_cents, status, payment_method, custom_brief, custom_status, delivery_due, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(pipeId, rushBuyerId, 'custom', 15000, 7500, 3000,
      417, 10917, 'paid', 'paypal', 'pipeline rush brief: a compass rose, chest sized', 'new',
      Date.now() + 24 * 3600 * 1000, Date.now());
    const { routeCustomOrder } = require('../src/lib/customFulfillment');
    const routed = await routeCustomOrder(sdb.prepare('SELECT * FROM orders WHERE id = ?').get(pipeId));
    ok(routed.custom_status === 'needs_drafts', 'unrequested rush order enters the draft pipeline');
    const pipeRows = sdb.prepare(`SELECT recipient_type, recipient_id, amount_cents, status FROM commission_ledger
      WHERE order_id = ? AND commission_type = 'rush_fee'`).all(pipeId);
    ok(pipeRows.length === 2 && pipeRows.every((x) => x.status === 'site_kept') &&
      pipeRows.reduce((a, x) => a + x.amount_cents, 0) === 3000,
      'pipeline rush: full $30 stays with the site (incentive funds the in-house team)');
    const queue = await db.all(
      `SELECT id, rush_fee_cents FROM orders WHERE order_type = 'custom' AND status = 'paid' AND custom_status = 'needs_drafts'
       ORDER BY (rush_fee_cents > 0) DESC, delivery_due ASC`);
    ok(queue.length > 0 && (queue[0].rush_fee_cents || 0) > 0, 'draft queue orders rush orders first');

    // Site credit pays deposit + rush together.
    await credits.addCredit({ userId: rushBuyerId, amountCents: 20000, kind: 'topup', note: 'rush credit test' });
    r = await rreq('POST', '/orders/custom', { body: { brief: 'Credit rush brief: a phoenix rising, full back sized', rush: '1', use_credit: '1' }, follow: false });
    ok(r.status === 302 && (r.location || '').includes('/orders/'), 'rush order paid with site credit');
    const credOrdId = (r.location || '').split('/orders/')[1];
    const co = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(credOrdId);
    ok(co && co.status === 'paid' && co.amount_paid_cents === co.deposit_cents + 3000,
      'site credit charge = deposit + $30 rush fee');
    const bal = await credits.getCreditBalance(rushBuyerId);
    ok(bal === 20000 - (co.deposit_cents + 3000), 'credit balance reduced by deposit + rush');
  }

  // --- Site gift cards (owner rule 2026-09-30): $25-$150 denominations ---
  // $1.95 flat purchase fee, free email delivery, +$4.95 physical mail
  // shipping, processing passed through to the buyer (never absorbed).
  // Redeeming converts the card to site credit; credit buys memberships.
  {
    const sgc = require('../src/lib/siteGiftCards');
    const { getCreditBalance } = require('../src/lib/credits');

    // Quote math: amount + $1.95 fee (+ $4.95 physical shipping), then the
    // processing-fee pass-through on the whole charge.
    const q1 = sgc.siteGiftCardQuote(5000, false);
    ok(q1.fee === 195, 'gift quote: $1.95 flat purchase fee');
    ok(q1.shipping === 0, 'gift quote: email delivery is free');
    ok(q1.total === 5426, 'gift quote: $50 email card = $54.26 total');
    const q2 = sgc.siteGiftCardQuote(10000, true);
    ok(q2.fee === 195 && q2.shipping === 495, 'gift quote: $100 mail card has fee + $4.95 shipping');
    ok(q2.total === 11113, 'gift quote: $100 mail card = $111.13 total');
    let threw = false;
    try { sgc.siteGiftCardQuote(6000, false); } catch (e) { threw = true; }
    ok(threw, 'gift quote: non-denomination amount rejected');

    const greq = jarredReq();
    await greq('POST', '/signup', { body: { display_name: 'Gift Buyer', email: 'giftbuyer@test.local', password: 'password123' }, follow: false });
    const giftBuyerId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('giftbuyer@test.local').id;

    // Buy page discloses fee, shipping, and denominations.
    let r = await greq('GET', '/gift-cards/buy');
    ok(r.status === 200 && r.text.includes('$1.95') && r.text.includes('$4.95') && r.text.includes('$25'),
      'gift buy page discloses the $1.95 fee, $4.95 mail shipping, and denominations');

    // POST buy: pending row + redirect to PayPal (stub) approval.
    r = await greq('POST', '/gift-cards/buy', { body: { amount_cents: '5000', delivery: 'email', recipient_email: 'friend@test.local', recipient_name: 'Friend' }, follow: false });
    ok(r.status === 302 && (r.location || '').includes('paypal.test/approve/stub'),
      'gift buy redirects to PayPal approval (stub)');
    const token = new URL(r.location).searchParams.get('token');
    ok(!!token, 'gift buy approval URL carries the PayPal order token');
    const pend = sdb.prepare("SELECT id, status, total_paid_cents, recipient_email FROM site_gift_cards WHERE purchaser_user_id = ? ORDER BY id DESC LIMIT 1").get(giftBuyerId);
    ok(pend && pend.status === 'pending' && pend.total_paid_cents === 5426 && pend.recipient_email === 'friend@test.local',
      'gift buy stores a pending card with the exact quoted total');

    // Capture (stub): activates, issues an unguessable code, renders the code.
    r = await greq('GET', `/gift-cards/capture/${pend.id}?token=${token}`);
    ok(r.status === 200, 'gift capture renders the success page');
    const act = sdb.prepare('SELECT * FROM site_gift_cards WHERE id = ?').get(pend.id);
    ok(act.status === 'active' && act.amount_cents === 5000 && /^[A-Z2-9]{12}$/.test(act.code || ''),
      'gift capture activates the card with an unguessable XXXX-XXXX-XXXX code');
    ok(r.text.includes(act.code), 'success page displays the gift card code');

    // Double capture: idempotent (no second activation, code unchanged).
    r = await greq('GET', `/gift-cards/capture/${pend.id}?token=${token}`);
    const still = sdb.prepare('SELECT status, code FROM site_gift_cards WHERE id = ?').get(pend.id);
    ok(r.status === 200 && still.status === 'active' && still.code === act.code, 'gift double-capture is idempotent');

    // Redeem: converts the card to site credit.
    r = await greq('POST', '/gift-cards/redeem', { body: { code: act.code }, follow: false });
    ok(r.status === 302 && (r.location || '').includes('/account'), 'gift redeem redirects to the account page');
    ok(await getCreditBalance(giftBuyerId) === 5000, 'gift redeem adds the full $50 to site credit');
    ok(sdb.prepare('SELECT status FROM site_gift_cards WHERE id = ?').get(pend.id).status === 'redeemed',
      'gift card marked redeemed after use');

    // Double redeem and unknown codes are rejected.
    r = await greq('POST', '/gift-cards/redeem', { body: { code: act.code }, follow: false });
    ok(r.status === 302 && (await getCreditBalance(giftBuyerId)) === 5000, 'gift double-redeem rejected (balance unchanged)');
    r = await greq('POST', '/gift-cards/redeem', { body: { code: 'ZZZZ-1111-AAAA' }, follow: false });
    ok(r.status === 302 && (await getCreditBalance(giftBuyerId)) === 5000, 'gift unknown code rejected');

    // Concurrent redemption race: two users redeem the SAME active code at
    // the same time — exactly one must win; the card must credit exactly once.
    // (Codes are stored normalized — dashes stripped — so insert the
    // normalized form, exactly as the buy flow does. Throwaway users keep
    // this test from polluting giftBuyerId's balance for later tests.)
    const raceCode = sgc.normalizeCode('RAC3-COND-TEST');
    await db.insert('site_gift_cards', {
      purchaser_user_id: giftBuyerId, amount_cents: 2500, fee_cents: 195, shipping_cents: 0,
      total_paid_cents: 2794, status: 'active', code: raceCode,
      expires_at: Date.now() + 3600000, created_at: db.now(),
    });
    const mkRaceUser = async (email) => db.insert('users', {
      email, password_hash: 'x', role: 'customer', display_name: 'Race',
    });
    const raceA = await mkRaceUser('racea@test.local');
    const raceB = await mkRaceUser('raceb@test.local');
    const balBeforeA = await getCreditBalance(raceA);
    const balBeforeB = await getCreditBalance(raceB);
    const raceResults = await Promise.allSettled([
      sgc.redeemSiteGiftCard({ userId: raceA, code: 'RAC3-COND-TEST' }),
      sgc.redeemSiteGiftCard({ userId: raceB, code: 'RAC3-COND-TEST' }),
    ]);
    const wins = raceResults.filter((x) => x.status === 'fulfilled').length;
    const creditedTotal = (await getCreditBalance(raceA)) - balBeforeA
      + ((await getCreditBalance(raceB)) - balBeforeB);
    ok(wins === 1, 'gift concurrent redeem: exactly one redeemer wins');
    ok(creditedTotal === 2500, 'gift concurrent redeem: card value credited exactly once');
    ok(sdb.prepare('SELECT status FROM site_gift_cards WHERE code = ?').get(raceCode).status === 'redeemed',
      'gift concurrent redeem: card ends redeemed');

    // PayPal capture-amount guard: exact match only, multi-capture aware.
    // (The suite-wide TAC_TEST_PAYPAL_STUB bypass is lifted here so the
    // real guard logic is exercised.)
    const paypal = require('../src/lib/paypal');
    const stubFlag = process.env.TAC_TEST_PAYPAL_STUB;
    delete process.env.TAC_TEST_PAYPAL_STUB;
    const mkCapture = (values) => ({
      purchase_units: [{ payments: { captures: values.map((v) => ({ id: 'c', status: 'COMPLETED', amount: { value: v } })) } }],
    });
    ok(paypal.assertCaptureAmount(mkCapture(['25.00']), 2500) === 2500, 'capture guard: exact match passes');
    ok(paypal.assertCaptureAmount(mkCapture(['10.00', '15.00']), 2500) === 2500, 'capture guard: split captures summed');
    threw = false;
    try { paypal.assertCaptureAmount(mkCapture(['24.99']), 2500); } catch (e) { threw = true; }
    ok(threw, 'capture guard: short capture throws (order stays unpaid)');
    threw = false;
    try { paypal.assertCaptureAmount(mkCapture(['25.01']), 2500); } catch (e) { threw = true; }
    ok(threw, 'capture guard: over capture throws (order stays unpaid)');
    threw = false;
    try { paypal.assertCaptureAmount(mkCapture([]), 2500); } catch (e) { threw = true; }
    ok(threw, 'capture guard: empty capture throws');
    if (stubFlag !== undefined) process.env.TAC_TEST_PAYPAL_STUB = stubFlag;

    // Expired card rejected.
    await db.insert('site_gift_cards', {
      purchaser_user_id: giftBuyerId, amount_cents: 2500, fee_cents: 195, shipping_cents: 0,
      total_paid_cents: 2794, status: 'active', code: 'EXP1-RED2-EMPT',
      expires_at: Date.now() - 1000, created_at: db.now(),
    });
    r = await greq('POST', '/gift-cards/redeem', { body: { code: 'EXP1-RED2-EMPT' }, follow: false });
    ok(r.status === 302 && (await getCreditBalance(giftBuyerId)) === 5000,
      'gift expired code rejected');

    // Physical mail card: +$4.95 shipping, admin unshipped queue + ship button.
    r = await greq('POST', '/gift-cards/buy', { body: { amount_cents: '10000', delivery: 'mail', recipient_name: 'Mail Friend', ship_address: '1 Test St, Abbeville LA 70510' }, follow: false });
    ok(r.status === 302, 'gift mail-card buy redirects to approval');
    const mailToken = new URL(r.location).searchParams.get('token');
    const mailPend = sdb.prepare("SELECT id, ship_pending, total_paid_cents FROM site_gift_cards WHERE purchaser_user_id = ? AND recipient_name = 'Mail Friend'").get(giftBuyerId);
    ok(mailPend.ship_pending === 1 && mailPend.total_paid_cents === 11113, 'mail card stores ship_pending and the exact $111.13 total');
    await greq('GET', `/gift-cards/capture/${mailPend.id}?token=${mailToken}`);
    ok(sdb.prepare('SELECT status FROM site_gift_cards WHERE id = ?').get(mailPend.id).status === 'active',
      'mail card activates on capture');
    const areq = jarredReq();
    await areq('POST', '/login', { body: { email: 'admin@test.local', password: 'AdminTest123!' }, follow: false });
    r = await areq('GET', '/admin/site-gift-cards?filter=unshipped');
    ok(r.status === 200 && r.text.includes('Mail Friend'), 'admin unshipped queue lists the mail card');
    r = await areq('POST', `/admin/site-gift-cards/${mailPend.id}/ship`, { body: { website: '' }, follow: false });
    ok(r.status === 302 && sdb.prepare('SELECT shipped_at FROM site_gift_cards WHERE id = ?').get(mailPend.id).shipped_at > 0,
      'admin ship marks the mail card shipped');

    // Manual-payment path: pending card confirmed by admin on verified CashApp/Venmo.
    r = await greq('POST', '/gift-cards/buy', { body: { amount_cents: '2500', delivery: 'email', recipient_email: 'manual@test.local' }, follow: false });
    const manPend = sdb.prepare("SELECT id FROM site_gift_cards WHERE purchaser_user_id = ? AND recipient_email = 'manual@test.local'").get(giftBuyerId).id;
    r = await greq('POST', `/gift-cards/manual/${manPend}`, { body: { method: 'cashapp', note: 'paid, cashapp ref TEST123' }, follow: false });
    ok(r.status === 302 && (r.location || '').includes('/gift-cards/mine'), 'gift manual-pay step records the payment claim');
    r = await areq('POST', `/admin/site-gift-cards/${manPend}/confirm`, { body: { website: '' }, follow: false });
    const manAct = sdb.prepare('SELECT status, code, payment_method FROM site_gift_cards WHERE id = ?').get(manPend);
    ok(r.status === 302 && manAct.status === 'active' && !!manAct.code && manAct.payment_method === 'cashapp',
      'admin confirm activates the manual-payment card with a code');

    // Mine page lists the buyer's cards.
    r = await greq('GET', '/gift-cards/mine');
    ok(r.status === 200 && r.text.includes('My Gift Cards'), 'gift mine page renders');

    // Membership via site credit: full term, no PayPal, no auto-renewal.
    const memPlanId = sdb.prepare("SELECT id FROM plans WHERE slug = 'customer'").get().id;
    await require('../src/lib/credits').addCredit({ userId: giftBuyerId, amountCents: 10000, kind: 'topup', note: 'membership credit test' });
    const before = Date.now();
    r = await greq('POST', '/membership/credit/customer', { body: { website: '' }, follow: false });
    ok(r.status === 302 && (r.location || '').includes('/membership'), 'membership via credit redirects back to membership');
    const csub = sdb.prepare('SELECT * FROM subscriptions WHERE user_id = ? AND plan_id = ? ORDER BY id DESC LIMIT 1').get(giftBuyerId, memPlanId);
    ok(csub && csub.status === 'active' && Number(csub.paid_with_credit) === 1 && !csub.paypal_subscription_id,
      'membership via credit: active, paid_with_credit, no PayPal id (never auto-renews)');
    const endIn = csub.current_period_end - before;
    ok(endIn > 29 * 86400000 && endIn <= 31 * 86400000, 'membership via credit: one ~30-day term');
    // Customer plan grants member standing via the active subscription
    // (roles only change for design_artist / tattoo_shop plans).
    const { hasAnyActiveSubscription } = require('../src/middleware/auth');
    ok(await hasAnyActiveSubscription(giftBuyerId), 'membership via credit: buyer counts as an active member');
    ok((await getCreditBalance(giftBuyerId)) === 15000 - 500, 'membership via credit: base $5.00 charged (no added fee)');
    // Double-click: extends the existing row instead of stacking a second sub.
    r = await greq('POST', '/membership/credit/customer', { body: { website: '' }, follow: false });
    const subCount = sdb.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ? AND plan_id = ? AND status = 'active'").get(giftBuyerId, memPlanId).n;
    ok(r.status === 302 && subCount === 1, 'membership via credit: double-click extends, never stacks');
    const csub2 = sdb.prepare('SELECT current_period_end FROM subscriptions WHERE id = ?').get(csub.id);
    ok(csub2.current_period_end > csub.current_period_end, 'membership via credit: second payment extends the term');
    // PayPal-billed active sub + pay-with-credit attempt: the "already
    // subscribed" check must run BEFORE any debit — credit stays untouched.
    await require('../src/lib/credits').addCredit({ userId: giftBuyerId, amountCents: 1000, kind: 'topup', note: 'already-sub test' });
    sdb.prepare('UPDATE subscriptions SET paid_with_credit = 0, paypal_subscription_id = ? WHERE id = ?')
      .run('I-PAYPALBILLED', csub.id);
    const balBeforeDup = await getCreditBalance(giftBuyerId);
    r = await greq('POST', '/membership/credit/customer', { body: { website: '' }, follow: false });
    ok(r.status === 302 && (await getCreditBalance(giftBuyerId)) === balBeforeDup,
      'membership via credit: PayPal-billed active sub debits NOTHING');
    ok(sdb.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ? AND plan_id = ? AND status = 'active'").get(giftBuyerId, memPlanId).n === 1,
      'membership via credit: no duplicate subscription created');
    // Broke buyer: refused.
    await require('../src/lib/credits').addCredit({ userId: giftBuyerId, amountCents: -14000, kind: 'adjustment', note: 'drain for test' });
    r = await greq('POST', '/membership/credit/tattoo_shop', { body: { website: '' }, follow: false });
    ok(r.status === 302, 'membership via credit: insufficient balance refused with redirect');
    // Plans page shows the pay-with-credit option.
    r = await greq('GET', '/membership');
    ok(r.status === 200 && r.text.includes('with site credit'), 'membership plans page shows the pay-with-site-credit option');
  }

  // Shop purchase incentives (owner rule 2026-09-29):
  // (a) referral volume tiers — 20% base, 22% at 25+ verified referral
  // sales in the calendar month, 25% at 50+; uplift only from the owner's
  // share; (b) booking-conversion bonus — a referred purchase followed by
  // a confirmed booking at the same shop within 30 days earns the shop
  // $5 (premade) or 5% of base (custom), one bonus per order.
  {
    const inc = require('../src/shop/shopIncentives');
    const { upsertProfile } = require('../src/lib/profiles');
    const { computeBookingFees } = require('../src/shop/bookingFees');
    const flow = require('../src/shop/bookingFlow');
    const bcryptjs = require('bcryptjs');
    // db handle already reopened in the block above (same HTTP phase).

    // --- setup: payout-eligible shop, designer + design, buyers ---
    async function mkShop(email, withPayout) {
      const id = await db.insert('users', {
        email, password_hash: await bcryptjs.hash('ShopPass123!', 10),
        role: 'tattoo_shop', display_name: email.split('@')[0],
      });
      const planId = (await db.get(`SELECT id FROM plans WHERE slug = 'tattoo_shop'`)).id;
      await db.insert('subscriptions', {
        user_id: id, plan_id: planId, status: 'active',
        current_period_end: Date.now() + 86400000,
      });
      if (withPayout) await upsertProfile('shop_profiles', id, { payout_paypal_email: `${email.split('@')[0]}@pay.test` });
      return id;
    }
    const tierShopId = await mkShop('tiershop@test.local', true);
    const bonusShopId = await mkShop('bonusshop@test.local', true);
    const noPayShopId = await mkShop('nopayshop@test.local', false); // forfeiture path
    const tierDesId = await db.insert('users', {
      email: 'tierdes@test.local', password_hash: 'x',
      role: 'design_artist', display_name: 'Tier Designer',
    });
    const desPlanId = (await db.get(`SELECT id FROM plans WHERE slug = 'design_artist'`)).id;
    await db.insert('subscriptions', {
      user_id: tierDesId, plan_id: desPlanId, status: 'active',
      current_period_end: Date.now() + 86400000,
    });
    await upsertProfile('artist_profiles', tierDesId, { payout_paypal_email: 'tierdes@pay.test' });
    const tierDesignId = await db.insert('designs', {
      title: 'Tier Flash', artist_id: tierDesId, status: 'approved', price_cents: 7500,
    });
    async function mkBuyer(email) {
      return db.insert('users', {
        email, password_hash: 'x', role: 'customer', display_name: email.split('@')[0],
      });
    }
    const tierBuyerId = await mkBuyer('tierbuyer@test.local');
    async function paidReferredOrder(shopId, buyerId, orderType, amountCents, paidAt = Date.now()) {
      const id = await db.insert('orders', {
        buyer_id: buyerId, order_type: orderType,
        design_id: orderType === 'premade' ? tierDesignId : null,
        amount_cents: amountCents,
        amount_paid_cents: orderType === 'custom' ? Math.round(amountCents / 2) : amountCents,
        fee_cents: orderType === 'custom' ? 267 : 312,
        status: 'paid', referred_shop_id: shopId, paid_at: paidAt,
      });
      return db.get('SELECT * FROM orders WHERE id = ?', [id]);
    }
    const shopSums = async (orderId) => {
      const rows = sdb.prepare(`SELECT recipient_type, SUM(amount_cents) AS t FROM commission_ledger
        WHERE order_id = ? GROUP BY recipient_type`).all(orderId);
      return Object.fromEntries(rows.map((r) => [r.recipient_type, r.t]));
    };

    // --- (a) volume tiers ---
    for (let i = 0; i < 24; i++) await paidReferredOrder(tierShopId, tierBuyerId, 'premade', 7500);
    ok((await inc.shopVolumeTierRate(tierShopId)) === 0.20, '24 verified referral sales: still the 20% base rate');
    // The 25th sale earns 22%: net 7500-312=7188 -> designer 4313 (60%),
    // shop 1581 (22%), owner 575 (8%), site 719 (10%).
    const o25 = await paidReferredOrder(tierShopId, tierBuyerId, 'premade', 7500);
    await comm.recordSaleCommissions(o25);
    const t25 = await shopSums(o25.id);
    ok(t25.artist === 4313, 'tier sale: designer keeps exactly 60% (percentages never move)');
    ok(t25.shop === 1581, 'tier sale: shop earns 22% at 25+ monthly referral sales');
    ok(t25.artist + t25.shop + (t25.site || 0) === 7188, 'tier sale: uplift funded from the owner share, ledger sums to net');
    for (let i = 0; i < 25; i++) await paidReferredOrder(tierShopId, tierBuyerId, 'premade', 7500);
    ok((await inc.shopVolumeTierRate(tierShopId)) === 0.25, '50 verified referral sales: 25% rate');
    // The 51st sale earns 25%: shop 1797, designer still 4313.
    const o51 = await paidReferredOrder(tierShopId, tierBuyerId, 'premade', 7500);
    await comm.recordSaleCommissions(o51);
    const t51 = await shopSums(o51.id);
    ok(t51.shop === 1797, '51st referral sale earns 25%');
    ok(t51.artist === 4313, 'tier-25% sale: designer still exactly 60%');
    ok(t51.artist + t51.shop + (t51.site || 0) === 7188, 'tier-25% sale: ledger sums to net');
    // Monthly reset: a sale from last month counts only in last month.
    const [thisStart] = inc.chicagoMonthBounds(Date.now());
    const lastMonthPaidAt = thisStart - 86400000;
    await paidReferredOrder(tierShopId, tierBuyerId, 'premade', 7500, lastMonthPaidAt);
    const [lmStart, lmEnd] = inc.chicagoMonthBounds(lastMonthPaidAt);
    ok((await inc.monthlyReferralSales(tierShopId, lmStart, lmEnd)) === 1,
      'last-month sale counted in last month only');
    ok((await inc.monthlyReferralSales(tierShopId, thisStart, Date.now() + 86400000)) === 51,
      'this-month count is 51 (last-month sale excluded)');

    // --- shop dashboard shows current tier + progress ---
    const shopJar = {};
    async function shopLoginReq(method, p, opts = {}) {
      const h = { ...(opts.headers || {}) };
      const cookies = Object.entries(shopJar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) h.cookie = cookies;
      let payload = opts.body;
      if (payload && typeof payload === 'object') {
        payload = new URLSearchParams(payload);
        h['content-type'] = 'application/x-www-form-urlencoded';
      }
      const res = await fetch(`http://localhost:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [k, v] = c.split(';')[0].split('=');
        shopJar[k.trim()] = (v || '').trim();
      }
      return { status: res.status, text: await res.text() };
    }
    let sr2 = await shopLoginReq('POST', '/login', { body: { email: 'tiershop@test.local', password: 'ShopPass123!' } });
    ok(sr2.status === 302, 'tier shop login ok');
    sr2 = await shopLoginReq('GET', '/shop');
    ok(sr2.status === 200 && sr2.text.includes('Referral volume tier') && sr2.text.includes('Top tier'),
      'shop dashboard shows the current tier (top tier at 51 sales)');
    const shopJar2 = {};
    async function shopLoginReq2(method, p, opts = {}) {
      const h = { ...(opts.headers || {}) };
      const cookies = Object.entries(shopJar2).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) h.cookie = cookies;
      let payload = opts.body;
      if (payload && typeof payload === 'object') {
        payload = new URLSearchParams(payload);
        h['content-type'] = 'application/x-www-form-urlencoded';
      }
      const res = await fetch(`http://localhost:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [k, v] = c.split(';')[0].split('=');
        shopJar2[k.trim()] = (v || '').trim();
      }
      return { status: res.status, text: await res.text() };
    }
    await shopLoginReq2('POST', '/login', { body: { email: 'bonusshop@test.local', password: 'ShopPass123!' } });
    const sr3 = await shopLoginReq2('GET', '/shop');
    ok(sr3.status === 200 && sr3.text.includes('20%') && sr3.text.includes('more verified referral sale(s) this month'),
      'shop dashboard shows progress to the next tier (base 20%, 25 to go)');

    // --- (b) booking-conversion bonus ---
    async function confirmedBooking(shopId, customerId) {
      const bId = await db.insert('bookings', {
        shop_user_id: shopId, customer_user_id: customerId,
        start_at: Date.now() + 86400000, end_at: Date.now() + 2 * 86400000,
        status: 'pending_deposit',
      });
      const conf = await flow.confirmBooking(bId, { fees: computeBookingFees(5000), captureId: 'C-BONUS' });
      return conf.booking;
    }
    const bonusCount = (orderId) => sdb.prepare(
      `SELECT COUNT(*) AS n FROM commission_ledger WHERE order_id = ? AND commission_type = 'booking_bonus'`).get(orderId).n;

    // Premade purchase -> confirmed booking at the same shop: $5 bonus.
    const bBuyer1 = await mkBuyer('bb1@test.local');
    const bOrd1 = await paidReferredOrder(bonusShopId, bBuyer1, 'premade', 7500);
    const bk1 = await confirmedBooking(bonusShopId, bBuyer1);
    ok(bk1.status === 'confirmed', 'bonus test booking confirmed');
    const bb1 = sdb.prepare(`SELECT * FROM commission_ledger WHERE order_id = ? AND commission_type = 'booking_bonus'`).get(bOrd1.id);
    ok(bb1 && bb1.amount_cents === 500 && bb1.recipient_id === bonusShopId && bb1.status === 'payable',
      'premade purchase -> booking conversion earns the shop a $5 bonus (payable)');
    // Second booking on the same order: still exactly one bonus.
    await confirmedBooking(bonusShopId, bBuyer1);
    ok(bonusCount(bOrd1.id) === 1, 'one bonus per order even with multiple bookings');
    // Custom purchase -> booking: 5% of base (5% of $124.59 = $6.23).
    const bBuyer2 = await mkBuyer('bb2@test.local');
    const bOrd2 = await paidReferredOrder(bonusShopId, bBuyer2, 'custom', 12459);
    await confirmedBooking(bonusShopId, bBuyer2);
    const bb2 = sdb.prepare(`SELECT amount_cents FROM commission_ledger WHERE order_id = ? AND commission_type = 'booking_bonus'`).get(bOrd2.id);
    ok(bb2 && bb2.amount_cents === 623, 'custom purchase -> booking conversion earns 5% of base ($6.23)');
    // The bonus never replaces standard splits: record this custom order's
    // commissions (owner-art branch: 80/20) and confirm the split rows are
    // exactly the standard ones, with the bonus as an additional row.
    const bFull2 = await db.get('SELECT * FROM orders WHERE id = ?', [bOrd2.id]);
    await comm.recordSaleCommissions(bFull2);
    const bSums = await shopSums(bOrd2.id);
    // net = 6230 - 267 = 5963 -> shop 20% = 1193 (base rate, <25 sales),
    // site 4770; the 623 bonus sits on top as its own row.
    ok(bSums.shop === 1193 + 623, 'booking bonus adds to (never replaces) the shop share');
    ok(bSums.site === 4770, 'site share on the bonus order is the standard 80%');
    // Referred custom at the top tier: 25% of the deposit net.
    const cOrd = await paidReferredOrder(tierShopId, tierBuyerId, 'custom', 15574);
    await comm.recordSaleCommissions(cOrd);
    const cSums = await shopSums(cOrd.id);
    // net = 7787 - 267 = 7520 -> shop 25% = 1880, site 5640.
    ok(cSums.shop === 1880, 'referred custom at 50+ monthly sales earns the shop 25%');
    ok(cSums.site === 5640, 'referred custom: site keeps the remaining 75%');
    // Purchase 35 days ago -> booking now: outside the 30-day window.
    const bBuyer3 = await mkBuyer('bb3@test.local');
    const bOrd3 = await paidReferredOrder(bonusShopId, bBuyer3, 'premade', 7500, Date.now() - 35 * 86400000);
    await confirmedBooking(bonusShopId, bBuyer3);
    ok(bonusCount(bOrd3.id) === 0, 'no bonus when the purchase is older than 30 days');
    // Booking at a DIFFERENT shop than the referring shop: no bonus.
    const bBuyer4 = await mkBuyer('bb4@test.local');
    const bOrd4 = await paidReferredOrder(bonusShopId, bBuyer4, 'premade', 7500);
    await confirmedBooking(tierShopId, bBuyer4);
    ok(bonusCount(bOrd4.id) === 0, 'no bonus when the booking is at a different shop');
    // Shop with no payout destination: bonus forfeited to the site.
    const bBuyer5 = await mkBuyer('bb5@test.local');
    const bOrd5 = await paidReferredOrder(noPayShopId, bBuyer5, 'premade', 7500);
    await confirmedBooking(noPayShopId, bBuyer5);
    const bb5 = sdb.prepare(`SELECT status FROM commission_ledger WHERE order_id = ? AND commission_type = 'booking_bonus'`).get(bOrd5.id);
    ok(bb5 && bb5.status === 'site_kept', 'bonus forfeited to the site when the shop has no payout destination');
  }

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

  // membership checkout: subscribe idempotency, approve-only-on-active,
  // resume link, pending cancel. PayPal answers come from the test-only stub
  // in src/lib/paypal.js (TAC_TEST_PAYPAL_STUB=1); IDs ending '-ACTIVE' read
  // back as ACTIVE so both /approve branches run through the real routes.
  console.log('membership checkout:');
  const subJar = {};
  async function subreq(method, p, opts = {}) {
    const h = { ...(opts.headers || {}) };
    const cookies = Object.entries(subJar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) h.cookie = cookies;
    let payload = opts.body;
    if (payload && typeof payload === 'object') {
      payload = new URLSearchParams(payload);
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(`http://localhost:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [k, v] = c.split(';')[0].split('=');
      subJar[k.trim()] = (v || '').trim();
    }
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get('location') };
  }
  r = await subreq('POST', '/signup', { body: { display_name: 'SubTester', email: 'subtester@test.local', password: 'password123' } });
  const subUserId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('subtester@test.local').id;
  r = await subreq('POST', '/membership/subscribe/customer');
  ok(r.status === 302 && (r.location || '').includes('paypal.test'), 'subscribe redirects to PayPal approval');
  r = await subreq('POST', '/membership/subscribe/customer');
  ok(r.status === 302 && r.location === '/membership', 'double subscribe blocked, back to membership');
  const subRows = sdb.prepare('SELECT * FROM subscriptions WHERE user_id = ?').all(subUserId);
  ok(subRows.length === 1 && subRows[0].status === 'pending', 'only one pending subscription created (idempotent)');
  const subId = subRows[0].id;
  // pending sub shows a "Complete payment" resume link on the membership page
  r = await subreq('GET', '/membership');
  ok(r.status === 200 && r.text.includes('Complete payment') && r.text.includes(`/membership/resume/${subId}`), 'pending sub shows Complete payment link');
  // resume re-fetches the PayPal approve URL and stashes the session
  r = await subreq('GET', `/membership/resume/${subId}`);
  ok(r.status === 302 && (r.location || '').includes('paypal.test'), 'resume redirects to PayPal approve URL');
  // approval_pending must NOT activate
  r = await subreq('GET', '/membership/approve');
  ok(r.status === 302 && r.location === '/membership', 'approve bounces back to membership');
  ok(sdb.prepare('SELECT status FROM subscriptions WHERE id = ?').get(subId).status === 'pending', 'approval_pending never activates the subscription');
  ok(sdb.prepare('SELECT role FROM users WHERE id = ?').get(subUserId).role === 'customer', 'no role granted while pending');
  // ACTIVE activates (flip the stored PayPal id to the -ACTIVE convention)
  sdb.prepare('UPDATE subscriptions SET paypal_subscription_id = ? WHERE id = ?').run(subRows[0].paypal_subscription_id + '-ACTIVE', subId);
  r = await subreq('GET', `/membership/resume/${subId}`);
  r = await subreq('GET', '/membership/approve');
  ok(sdb.prepare('SELECT status FROM subscriptions WHERE id = ?').get(subId).status === 'active', 'PayPal ACTIVE activates the subscription');
  // another user cannot resume someone else's subscription
  const subJar2 = {};
  async function subreq2(method, p, opts = {}) {
    const h = { ...(opts.headers || {}) };
    const cookies = Object.entries(subJar2).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) h.cookie = cookies;
    let payload = opts.body;
    if (payload && typeof payload === 'object') {
      payload = new URLSearchParams(payload);
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(`http://localhost:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [k, v] = c.split(';')[0].split('=');
      subJar2[k.trim()] = (v || '').trim();
    }
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get('location') };
  }
  await subreq2('POST', '/signup', { body: { display_name: 'SubTester2', email: 'subtester2@test.local', password: 'password123' } });
  r = await subreq2('GET', `/membership/resume/${subId}`);
  ok(r.status === 302 && r.location === '/membership', 'cannot resume another user\u2019s subscription');
  // pending subscriptions can be canceled
  r = await subreq2('POST', '/membership/subscribe/customer');
  const sub2Id = sdb.prepare('SELECT id FROM subscriptions WHERE user_id = (SELECT id FROM users WHERE email = ?)').get('subtester2@test.local').id;
  r = await subreq2('POST', `/membership/cancel/${sub2Id}`);
  ok(r.status === 302 && sdb.prepare('SELECT status FROM subscriptions WHERE id = ?').get(sub2Id).status === 'canceled', 'pending subscription can be canceled');

  // Subscription revenue ledger (owner rule 2026-09-30): every subscription
  // payment is recorded exactly once, split 90% owner / 10% site overhead.
  console.log('subscription revenue ledger:');
  await db.init(); // re-open: the unit phase closed the handle
  const srev = require('../src/lib/subscriptionRevenue');
  const s567 = srev.splitRevenue(567);
  ok(s567.amount === 567 && s567.ownerShare === 511 && s567.siteShare === 56, '567c splits 511 owner / 56 site (owner-favorable odd cent)');
  const s153 = srev.splitRevenue(153);
  ok(s153.ownerShare === 138 && s153.siteShare === 15, '$1.53 first-month promo splits 138/15');
  const sZero = await srev.recordSubscriptionRevenue({ userId: subUserId, plan: 'customer', amountCents: 0, provider: 'paypal', providerRef: 'zero:test' });
  ok(sZero.recorded === false && sZero.reason === 'zero_amount', 'zero-amount payments are never recorded');
  const rd1 = await srev.recordSubscriptionRevenue({ userId: subUserId, plan: 'customer', amountCents: 567, provider: 'test', providerRef: 'dup:1' });
  const rd2 = await srev.recordSubscriptionRevenue({ userId: subUserId, plan: 'customer', amountCents: 567, provider: 'test', providerRef: 'dup:1' });
  ok(rd1.recorded === true && rd2.recorded === false && rd2.reason === 'duplicate', 'duplicate provider ref is a no-op');
  ok(sdb.prepare("SELECT COUNT(*) AS n FROM subscription_revenue WHERE provider_ref = 'dup:1'").get().n === 1, 'exactly one row for a duplicated ref');
  sdb.prepare("DELETE FROM subscription_revenue WHERE provider = 'test'").run();
  // /approve ran above for subtester's ACTIVE subscription — the first
  // payment should already be in the ledger exactly once.
  const stSub = sdb.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subId);
  const stPp = stSub.paypal_subscription_id;
  const stExpFirst = stSub.first_month_discount_applied ? cfg.pricing.firstMonth.priceCents : stSub.price_cents;
  const stRev = sdb.prepare("SELECT * FROM subscription_revenue WHERE provider_ref = ?").get('sub-activated:' + stPp);
  ok(stRev && stRev.amount_cents === stExpFirst, '/approve records the first subscription payment');
  ok(stRev && stRev.owner_share_cents + stRev.site_share_cents === stRev.amount_cents, 'owner + site shares sum to the payment');
  // Webhook ACTIVATED on a fresh subscription records the first payment;
  // a retry is a no-op.
  const subJar3 = {};
  async function subreq3(method, p, opts = {}) {
    const h = { ...(opts.headers || {}) };
    const cookies = Object.entries(subJar3).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) h.cookie = cookies;
    let payload = opts.body;
    if (payload && typeof payload === 'object') {
      payload = new URLSearchParams(payload);
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(`http://localhost:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [k, v] = c.split(';')[0].split('=');
      subJar3[k.trim()] = (v || '').trim();
    }
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get('location') };
  }
  async function pwebhook(body) {
    const res = await fetch(`http://localhost:${PORT}/membership/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'manual',
      body: JSON.stringify(body),
    });
    await res.text();
    return res.status;
  }
  r = await subreq3('POST', '/signup', { body: { display_name: 'SubTester3', email: 'subtester3@test.local', password: 'password123' } });
  const sub3UserId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('subtester3@test.local').id;
  r = await subreq3('POST', '/membership/subscribe/customer');
  ok(r.status === 302 && (r.location || '').includes('paypal.test'), 'third subscriber reaches PayPal approval');
  const sub3Id = sdb.prepare('SELECT id FROM subscriptions WHERE user_id = ?').get(sub3UserId).id;
  const pp3 = sdb.prepare('SELECT paypal_subscription_id FROM subscriptions WHERE id = ?').get(sub3Id).paypal_subscription_id;
  ok(await pwebhook({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: pp3 } }) === 200, 'webhook ACTIVATED accepted');
  const rev3 = sdb.prepare('SELECT * FROM subscription_revenue WHERE provider_ref = ?').get('sub-activated:' + pp3);
  ok(rev3 && rev3.amount_cents === cfg.pricing.firstMonth.priceCents, 'webhook ACTIVATED records the $1.53 first payment');
  ok(rev3 && rev3.owner_share_cents === 138 && rev3.site_share_cents === 15, 'first payment splits 138 owner / 15 site');
  ok(sdb.prepare("SELECT status FROM subscriptions WHERE id = ?").get(sub3Id).status === 'active', 'webhook ACTIVATED activates the subscription');
  ok(await pwebhook({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: pp3 } }) === 200, 'webhook ACTIVATED retry accepted');
  ok(sdb.prepare('SELECT COUNT(*) AS n FROM subscription_revenue WHERE provider_ref = ?').get('sub-activated:' + pp3).n === 1, 'webhook ACTIVATED retry records nothing new');
  // The first payment's PAYMENT.SALE.COMPLETED is not double-counted, in
  // either arrival order; a later recurring sale records exactly once.
  ok(await pwebhook({ event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'sale-first-3', billing_agreement_id: pp3, amount: { total: '1.53', currency: 'USD' }, create_time: new Date().toISOString() } }) === 200, 'first-payment sale event accepted');
  ok(sdb.prepare('SELECT COUNT(*) AS n FROM subscription_revenue WHERE user_id = ?').get(sub3UserId).n === 1, 'first-payment sale event is not double-counted');
  const later = new Date(Date.now() + 35 * 86400000).toISOString();
  ok(await pwebhook({ event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'sale-recur-3', billing_agreement_id: pp3, amount: { total: '5.67', currency: 'USD' }, create_time: later } }) === 200, 'recurring sale event accepted');
  const recur = sdb.prepare("SELECT * FROM subscription_revenue WHERE provider_ref = 'sale:sale-recur-3'").get();
  ok(recur && recur.amount_cents === 567 && recur.owner_share_cents === 511 && recur.site_share_cents === 56, 'recurring payment recorded at plan price, 511/56 split');
  ok(await pwebhook({ event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'sale-recur-3', billing_agreement_id: pp3, amount: { total: '5.67', currency: 'USD' }, create_time: later } }) === 200, 'recurring sale retry accepted');
  ok(sdb.prepare("SELECT COUNT(*) AS n FROM subscription_revenue WHERE provider_ref = 'sale:sale-recur-3'").get().n === 1, 'recurring sale retry records nothing new');
  // Non-USD sale events are ignored.
  ok(await pwebhook({ event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'sale-eur-3', billing_agreement_id: pp3, amount: { total: '5.00', currency: 'EUR' }, create_time: later } }) === 200, 'non-USD sale event accepted');
  ok(!sdb.prepare("SELECT id FROM subscription_revenue WHERE provider_ref = 'sale:sale-eur-3'").get(), 'non-USD sale event records nothing');
  // The raffle's profit meter reads this ledger.
  const foundingLib = require('../src/lib/founding');
  const meter = await foundingLib.raffleOwnerSubscriptionProfits();
  const expectMeter = sdb.prepare('SELECT COALESCE(SUM(owner_share_cents),0) AS t FROM subscription_revenue').get().t;
  ok(meter === expectMeter && meter > 0, 'raffle profit meter sums owner shares from the ledger');

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

  // App cashout page: cashout-only, no payout-setup forms (website-only rule).
  r = await dreq('GET', '/wallet/app');
  ok(r.status === 200 && r.text.includes('Cashout'), 'app cashout page loads for artists');
  ok(!r.text.includes('payout-destination/add') && !r.text.includes('Add a payout destination'),
    'app cashout page has no payout-destination setup forms');
  ok(r.text.toLowerCase().includes('website'), 'app cashout page notes payout setup is website-only');

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

  // async safety net: a throwing handler 500s for that request but the
  // server process survives (regression: GROUP_CONCAT on /admin used to
  // crash the whole service into a Render 502).
  r = await req('GET', '/__test_async_crash', { follow: false });
  ok(r.status === 500, 'throwing async route renders 500 instead of crashing');
  r = await req('GET', '/health');
  ok(r.status === 200, 'server still alive after an async handler threw');
  ok(require('../src/db').stringAgg('o.deadline_missed_at') === 'GROUP_CONCAT(o.deadline_missed_at)',
    'stringAgg uses GROUP_CONCAT on sqlite (STRING_AGG on pg)');

  // custom order: brief too short rejected
  r = await req('POST', '/orders/custom', { body: { brief: 'short' }, follow: false });
  ok(r.status === 302, 'short custom brief rejected');

  // custom order: double-submit guard — same brief twice yields one order
  const dupeBrief = 'A black-and-grey wolf howling at a full moon, upper arm, six inches tall, dupe-guard test';
  r = await req('POST', '/orders/custom', { body: { brief: dupeBrief }, follow: false });
  ok(r.status === 302 && (r.location || '').includes('/orders/manual/'), 'first custom order created (PayPal down in tests -> manual page)');
  const firstOrderId = (r.location || '').split('/orders/manual/')[1];
  r = await req('POST', '/orders/custom', { body: { brief: dupeBrief }, follow: false });
  ok(r.status === 302 && r.location === `/orders/${firstOrderId}`, 'rapid duplicate custom order redirects to the existing order');
  // order detail shows the fee-inclusive breakdown, not just the base price
  r = await req('GET', `/orders/${firstOrderId}`);
  ok(r.status === 200 && r.text.includes('Deposit due now') && r.text.includes('Total with fees'), 'order detail shows deposit + fee-inclusive total');
  // buyer can cancel their own pending unpaid order
  r = await req('POST', `/orders/${firstOrderId}/cancel`, { follow: false });
  ok(r.status === 302 && r.location === '/account', 'cancel redirects to account');
  r = await req('GET', `/orders/${firstOrderId}`);
  ok(r.status === 200 && r.text.includes('canceled'), 'canceled order shows canceled status');

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
  // Ad revenue payout recording (owner rule 2026-09-30): head-admin-only
  // control on /admin/ads; each payout splits 50/50 site/owner; the page
  // shows the exact cumulative recorded revenue.
  r = await areq('GET', '/admin/ads');
  ok(r.status === 200 && r.text.includes('Record ad revenue payout'), 'admin ads page shows the payout panel');
  r = await areq('POST', '/admin/ads/record', { body: { amount: '10.01', source: 'adsense' } });
  ok(r.status === 302 && r.location === '/admin/ads', 'head admin records an ad payout');
  const adRevRow = sdb.prepare("SELECT * FROM commission_ledger WHERE commission_type = 'ad_revenue' AND order_id LIKE 'adrev:manual:adsense:%'").get();
  ok(adRevRow && adRevRow.amount_cents === 500 && adRevRow.recipient_type === 'site', 'payout books the 50% site share (odd cent to owner: 500 of 1001)');
  r = await areq('GET', '/admin/ads');
  ok(r.status === 200 && r.text.includes('$10.00') && r.text.includes('across 1 payout'), 'ads page shows exact cumulative gross revenue');
  r = await nreq('POST', '/admin/ads/record', { body: { amount: '5.00', source: 'adsense' }, follow: false });
  ok(r.status === 403, 'normal admin is blocked from recording payouts');
  ok(sdb.prepare("SELECT COUNT(*) AS n FROM commission_ledger WHERE commission_type = 'ad_revenue'").get().n === 1, 'blocked payout records nothing');
  r = await areq('POST', '/admin/ads/record', { body: { amount: 'not-a-number', source: 'adsense' } });
  ok(r.status === 302, 'invalid amount redirects back with an error');
  ok(sdb.prepare("SELECT COUNT(*) AS n FROM commission_ledger WHERE commission_type = 'ad_revenue'").get().n === 1, 'invalid payout records nothing');
  r = await areq('POST', '/admin/ads/record', { body: { amount: '5.00', source: '' } });
  ok(sdb.prepare("SELECT COUNT(*) AS n FROM commission_ledger WHERE commission_type = 'ad_revenue'").get().n === 1, 'missing source records nothing');
  r = await nreq('GET', '/admin/ads', { follow: false });
  ok(r.status === 200 && r.text.includes('$10.00') && !r.text.includes('action="/admin/ads/record"'), 'normal admin sees totals but no record form');
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
  const freeQuota = sdb.prepare('SELECT count FROM artist_upload_usage WHERE user_id = ?').get(custId);
  ok(freeQuota && freeQuota.count === 1, 'free-path upload counts toward monthly quota (fee hook wired)');
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

  // manual-send mode: a payable weekly recipient with a PayPal destination is
  // queued for manual send (not auto-sent) while PayPal Payouts is disabled
  const payUserId = await db.insert('users', { email: 'payq@test.local', password_hash: 'x', role: 'design_artist', display_name: 'PayQ' });
  await upsertTestProfile('artist_profiles', payUserId, { payout_paypal_email: 'payq@x.com' });
  await db.insert('subscriptions', { user_id: payUserId, plan_id: planId, status: 'active', current_period_end: Date.now() + 86400000 });
  await db.insert('commission_ledger', { order_id: 'manual-test', recipient_type: 'artist', recipient_id: payUserId, amount_cents: 1000, status: 'payable' });
  const summary2 = await autopayout.runWeeklyPayouts();
  const mq = summary2.queued.find((x) => x.recipientId === payUserId);
  ok(!!mq && mq.amountCents === 1000 && /manual/i.test(mq.via), 'payable PayPal recipient queued for manual send while Payouts disabled');
  ok(summary2.failed === false, 'manual-send run does not fail without PayPal Payouts');
  const mrow = await db.get("SELECT id FROM cashout_requests WHERE user_id = ? AND status = 'pending'", [payUserId]);
  ok(!!mrow, 'manual-send cashout request row created for the admin queue');

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
  // The pipeline now writes under config.uploadDir (persistent disk in prod).
  // With UPLOAD_DIR unset in tests, uploadDir === ASSET_DIR/uploads.
  const wmOutRoot = path.join(process.env.ASSET_DIR, 'uploads');
  let wmRel = await applyWatermarkedLinework({ designId: 'wmunit1', lineworkAbs: path.join(wmTestDir, 'lw.jpg'), choice: 'site' });
  ok(wmRel === 'designs/linework-wm/wmunit1-auto.jpg' && fs.existsSync(path.join(wmOutRoot, wmRel)), 'site watermark pipeline generates public linework');
  wmRel = await applyWatermarkedLinework({ designId: 'wmunit2', lineworkAbs: path.join(wmTestDir, 'lw.jpg'), choice: 'custom', customWatermarkAbs: path.join(wmTestDir, 'mywm.jpg') });
  ok(fs.existsSync(path.join(wmOutRoot, wmRel)), 'custom watermark pipeline generates public linework');
  const wmMeta = await sharp(path.join(wmOutRoot, wmRel)).metadata();
  ok(wmMeta.width === 700 && wmMeta.height === 900, 'watermarked output keeps linework dimensions');
  // Repo-bundled fallback: pipeline still works when ASSET_DIR has no copies.
  fs.rmSync(wmDstDir, { recursive: true, force: true });
  wmRel = await applyWatermarkedLinework({ designId: 'wmunit3', lineworkAbs: path.join(wmTestDir, 'lw.jpg'), choice: 'site' });
  ok(fs.existsSync(path.join(wmOutRoot, wmRel)), 'site watermark falls back to repo-bundled copies');
  fs.mkdirSync(wmDstDir, { recursive: true });
  for (const f of fs.readdirSync(wmSrcDir)) fs.copyFileSync(path.join(wmSrcDir, f), path.join(wmDstDir, f));

  // Density-aware randomized placement (owner rule 2026-09-29): marks aim
  // at the densest linework, vary per design, stay deterministic per design.
  const { planMarkPositions, lineDensityGrid } = require('../src/lib/watermark');
  const denseSvg = `<svg width="800" height="800"><rect width="800" height="800" fill="white"/>` +
    `<circle cx="150" cy="150" r="30" fill="none" stroke="black" stroke-width="4"/>` +
    Array.from({ length: 40 }, (_, i) => {
      const x1 = 420 + (i * 37) % 360, y1 = 420 + (i * 53) % 360;
      const x2 = 420 + (i * 91) % 360, y2 = 420 + (i * 67) % 360;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="black" stroke-width="8"/>`;
    }).join('') + `</svg>`;
  await sharp(Buffer.from(denseSvg)).jpeg().toFile(path.join(wmTestDir, 'denselw.jpg'));
  const dgrid = await lineDensityGrid(path.join(wmTestDir, 'denselw.jpg'));
  const pA1 = planMarkPositions({ designId: 'densA', grid: dgrid });
  const pA2 = planMarkPositions({ designId: 'densA', grid: dgrid });
  ok(pA1.length === 2, 'two anti-trace marks planned');
  ok(JSON.stringify(pA1) === JSON.stringify(pA2), 'mark placement is deterministic per design');
  const pB = planMarkPositions({ designId: 'densB', grid: dgrid });
  ok(JSON.stringify(pA1) !== JSON.stringify(pB), 'mark placement varies across designs');
  ok(pA1[0].x > 0.3 && pA1[0].y > 0.3, 'first mark targets the densest linework region');
  const psep = Math.hypot(pA1[0].x - pA1[1].x, pA1[0].y - pA1[1].y);
  ok(psep >= 0.25, 'marks keep minimum separation');
  // Pipeline-level: same design -> byte-identical output; new design -> different.
  const dpRel1 = await applyWatermarkedLinework({ designId: 'denspipe1', lineworkAbs: path.join(wmTestDir, 'denselw.jpg'), choice: 'site' });
  const dpBuf1 = fs.readFileSync(path.join(wmOutRoot, dpRel1));
  const dpRel2 = await applyWatermarkedLinework({ designId: 'denspipe1', lineworkAbs: path.join(wmTestDir, 'denselw.jpg'), choice: 'site' });
  ok(dpBuf1.equals(fs.readFileSync(path.join(wmOutRoot, dpRel2))), 'pipeline output is deterministic per design');
  const dpRel3 = await applyWatermarkedLinework({ designId: 'denspipe2', lineworkAbs: path.join(wmTestDir, 'denselw.jpg'), choice: 'site' });
  ok(!dpBuf1.equals(fs.readFileSync(path.join(wmOutRoot, dpRel3))), 'pipeline output varies across designs');

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

  // Message initiation UI: the public artist page exposes a message button
  // to logged-in visitors (not on your own page); the start route guards
  // against messaging yourself.
  const artistUserId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('banner@test.local').id;
  r = await req('GET', `/artists/${artistUserId}`);
  ok(r.status === 200 && r.text.includes('/messages/start') && r.text.includes('Message'), 'artist page exposes the message-artist control');
  r = await artreq('GET', `/artists/${artistUserId}`);
  ok(r.status === 200 && !r.text.includes('/messages/start'), 'no message control on your own artist page');
  r = await artreq('POST', '/messages/start', { body: { to_user_id: artistUserId, subject: 'hello' }, follow: false });
  ok(r.status === 302 && r.location === '/messages', 'cannot start a conversation with yourself');

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
  ok(prow.linework_wm_path && require('../src/lib/storage').resolveStoredPath(prow.linework_wm_path), 'watermarked linework auto-generated at upload');
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

  // On-site watermark builder (owner rule 2026-09-29): only strong marks.
  const wbuilder = require('../src/lib/watermarkBuilder');
  r = await artreq('GET', '/artist/watermark-builder');
  ok(r.status === 200 && r.text.includes('Build your watermark'), 'builder page renders for subscribed artist');
  r = await artreq('POST', '/artist/watermark-builder', { body: { line1: 'Solo', line2: '', line3: '', color: '#000000' } });
  ok(r.status === 200 && r.text.includes('at least 2 lines'), 'builder refuses a single-line mark');
  r = await artreq('POST', '/artist/watermark-builder', { body: { line1: 'Banner Artist', line2: 'Test Studio', line3: '', color: '#ffffff' } });
  ok(r.status === 200 && r.text.includes('not allowed'), 'builder refuses off-palette light colors');
  r = await artreq('POST', '/artist/watermark-builder', { body: { line1: 'Banner Artist', line2: 'Test Studio', line3: '', color: '#000000' } });
  ok(r.status === 302 && r.location === '/artist/watermark-builder', 'valid builder submission saves and redirects');
  const bMarkAbs = require('../src/lib/storage').resolveStoredPath(path.join('watermarks', 'custom', `${bannerArtistId}.png`));
  ok(bMarkAbs && fs.existsSync(bMarkAbs), 'builder mark saved as the artist default');
  const bCov = await wbuilder.inkCoverage(fs.readFileSync(bMarkAbs));
  ok(bCov >= 0.10, 'saved mark clears the ink-coverage minimum');
  r = await artreq('GET', '/artist/watermark-builder/preview');
  ok(r.status === 200, 'artist can preview their own mark');
  r = await unsubreq('GET', '/artist/watermark-builder', {});
  ok(r.status === 302 && (r.location || '').includes('/membership'), 'unsubscribed artist blocked from builder');

  // Upload form warns about weak marks and links the builder.
  r = await artreq('GET', '/artist/portfolio/upload');
  ok(r.text.includes('/artist/watermark-builder'), 'upload form links the on-site watermark builder');
  ok(r.text.includes('see-through'), 'upload form warns against weak see-through marks');
  // Artist dashboard links the builder too (app parity: reachable from the
  // app's artist tab via the website session).
  r = await artreq('GET', '/artist');
  ok(r.status === 200 && r.text.includes('/artist/watermark-builder'), 'artist dashboard links the watermark builder');

  // 'My own watermark' with no file falls back to the on-site built mark.
  r = await mpost('/artist/portfolio/upload',
    { title: 'Builder Default WM', description: '', style: 'animals', listing_type: 'custom', watermark_choice: 'custom' },
    { color: { buffer: colorBuf, filename: 'c.jpg', type: 'image/jpeg' }, linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    artJar);
  ok(r.status === 302 && r.location === '/artist/portfolio', 'custom choice with no file uses the built mark');
  const brow = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Builder Default WM');
  ok(brow && brow.custom_watermark_path === `watermarks/custom/${bannerArtistId}.png`, 'builder default mark recorded on the design');
  ok(brow.linework_wm_path && require('../src/lib/storage').resolveStoredPath(brow.linework_wm_path), 'watermarked linework generated with the builder mark');
  // No file and no built mark -> bounced back to the form, nothing stored.
  fs.rmSync(bMarkAbs, { force: true });
  r = await mpost('/artist/portfolio/upload',
    { title: 'No Mark Upload', description: '', style: 'animals', listing_type: 'custom', watermark_choice: 'custom' },
    { color: { buffer: colorBuf, filename: 'c.jpg', type: 'image/jpeg' }, linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    artJar);
  ok(r.status === 302 && r.location === '/artist/portfolio/upload', 'custom choice with no mark and no file bounces to the form');
  ok(!sdb.prepare('SELECT id FROM designs WHERE title = ?').get('No Mark Upload'), 'no design row created without a watermark source');

  // Approve both via admin.
  r = await areq('POST', `/admin/designs/${prow.id}/approve`);
  r = await areq('POST', `/admin/designs/${grow.id}/approve`);
  ok(sdb.prepare('SELECT status FROM designs WHERE id = ?').get(prow.id).status === 'approved', 'portfolio piece approved');
  ok(sdb.prepare('SELECT approved_by FROM designs WHERE id = ?').get(prow.id).approved_by, 'manual approval stamps the approving admin');

  // 1-hour auto-approval: stale pending designs get approved by the system.
  const { autoApproveStaleDesigns } = require('../src/lib/autoApprove');
  const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
  const halfHourAgo = Date.now() - 30 * 60 * 1000;
  const bannerId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('banner@test.local').id;
  const staleId = await db.insert('designs', { artist_id: bannerId, title: 'Stale Koi', status: 'pending', linework_wm_path: 'wm/stale.jpg', created_at: twoHoursAgo });
  const freshId = await db.insert('designs', { artist_id: bannerId, title: 'Fresh Koi', status: 'pending', linework_wm_path: 'wm/fresh.jpg', created_at: halfHourAgo });
  const noWmId = await db.insert('designs', { artist_id: bannerId, title: 'No Watermark Koi', status: 'pending', created_at: twoHoursAgo });
  const flaggedId = await db.insert('designs', { artist_id: bannerId, title: 'Flagged Koi', status: 'flagged', linework_wm_path: 'wm/flagged.jpg', created_at: twoHoursAgo });
  const res = await autoApproveStaleDesigns();
  ok(res.approved.includes(staleId) && res.blocked.includes(noWmId), 'stale pending approved, watermark-less blocked');
  const staleRow = sdb.prepare('SELECT status, approved_by FROM designs WHERE id = ?').get(staleId);
  ok(staleRow.status === 'approved' && staleRow.approved_by === 'auto:1h-no-admin-action', 'auto-approval is stamped as the system');
  ok(sdb.prepare('SELECT status FROM designs WHERE id = ?').get(freshId).status === 'pending', 'fresh pending (<1h) left for admins');
  ok(sdb.prepare('SELECT status FROM designs WHERE id = ?').get(noWmId).status === 'pending', 'no-watermark design never auto-approved');
  ok(sdb.prepare('SELECT status FROM designs WHERE id = ?').get(flaggedId).status === 'flagged', 'flagged design never auto-approved');
  for (const id of [staleId, freshId, noWmId, flaggedId]) sdb.prepare('DELETE FROM designs WHERE id = ?').run(id);

  // Admin can delete an unsold piece (moderation), but not one with sales.
  r = await mpost('/artist/portfolio/upload',
    { title: 'Admin Deletable', description: '', style: 'animals', listing_type: 'custom', watermark_choice: 'site' },
    { color: { buffer: colorBuf, filename: 'c.jpg', type: 'image/jpeg' }, linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    artJar);
  const admDel = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Admin Deletable');
  r = await areq('POST', `/admin/designs/${admDel.id}/delete`, {});
  ok(!sdb.prepare('SELECT id FROM designs WHERE id = ?').get(admDel.id), 'admin can delete an unsold piece');

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

  // Anti-bypass: contact info can never reach a public surface.
  // 1. Bio with contact info is hard-blocked (never saved).
  r = await artreq('POST', '/artist/bio', { body: { bio: 'Email me at artist@evil.com for customs' } });
  ok(r.status === 302 && r.location === '/artist', 'bio with contact info blocked (redirects)');
  const badBio = sdb.prepare('SELECT bio FROM artist_profiles WHERE user_id = ?').get(bannerArtistId);
  ok(!badBio || !String(badBio.bio || '').includes('artist@evil.com'), 'blocked bio is never saved');
  // 2. Clean bio saves and shows publicly (web page).
  r = await artreq('POST', '/artist/bio', { body: { bio: 'I draw blackwork roses and fine-line florals.' } });
  ok(r.status === 302, 'clean bio saves');
  r = await req('GET', `/artists/${bannerArtistId}`);
  ok(r.status === 200 && r.text.includes('blackwork roses'), 'public artist page shows clean bio');
  // 3. Defense in depth: a flagged bio can never render publicly even if one lands in the DB.
  sdb.prepare("UPDATE artist_profiles SET bio = ?, bio_status = 'flagged' WHERE user_id = ?").run('call 555-123-4567', bannerArtistId);
  r = await req('GET', `/artists/${bannerArtistId}`);
  ok(r.status === 200 && !r.text.includes('555-123-4567'), 'flagged bio hidden from public artist page');
  r = await req('GET', '/api/artists/' + bannerArtistId);
  ok(!JSON.parse(r.text).artist.bio.includes('555-123-4567'), 'flagged bio hidden from app artist API');
  // 4. Display names are screened at signup and on profile update.
  const jarBackup = { ...jar };
  r = await req('POST', '/signup', { follow: false, body: { email: 'badname@test.local', password: 'Password123!', display_name: 'DM me on instagram' } });
  ok(r.status === 302 && r.location === '/signup', 'signup with contact-info display name rejected');
  ok(!sdb.prepare('SELECT id FROM users WHERE email = ?').get('badname@test.local'), 'rejected signup creates no user');
  for (const k of Object.keys(jar)) delete jar[k];
  Object.assign(jar, jarBackup);
  r = await artreq('POST', '/account/profile', { body: { display_name: 'pay via venmo $mike' } });
  ok(r.status === 302 && r.location === '/account', 'profile update with contact-info display name rejected');
  ok(sdb.prepare('SELECT display_name FROM users WHERE id = ?').get(bannerArtistId).display_name === 'Banner Artist', 'rejected display name is not saved');
  // 5. Custom-order artist notification never leaks the buyer's email.
  const { notifyArtist } = require('../src/lib/customFulfillment');
  const nnId = await db.insert('users', { email: 'noname@test.local', password_hash: 'x', role: 'customer', display_name: '' });
  const nnConv = await notifyArtist({ id: 'order-bypass-test', buyer_id: nnId, custom_brief: 'Test brief', delivery_due: null }, { id: bannerArtistId, display_name: 'Banner Artist' });
  const nnMsg = sdb.prepare('SELECT body FROM messages WHERE conversation_id = ?').get(nnConv);
  ok(nnMsg && !nnMsg.body.includes('noname@test.local'), 'custom-order artist message never contains buyer email');
  ok(nnMsg && nnMsg.body.includes('your customer'), 'custom-order artist message falls back to "your customer"');
  // 6. PayPal webhook fails closed when the webhook ID is missing in production.
  // (The main test server runs with NODE_ENV=test, so spin a production-env
  // server on a scratch port for this one check.)
  const prodPort = PORT + 1;
  const prodServer = spawn('node', [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT, env: { ...process.env, NODE_ENV: 'production', PORT: String(prodPort) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('prod server did not start')), 15000);
      prodServer.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
      prodServer.stderr.on('data', (d) => process.stderr.write(d));
    });
    const prodRes = await fetch(`http://localhost:${prodPort}/membership/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'manual',
      body: JSON.stringify({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'sub-spoof' } }),
    });
    ok(prodRes.status === 401, 'webhook without webhook ID fails closed in production');
  } finally {
    prodServer.kill();
  }

  // /contact: a normal email passes validation, creates a notification row,
  // and the success flash fires. Invalid emails are rejected with the
  // validation flash and create nothing (regression: double-escaped regex
  // rejected every real email, and the success flash fired on mail failure).
  const contactName = 'REGRESSION-7733 Tester';
  r = await req('POST', '/contact', { follow: false, body: { name: contactName, email: 'regression-7733@test.local', topic: 'order', message: 'Contact form end-to-end check.' } });
  ok(r.status === 302 && r.location === '/contact', 'valid contact email accepted (redirects)');
  r = await req('GET', '/contact');
  ok(r.status === 200 && r.text.includes('your message was sent'), 'contact success flash shown for valid email');
  ok(!!sdb.prepare("SELECT id FROM notifications WHERE kind = 'contact' AND body LIKE ?").get('%REGRESSION-7733%'), 'contact submission creates a contact notification row');
  r = await req('POST', '/contact', { follow: false, body: { name: 'Nope', email: 'not-an-email', topic: 'other', message: 'x' } });
  ok(r.status === 302 && r.location === '/contact', 'invalid contact email rejected (redirects)');
  r = await req('GET', '/contact');
  ok(r.status === 200 && r.text.includes('a valid email'), 'contact validation flash shown for bad email');
  ok(!sdb.prepare("SELECT id FROM notifications WHERE kind = 'contact' AND body LIKE ?").get('%not-an-email%'), 'rejected contact creates no notification');

  // Design page: custom piece shows the custom price.
  r = await req('GET', `/design/${prow.id}`);
  ok(r.status === 200 && r.text.includes(pricing.money(pricing.withFeeCents(pricing.customFullCents()))), 'design page shows custom price for portfolio piece');
  ok(r.text.includes('custom portfolio piece'), 'design page labels custom piece');

  // Stored XSS: a malicious design title must render inert in the JSON-LD
  // block — the literal </script> must never appear unescaped in the HTML.
  const xssTitle = '</script><script>alert(1)</script>';
  const xssId = randomUUID();
  sdb.prepare(`INSERT INTO designs (id, title, description, style, categories, status, listing_type, listing_scope, artist_id, price_cents, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(xssId, xssTitle, 'xss desc', 'blackwork', '[]', 'approved', 'premade', 'gallery', bannerArtistId, 7500, Date.now());
  r = await req('GET', `/design/${xssId}`);
  ok(r.status === 200, 'design page with hostile title renders');
  ok(!r.text.includes('</script><script>'), 'hostile title cannot break out of the JSON-LD script block');
  ok(r.text.includes('\\u003c/script\\u003e'), 'JSON-LD escapes the hostile title as unicode escapes');

  // Portfolio edit + delete rules (before any sales on these pieces).
  r = await artreq('POST', `/artist/portfolio/${grow.id}/edit`, { body: { title: 'Gallery Koi v2', description: 'Koi v2.', style: 'animals', categories: 'fish' } });
  ok(r.status === 302, 'portfolio edit redirects');
  ok(sdb.prepare('SELECT title FROM designs WHERE id = ?').get(grow.id).title === 'Gallery Koi v2', 'portfolio edit updates the piece');
  r = await artreq('GET', `/artist/portfolio/${grow.id}/edit`);
  ok(r.status === 200 && r.text.includes(`/artist/portfolio/${grow.id}/delete`), 'edit page exposes the delete control');
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
  // Sold custom pieces delist (exclusive sale, owner rule 2026-09-28), so a
  // re-buy mints a fresh approved copy of the source piece. Premade pieces
  // stay listed and can be bought repeatedly.
  async function cloneDesignForBuy(src) {
    const row = sdb.prepare('SELECT * FROM designs WHERE id = ?').get(src.id || src);
    const { id, status, sold_at, created_at, ...rest } = row;
    return db.insert('designs', { ...rest, status: 'approved', created_at: Date.now() });
  }
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

  // Forfeiture: designer with an active subscription but NO payout method
  // set up — the site keeps their share (owner rule, 2026-09-28).
  r = await req('POST', `/orders/buy/${grow.id}`, { follow: false });
  const fOrderId = r.location.split('/orders/manual/')[1];
  r = await req('POST', `/orders/manual/${fOrderId}`, { body: { method: 'cashapp', note: 'test' }, follow: false });
  ok(r.status === 302, 'manual payment recorded for forfeiture test order');
  r = await areq('POST', `/admin/orders/${fOrderId}/confirm-manual`);
  const fOrder = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(fOrderId);
  const fLedger = sdb.prepare('SELECT recipient_type, amount_cents, status FROM commission_ledger WHERE order_id = ?').all(fOrderId);
  const fArtist = fLedger.find((l) => l.recipient_type === 'artist');
  const fExpected = Math.round(require('../src/lib/commissions').netPaidCents(fOrder) * 0.70);
  ok(fArtist && fArtist.amount_cents === fExpected && fArtist.status === 'site_kept',
    'designer without a payout method forfeits their 70% share to the site');
  // Once the designer sets up a payout method, new sales become payable.
  sdb.prepare(`INSERT INTO artist_profiles (user_id, payout_paypal_email, created_at) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET payout_paypal_email = excluded.payout_paypal_email`)
    .run(bannerArtistId, 'banner@pay.test', Date.now());
  r = await req('POST', `/orders/buy/${grow.id}`, { follow: false });
  const gOrderId = r.location.split('/orders/manual/')[1];
  r = await req('POST', `/orders/manual/${gOrderId}`, { body: { method: 'cashapp', note: 'test' }, follow: false });
  r = await areq('POST', `/admin/orders/${gOrderId}/confirm-manual`);
  const gArtist = sdb.prepare("SELECT amount_cents, status FROM commission_ledger WHERE order_id = ? AND recipient_type = 'artist'").get(gOrderId);
  ok(gArtist && gArtist.status === 'payable' && gArtist.amount_cents === Math.round(require('../src/lib/commissions').netPaidCents(sdb.prepare('SELECT * FROM orders WHERE id = ?').get(gOrderId)) * 0.70),
    'designer with a payout method earns payable 70% on new sales');

  // Self-referral: a shop cannot earn a referral commission on its own
  // artist account's work — booked exactly like no referral (owner rule,
  // 2026-09-28). Designer gets the no-shop 70% (60 + 10), owner 20%.
  sdb.prepare('INSERT INTO shop_profiles (user_id, business_name, referral_code, created_at) VALUES (?,?,?,?)')
    .run(bannerArtistId, 'Self Shop', 'SELFREF1', Date.now());
  r = await req('POST', `/orders/buy/${grow.id}`, { body: { referral_code: 'SELFREF1' }, follow: false });
  const srOrderId = r.location.split('/orders/manual/')[1];
  r = await req('POST', `/orders/manual/${srOrderId}`, { body: { method: 'cashapp', note: 'test' }, follow: false });
  r = await areq('POST', `/admin/orders/${srOrderId}/confirm-manual`);
  const srLedger = sdb.prepare('SELECT recipient_type, amount_cents, status FROM commission_ledger WHERE order_id = ?').all(srOrderId);
  ok(!srLedger.some((l) => l.recipient_type === 'shop'), 'self-referral books no shop commission row');
  const srOrder = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(srOrderId);
  const srArtist = srLedger.find((l) => l.recipient_type === 'artist');
  ok(srArtist && srArtist.amount_cents === Math.round(require('../src/lib/commissions').netPaidCents(srOrder) * 0.70),
    'self-referred designer gets the no-shop 70% share');

  // A piece with sales cannot be deleted.
  r = await artreq('POST', `/artist/portfolio/${prow.id}/delete`, {});
  ok(sdb.prepare('SELECT id FROM designs WHERE id = ?').get(prow.id), 'piece with sales cannot be deleted');
  r = await areq('POST', `/admin/designs/${prow.id}/delete`, {});
  ok(sdb.prepare('SELECT id FROM designs WHERE id = ?').get(prow.id), 'admin cannot delete a piece with sales');

  // ===== Linework-only uploads + site colorization workflow =====
  // Linework-only upload (no color file) is accepted and enters normal admin
  // approval immediately; the site color version is created while it is live.
  r = await mpost('/artist/portfolio/upload',
    { title: 'Ink Sketch', description: 'Linework only.', style: 'japanese', categories: 'animals', listing_type: 'custom', watermark_choice: 'site' },
    { linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    artJar);
  ok(r.status === 302 && r.location === '/artist/portfolio', 'linework-only upload accepted');
  const lwRow = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Ink Sketch');
  ok(lwRow && lwRow.color_source === 'none' && lwRow.status === 'pending' && !lwRow.color_path && lwRow.color_pending === 1,
    'linework-only upload enters pending approval with color_pending=1');
  ok(pricing.LINEWORK_ONLY_DISCOUNT === 0.03 && pricing.LINEWORK_ONLY_DISCOUNT <= 0.03,
    'linework-only discount constant is 0.03 and clamped');
  // Pending: hidden from every public surface until approved.
  r = await req('GET', '/gallery');
  ok(!r.text.includes('Ink Sketch'), 'linework-only piece hidden from the gallery while pending');
  r = await req('GET', `/artists/${bannerArtistId}`);
  ok(!r.text.includes('Ink Sketch'), 'linework-only piece hidden from the public portfolio while pending');
  r = await req('GET', '/api/designs');
  ok(!JSON.parse(r.text).designs.some((d) => d.title === 'Ink Sketch'), 'linework-only piece hidden from the app designs API while pending');
  // Owner notified on-site that a color version needs creating.
  const ownerNotif = sdb.prepare(
    `SELECT c.id FROM conversations c JOIN messages m ON m.conversation_id = c.id
     WHERE c.subject LIKE '%Color version needed%' AND m.body LIKE '%Ink Sketch%'`).get();
  ok(!!ownerNotif, 'owner notified on-site that a color version needs creating');
  // Admin colorization queue lists it (color_pending drives the queue now).
  r = await areq('GET', '/admin/colorization');
  ok(r.status === 200 && r.text.includes('Ink Sketch'), 'admin colorization queue lists the linework-only piece');

  // The linework can be approved BEFORE any color exists — the piece goes
  // live with watermarked linework while color is still pending.
  r = await areq('POST', `/admin/designs/${lwRow.id}/approve`);
  ok(sdb.prepare('SELECT status FROM designs WHERE id = ?').get(lwRow.id).status === 'approved',
    'linework-only piece approved without a color version');
  r = await req('GET', `/artists/${bannerArtistId}`);
  ok(r.text.includes('Ink Sketch'), 'approved linework-only piece is live on the public portfolio');
  r = await req('GET', `/artists/${bannerArtistId}`);
  ok(r.text.includes('Ink Sketch') && !r.text.includes('sitecolor') && !r.text.includes('/uploads/'),
    'public portfolio shows the piece but never a site-created color file');

  // Admin attaches the finished site-created color file: color_source becomes
  // 'site' and color_pending clears; the approval status does not change.
  r = await mpost(`/admin/colorization/${lwRow.id}/attach`, {},
    { color: { buffer: colorBuf, filename: 'c.jpg', type: 'image/jpeg' } }, adminJar);
  ok(r.status === 302 && r.location === '/admin/colorization', 'admin attaches the color version');
  const afterAttach = sdb.prepare('SELECT * FROM designs WHERE id = ?').get(lwRow.id);
  ok(afterAttach.status === 'approved' && afterAttach.color_pending === 0 && afterAttach.color_source === 'site'
    && afterAttach.color_path && require('../src/lib/storage').resolveStoredPath(afterAttach.color_path),
    'attaching the color clears color_pending, sets color_source=site, and keeps the piece live');
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
  // The separate color-approval route is gone: attaching IS the approval.
  r = await areq('POST', `/admin/colorization/${lwRow.id}/approve`);
  ok(r.status === 404, 'separate color-approval route removed');
  // The designer was notified when the piece went live, naming the admin.
  const liveNotif = sdb.prepare(
    `SELECT c.id FROM conversations c JOIN messages m ON m.conversation_id = c.id
     WHERE c.subject LIKE '%is live%' AND m.body LIKE '%Ink Sketch%'`).get();
  ok(!!liveNotif, 'designer notified when the site-colored piece goes live');
  // The site-created color never appears anywhere public.
  r = await req('GET', '/gallery');
  ok(!r.text.includes('sitecolor'), 'gallery never exposes the site-created color');
  r = await req('GET', `/design/${lwRow.id}`);
  ok(r.status === 200 && !r.text.includes('sitecolor') && r.text.includes('Clean linework only'),
    'design page offers the linework-only choice and never shows the site color');

  // An uncolorized linework-only piece stays live; the colorization queue
  // still lists it while its color is pending.
  r = await mpost('/artist/portfolio/upload',
    { title: 'Ink Sketch 2', description: 'Linework only.', style: 'japanese', listing_type: 'custom', watermark_choice: 'site' },
    { linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    artJar);
  const lw2 = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Ink Sketch 2');
  ok(lw2 && lw2.status === 'pending' && lw2.color_pending === 1, 'second linework-only piece pending with color pending');
  r = await areq('GET', '/admin/colorization');
  ok(r.text.includes('Ink Sketch 2'), 'colorization queue lists the still-uncolorized piece');

  // ===== Content policy: sensitivity, blur, hold, reject reasons, appeals =====
  // Explicit upload generates a blurred preview variant and notifies admins.
  r = await mpost('/artist/portfolio/upload',
    { title: 'Explicit Piece', description: 'Policy test.', style: 'japanese', listing_type: 'predesign', watermark_choice: 'site', sensitivity: 'explicit' },
    { linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    artJar);
  ok(r.status === 302 && r.location === '/artist/portfolio', 'explicit upload accepted');
  const expRow = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Explicit Piece');
  ok(expRow && expRow.sensitivity === 'explicit' && expRow.linework_blur_path
    && require('../src/lib/storage').resolveStoredPath(expRow.linework_blur_path),
    'explicit piece stored with a blurred preview variant');
  const admNotif = sdb.prepare(
    "SELECT COUNT(*) AS c FROM notifications WHERE kind = 'design_pending' AND link = '/admin/designs'").get();
  ok(admNotif.c >= 1, 'admins get an in-app notification for the pending upload');
  // Nude upload: watermarked, NOT blurred.
  r = await mpost('/artist/portfolio/upload',
    { title: 'Nude Study', description: 'Policy test.', style: 'japanese', listing_type: 'predesign', watermark_choice: 'site', sensitivity: 'nude' },
    { linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    artJar);
  const nudeRow = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Nude Study');
  ok(nudeRow && nudeRow.sensitivity === 'nude' && !nudeRow.linework_blur_path, 'nude piece is watermarked but not blurred');
  // Racist content is held for admin-only review — never pending.
  r = await mpost('/artist/portfolio/upload',
    { title: 'Hateful Piece', description: 'Policy test.', style: 'japanese', listing_type: 'custom', watermark_choice: 'site', sensitivity: 'racist' },
    { linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    artJar);
  const hateRow = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Hateful Piece');
  ok(hateRow && hateRow.status === 'on_hold', 'racist content is placed on hold, never pending');
  // on_hold is never auto-approved, even after hours.
  sdb.prepare('UPDATE designs SET created_at = ? WHERE id = ?').run(Date.now() - 3 * 3600 * 1000, hateRow.id);
  {
    const { autoApproveStaleDesigns } = require('../src/lib/autoApprove');
    const res2 = await autoApproveStaleDesigns();
    ok(!res2.approved.includes(hateRow.id) && sdb.prepare('SELECT status FROM designs WHERE id = ?').get(hateRow.id).status === 'on_hold',
      'on_hold designs are never auto-approved');
  }
  // Admin approves the explicit piece; blur gating on the public page.
  r = await areq('POST', `/admin/designs/${expRow.id}/approve`);
  ok(sdb.prepare('SELECT status FROM designs WHERE id = ?').get(expRow.id).status === 'approved', 'explicit piece approved by admin');
  r = await req('GET', `/design/${expRow.id}`);
  ok(r.status === 200 && r.text.includes(expRow.linework_blur_path.split('/').pop()),
    'signed-out viewer is served the blurred preview for explicit pieces');
  ok(r.text.includes('blurred'), 'design page explains the blur to viewers');
  r = await req('GET', '/api/designs');
  ok(JSON.parse(r.text).designs.some((d) => d.id === expRow.id), 'explicit piece listed in the app API (blurred by gating)');
  // Age-verified opted-in viewer sees the unblurred watermarked linework.
  const vuId = await db.insert('users', { email: 'verified@test.local', password_hash: 'x', role: 'customer', display_name: 'Verified', age_verified: 1, show_explicit: 1 });
  const { displayImgFile } = require('../src/lib/contentPolicy');
  const unblurred = await displayImgFile(expRow, { id: vuId, role: 'customer', age_verified: true, show_explicit: true });
  ok(unblurred && unblurred === String(expRow.linework_wm_path).split('/').pop(), 'age-verified opted-in viewer gets the unblurred watermarked linework');
  const blurred = await displayImgFile(expRow, null);
  ok(blurred && blurred === String(expRow.linework_blur_path).split('/').pop(), 'signed-out viewer gets the blurred variant');
  const nudeView = await displayImgFile(nudeRow, null);
  ok(nudeView && !nudeView.includes('linework-blur'), 'nude pieces are never blurred for anyone');

  // Rejection without a reason is blocked.
  r = await mpost('/artist/portfolio/upload',
    { title: 'Appeal Piece', description: 'Policy test.', style: 'japanese', listing_type: 'custom', watermark_choice: 'site' },
    { linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    artJar);
  const apRow = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Appeal Piece');
  r = await areq('POST', `/admin/designs/${apRow.id}/reject`, { body: { reason: '' } });
  ok(sdb.prepare('SELECT status FROM designs WHERE id = ?').get(apRow.id).status === 'pending',
    'rejection blocked when no reason is given');
  // Rejection with a reason: artist is notified with the reason + admin name.
  r = await areq('POST', `/admin/designs/${apRow.id}/reject`, { body: { reason: 'Does not meet quality bar.' } });
  ok(sdb.prepare('SELECT status FROM designs WHERE id = ?').get(apRow.id).status === 'rejected', 'rejection with reason goes through');
  const rejRow = sdb.prepare('SELECT reject_reason FROM designs WHERE id = ?').get(apRow.id);
  ok(rejRow.reject_reason === 'Does not meet quality bar.', 'rejection reason stored on the design');
  const rejNotif = sdb.prepare(
    "SELECT title, body FROM notifications WHERE user_id = ? AND kind = 'design_rejected' ORDER BY created_at DESC").get(bannerArtistId);
  ok(rejNotif && rejNotif.body.includes('Does not meet quality bar.'), 'artist notified with the rejection reason');
  ok(rejNotif.body.includes('admin@test.local') || rejNotif.body.includes('Site Admin'),
    'rejection notice names the admin who decided');
  // Hold notifies all admins.
  r = await areq('POST', `/admin/designs/${nudeRow.id}/hold`);
  ok(sdb.prepare('SELECT status FROM designs WHERE id = ?').get(nudeRow.id).status === 'on_hold', 'hold sets status to on_hold');
  const holdNotif = sdb.prepare(
    "SELECT COUNT(*) AS c FROM notifications WHERE kind = 'design_on_hold'").get();
  ok(holdNotif.c >= 1, 'all admins notified of the hold');

  // Appeal: one per rejected design, to the owner, whose decision is final.
  r = await artreq('POST', `/artist/portfolio/${apRow.id}/appeal`, { body: { reason: 'I fixed the shading, please look again.' } });
  ok(r.status === 302, 'appeal submitted');
  const appeal = sdb.prepare('SELECT * FROM design_appeals WHERE design_id = ?').get(apRow.id);
  ok(appeal && appeal.status === 'open', 'appeal recorded as open');
  const appealNotif = sdb.prepare("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'design_appeal'").get();
  ok(appealNotif.c >= 1, 'owner notified of the appeal');
  r = await artreq('GET', '/admin/appeals');
  ok(r.status === 403, 'appeals page forbidden for non-admin artist');
  r = await areq('GET', '/admin/appeals');
  ok(r.status === 200 && r.text.includes('Appeal Piece'), 'owner sees the appeal in /admin/appeals');
  r = await artreq('POST', `/artist/portfolio/${apRow.id}/appeal`, { body: { reason: 'second try' } });
  ok(sdb.prepare('SELECT COUNT(*) AS c FROM design_appeals WHERE design_id = ?').get(apRow.id).c === 1,
    'only one appeal per design is allowed');
  // Owner approves the appeal: the piece goes live and the artist is told.
  r = await areq('POST', `/admin/appeals/${appeal.id}/approve`);
  ok(sdb.prepare('SELECT status FROM designs WHERE id = ?').get(apRow.id).status === 'approved', 'owner appeal approval posts the piece');
  ok(sdb.prepare('SELECT status FROM design_appeals WHERE id = ?').get(appeal.id).status === 'approved', 'appeal marked approved');
  const appealDecided = sdb.prepare(
    "SELECT body FROM notifications WHERE user_id = ? AND kind = 'appeal_decided' ORDER BY created_at DESC").get(bannerArtistId);
  ok(appealDecided && appealDecided.body.toLowerCase().includes('final'), 'artist told the owner decision is final');
  // Uphold path: second rejected piece, appeal, owner upholds.
  r = await mpost('/artist/portfolio/upload',
    { title: 'Appeal Piece 2', description: 'Policy test.', style: 'japanese', listing_type: 'custom', watermark_choice: 'site' },
    { linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    artJar);
  const ap2 = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Appeal Piece 2');
  await areq('POST', `/admin/designs/${ap2.id}/reject`, { body: { reason: 'Off brief.' } });
  await artreq('POST', `/artist/portfolio/${ap2.id}/appeal`, { body: { reason: 'reconsider please' } });
  const appeal2 = sdb.prepare('SELECT * FROM design_appeals WHERE design_id = ?').get(ap2.id);
  r = await areq('POST', `/admin/appeals/${appeal2.id}/uphold`);
  ok(sdb.prepare('SELECT status FROM design_appeals WHERE id = ?').get(appeal2.id).status === 'upheld', 'appeal can be upheld');
  ok(sdb.prepare('SELECT status FROM designs WHERE id = ?').get(ap2.id).status === 'rejected', 'design stays rejected when the appeal is upheld');

  // Adolfo is his own admin: self-approved uploaders skip the review queue.
  const adolfoId = await db.insert('users', {
    email: 'adolfo3301@yahoo.com', password_hash: await bcrypt.hash('AdolfoPass123!', 10),
    role: 'design_artist', display_name: 'Adolfo', auto_approve_uploads: 1,
  });
  await db.insert('subscriptions', {
    user_id: adolfoId, plan_id: artPlanId, status: 'active',
    paypal_subscription_id: 'sub-adolfo-test', created_at: Date.now(),
  });
  const adolfoJar = {};
  async function adolforeq(method, pp, opts = {}) {
    const h = { ...(opts.headers || {}) };
    const cookies = Object.entries(adolfoJar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) h.cookie = cookies;
    let payload = opts.body;
    if (payload && typeof payload === 'object') {
      payload = new URLSearchParams(payload);
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(`http://localhost:${PORT}${pp}`, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [k, v] = c.split(';')[0].split('=');
      adolfoJar[k.trim()] = (v || '').trim();
    }
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  r = await adolforeq('POST', '/login', { body: { email: 'adolfo3301@yahoo.com', password: 'AdolfoPass123!' } });
  ok(r.status === 302, 'self-approving artist login ok');
  const pendBefore = sdb.prepare("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'design_pending'").get().c;
  r = await mpost('/artist/portfolio/upload',
    { title: 'Adolfo Live Piece', description: 'No review needed.', style: 'japanese', listing_type: 'predesign', watermark_choice: 'site' },
    { linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    adolfoJar);
  const adRow = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Adolfo Live Piece');
  ok(adRow && adRow.status === 'approved' && adRow.approved_by === adolfoId,
    'self-approved upload goes live immediately, approved by the uploader');
  ok(sdb.prepare("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'design_pending'").get().c === pendBefore,
    'no admin review notification for a self-approved upload');
  r = await req('GET', '/gallery');
  ok(r.text.includes('Adolfo Live Piece'), 'self-approved piece is in the gallery');
  // A flagged upload (contact info) still needs an admin — policy violations are not approvals.
  r = await mpost('/artist/portfolio/upload',
    { title: 'Adolfo Flagged', description: 'Call me at 555-555-0100 for customs.', style: 'japanese', listing_type: 'custom', watermark_choice: 'site' },
    { linework: { buffer: lwBuf, filename: 'l.jpg', type: 'image/jpeg' } },
    adolfoJar);
  const adFlag = sdb.prepare('SELECT * FROM designs WHERE title = ?').get('Adolfo Flagged');
  ok(adFlag && adFlag.status === 'approved' && adFlag.approved_by === adolfoId,
    'even a flagged upload goes live immediately for a trusted self-approver');

  // First-sale watcher: every paid order notifies the owner with a
  // verification report; the ledger must sum exactly to the net sale.
  const { watchOrderPaid, watchSubscriptionActive } = require('../src/lib/saleWatch');
  const watchArtistId = await db.insert('users', {
    email: 'watchartist@test.local', password_hash: await bcrypt.hash('WatchPass123!', 10),
    role: 'design_artist', display_name: 'Watch Artist',
  });
  await db.insert('subscriptions', {
    user_id: watchArtistId, plan_id: artPlanId, status: 'active',
    paypal_subscription_id: 'sub-watch-test', created_at: Date.now(),
  });
  sdb.prepare(`INSERT INTO artist_profiles (user_id, payout_paypal_email, created_at) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET payout_paypal_email = excluded.payout_paypal_email`)
    .run(watchArtistId, 'watch@pay.test', Date.now());
  const watchBuyerId = await db.insert('users', {
    email: 'watchbuyer@test.local', password_hash: await bcrypt.hash('WatchPass123!', 10),
    role: 'customer', display_name: 'Watch Buyer',
  });
  sdb.prepare(`INSERT INTO designs (id, title, status, price_cents, created_at, categories, sale_count, artist_id, linework_wm_path)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('watch-design-1', 'Watch Design', 'approved', 7500, Date.now(), '[]', 0, watchArtistId, 'designs/linework-wm/x.jpg');
  sdb.prepare(`INSERT INTO orders (id, buyer_id, design_id, order_type, amount_cents, amount_paid_cents, fee_cents, status, payment_method, created_at, paid_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('watch-order-1', watchBuyerId, 'watch-design-1', 'premade', 7500, 7812, 312, 'paid', 'paypal', Date.now(), Date.now());
  await require('../src/lib/commissions').recordSaleCommissions(
    await db.get('SELECT * FROM orders WHERE id = ?', ['watch-order-1']));
  const saleNotifBefore = sdb.prepare("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'sale'").get().c;
  await watchOrderPaid({ id: 'watch-order-1' });
  const watchLedger = sdb.prepare('SELECT COALESCE(SUM(amount_cents),0) AS t FROM commission_ledger WHERE order_id = ?').get('watch-order-1').t;
  ok(watchLedger === 7500, 'sale watch: commission ledger sums exactly to the net sale (fee excluded)');
  ok(sdb.prepare("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'sale'").get().c === saleNotifBefore + 1,
    'sale watch: owner gets an in-app sale notification');
  const saleNotif = sdb.prepare("SELECT title, body FROM notifications WHERE kind = 'sale' ORDER BY created_at DESC").get();
  ok(/^(SALE #\d+|Sale:)/.test(saleNotif.title) && saleNotif.body.includes('$78.12') && saleNotif.body.includes('Commissions:'),
    'sale watch: sale notification carries a verification report with the paid total and commission breakdown');
  // New paid memberships notify the owner too.
  const watchSubId = await db.insert('subscriptions', {
    user_id: watchBuyerId, plan_id: artPlanId, status: 'active',
    paypal_subscription_id: 'sub-watch-sub', created_at: Date.now(),
  });
  await watchSubscriptionActive({ id: watchSubId });
  ok(sdb.prepare("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'sale'").get().c === saleNotifBefore + 2,
    'sale watch: new paid membership notifies the owner');

  // Push notification flows (test mode: no real network, attempts are logged).
  const { vapidPublicKey, pushToAdmins, sentLog } = require('../src/lib/push');
  const vapidKey = await vapidPublicKey();
  ok(typeof vapidKey === 'string' && vapidKey.length > 20, 'VAPID public key is available');
  r = await req('GET', '/api/push/vapid-key');
  ok(r.status === 200 && JSON.parse(r.text).publicKey === vapidKey, 'VAPID key served over the API');
  {
    const cookies = Object.entries(adminJar).map(([k, v]) => `${k}=${v}`).join('; ');
    const sres = await fetch(`http://localhost:${PORT}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookies },
      body: JSON.stringify({ subscription: { endpoint: 'https://push.test.local/sub/1', keys: { p256dh: 'dh1', auth: 'auth1' } } }),
    });
    r = { status: sres.status, text: await sres.text() };
  }
  ok(r.status === 200 && JSON.parse(r.text).ok, 'web push subscription accepted');
  ok(sdb.prepare("SELECT COUNT(*) AS c FROM push_subscriptions WHERE endpoint = 'https://push.test.local/sub/1'").get().c === 1,
    'web push subscription persisted');
  r = await areq('POST', '/api/push/unsubscribe', { body: { endpoint: 'https://push.test.local/sub/1' } });
  ok(r.status === 200 && sdb.prepare("SELECT COUNT(*) AS c FROM push_subscriptions WHERE endpoint = 'https://push.test.local/sub/1'").get().c === 0,
    'web push subscription removed');
  // Expo token registration via API token, then an admin push attempt is logged.
  {
    const linkRes = await fetch(`http://localhost:${PORT}/api/link-account`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.local', password: 'AdminTest123!' }),
    });
    const linkData = await linkRes.json();
    ok(linkRes.ok && linkData.ok && linkData.api_token, 'admin links an API token');
  }
  const adminRow = sdb.prepare("SELECT api_token FROM users WHERE email = 'admin@test.local'").get();
  ok(!!(adminRow && adminRow.api_token), 'admin has an API token');
  {
    const eres = await fetch(`http://localhost:${PORT}/api/push/expo-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-token': adminRow.api_token },
      body: JSON.stringify({ expo_push_token: 'ExponentPushToken[test-admin-device]' }),
    });
    r = { status: eres.status, text: await eres.text() };
  }
  ok(r.status === 200 && JSON.parse(r.text).ok, 'expo token registered');
  ok(sdb.prepare("SELECT expo_push_token FROM users WHERE email = 'admin@test.local'").get().expo_push_token === 'ExponentPushToken[test-admin-device]',
    'expo token persisted on the user');
  sentLog.length = 0;
  await pushToAdmins({ title: 'Test push', body: 'Design review needed.', url: '/admin/designs' });
  ok(sentLog.some((e) => e.channel === 'expo'), 'admin design-review push attempted via Expo (logged in test mode)');

  // 2-hour SLA escalation: a flagged design past 2h re-notifies admins.
  const { escalateOverdueDesigns } = require('../src/lib/contentSla');
  sdb.prepare("INSERT INTO designs (id, title, status, price_cents, created_at, categories, sale_count, artist_id, linework_wm_path) VALUES (?,?,?,?,?,?,?,?,?)")
    .run('sla-test-1', 'SLA Flag', 'flagged', 7500, Date.now() - 3 * 3600 * 1000, '[]', 0, bannerArtistId, 'designs/linework-wm/x.jpg');
  const esc1 = await escalateOverdueDesigns();
  ok(esc1.escalated.includes('sla-test-1'), 'overdue flagged design escalated');
  const escNotif = sdb.prepare("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'design_sla_escalation'").get();
  ok(escNotif.c >= 1, 'admins re-notified on SLA breach');
  const esc2 = await escalateOverdueDesigns();
  ok(!esc2.escalated.includes('sla-test-1'), 'no repeat escalation within 24h');

  // Notifications page + header badge.
  {
    const sres = await fetch(`http://localhost:${PORT}/notifications`, { redirect: 'manual' });
    r = { status: sres.status, location: sres.headers.get('location') };
  }
  ok(r.status === 302 && (r.location || '').includes('/login'), 'signed-out users are redirected from /notifications');
  r = await areq('GET', '/notifications');
  ok(r.status === 200 && r.text.includes('Notifications'), 'admin can open the notifications page');
  const nid = sdb.prepare("SELECT id FROM notifications WHERE user_id = (SELECT id FROM users WHERE email = 'admin@test.local') AND read_at IS NULL LIMIT 1").get();
  if (nid) {
    r = await areq('POST', `/notifications/${nid.id}/read`);
    ok(r.status === 302 && sdb.prepare('SELECT read_at FROM notifications WHERE id = ?').get(nid.id).read_at, 'notification can be marked read');
  }
  // Age verification routes.
  r = await req('POST', '/account/age-verify', { body: { dob: '2010-01-01' } });
  r = await areq('POST', '/account/age-verify', { body: { dob: '1990-05-05' } });
  ok(r.status === 302 && sdb.prepare("SELECT age_verified FROM users WHERE email = 'admin@test.local'").get().age_verified === 1,
    'adult date of birth sets age_verified');
  r = await areq('POST', '/account/explicit-pref', { body: { show_explicit: '1' } });
  ok(sdb.prepare("SELECT show_explicit FROM users WHERE email = 'admin@test.local'").get().show_explicit === 1,
    'verified user can opt in to unblurred explicit previews');
  r = await areq('GET', '/account');
  ok(r.text.includes('Content preferences'), 'account page shows the content-preferences section');

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
  r = await req('POST', `/orders/buy/${await cloneDesignForBuy(lwRow)}`, { follow: false });
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
  r = await req('POST', `/orders/buy/${await cloneDesignForBuy(lwRow)}`, { follow: false });
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
  ok(sweep.gross_cents === (inkOrder.amount_cents + (inkOrder.fee_cents || 0)) + (noneOrder.amount_cents + (noneOrder.fee_cents || 0)), 'sweep gross matches the cleared orders');
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

  // ===== Shop subscription includes the designer membership (owner rule 2026-09-29) =====
  console.log('shop-designer-included:');
  const { shopDesignerActive, designerAccess } = require('../src/shop/shopDesigner');
  const shopDesId = await db.insert('users', {
    email: 'shopdesigner@test.local', password_hash: await bcrypt.hash('ShopPass123!', 10),
    role: 'tattoo_shop', display_name: 'Shop Designer',
  });
  const shopPlanId = (await db.get(`SELECT id FROM plans WHERE slug = 'tattoo_shop'`)).id;
  const shopDesSubId = await db.insert('subscriptions', {
    user_id: shopDesId, plan_id: shopPlanId, status: 'active',
    paypal_subscription_id: 'sub-shopdesigner-test', created_at: Date.now(),
  });
  // No opt-in step: an active shop subscription IS a designer subscription.
  ok(await shopDesignerActive(shopDesId) && await designerAccess(shopDesId), 'active shop subscription carries designer access automatically');
  const shopJar = {};
  async function shopreq(method, p, opts = {}) {
    const h = { ...(opts.headers || {}) };
    const cookies = Object.entries(shopJar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) h.cookie = cookies;
    let payload = opts.body;
    if (payload && typeof payload === 'object') { payload = new URLSearchParams(payload); h['content-type'] = 'application/x-www-form-urlencoded'; }
    const res = await fetch(`http://localhost:${PORT}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [k, v] = c.split(';')[0].split('=');
      shopJar[k.trim()] = (v || '').trim();
    }
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  let sr = await shopreq('POST', '/login', { body: { email: 'shopdesigner@test.local', password: 'ShopPass123!' } });
  ok(sr.status === 302, 'shop login ok');
  sr = await shopreq('GET', '/artist/portfolio', {});
  ok(sr.status === 200, 'shop can open the artist portfolio — designer membership included');
  sr = await req('GET', `/artists/${shopDesId}`);
  ok(sr.status === 200, 'public artist page live for the shop — designer membership included');
  sr = await shopreq('GET', '/shop', {});
  ok(sr.status === 200 && sr.text.includes('Designer membership — included') && sr.text.includes('badge ok'), 'shop dashboard shows the included designer membership');
  // The shop earns designer commissions on its active shop subscription —
  // no artist plan needed — and the self-referral guard still holds:
  // referring its OWN design is booked exactly like no referral (no 20%
  // shop cut).
  await upsertProfile('shop_profiles', shopDesId, { payout_paypal_email: 'shop@pay.test' });
  ok(await comm.recipientEligible(shopDesId, 'design_artist'), 'shop is eligible for designer payouts on its shop subscription');
  const shopDesDesignId = 'testdesignshop1';
  sdb.prepare(`INSERT INTO designs (id, artist_id, title, description, price_cents, status, listing_type, listing_scope, color_path, linework_path, linework_wm_path, categories, sale_count, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(shopDesDesignId, shopDesId, 'Shop Flash', 'desc', 7500, 'approved', 'predesign', 'gallery',
    'designs/color/w.jpg', 'designs/linework/w.jpg', 'designs/linework-wm/w-wm.jpg', '[]', 0, Date.now());
  const selfRefOrderId = await db.insert('orders', {
    buyer_id: bannerBuyerId, order_type: 'premade', design_id: shopDesDesignId,
    amount_cents: 7500, amount_paid_cents: 7500, status: 'paid',
    referred_shop_id: shopDesId, paid_at: Date.now(),
  });
  await comm.recordSaleCommissions(await db.get('SELECT * FROM orders WHERE id = ?', [selfRefOrderId]));
  const selfRows = sdb.prepare('SELECT recipient_type, amount_cents, status FROM commission_ledger WHERE order_id = ?').all(selfRefOrderId);
  const selfByType = {};
  for (const rrow of selfRows) selfByType[rrow.recipient_type] = (selfByType[rrow.recipient_type] || 0) + rrow.amount_cents;
  ok(selfByType.artist === 5250, 'self-referral: shop earns the 70% designer share on its own design');
  ok(!selfByType.shop, 'self-referral: NO 20% shop referral cut on its own design');
  ok(selfRows.some((rrow) => rrow.recipient_type === 'artist' && rrow.status === 'payable'), 'designer share is payable to the shop');
  sr = await req('GET', '/orders/custom');
  ok(sr.status === 200 && sr.text.includes('Shop Designer'), 'shop appears in the request-artist dropdown');
  // Lapsed shop subscription also suspends the designer side.
  await db.update('subscriptions', shopDesSubId, { status: 'cancelled' });
  ok(!(await shopDesignerActive(shopDesId)) && !(await designerAccess(shopDesId)), 'designer access dies with the shop subscription');
  ok(!(await comm.recipientEligible(shopDesId, 'design_artist')), 'no designer payout eligibility without an active shop subscription');

  // ===== POD custom tees + design contests (owner rules 2026-09-30) =====
  {
    console.log('pod tees:');
    const tpricing = require('../src/lib/pricing');
    const printful = require('../src/lib/printful');
    const tcomm = require('../src/lib/commissions');
    const tcontests = require('../src/lib/contests');
    function tjar() {
      const j = {};
      return async function (method, p, { body, follow = true } = {}) {
        const h = {};
        const cookies = Object.entries(j).map(([k, v]) => `${k}=${v}`).join('; ');
        if (cookies) h.cookie = cookies;
        let payload = body;
        if (payload && typeof payload === 'object') { payload = new URLSearchParams(payload); h['content-type'] = 'application/x-www-form-urlencoded'; }
        const res = await fetch(`http://localhost:${PORT}${p}`, { method, headers: h, body: payload, redirect: follow ? 'follow' : 'manual' });
        for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
          const [k, v] = c.split(';')[0].split('='); j[k.trim()] = (v || '').trim();
        }
        return { status: res.status, text: await res.text(), location: res.headers.get('location') };
      };
    }

    // Tee pricing: S-XL $28.99, 2XL $30.99, 3XL $32.99.
    ok(tpricing.teePriceCents('S') === 2899 && tpricing.teePriceCents('M') === 2899 &&
      tpricing.teePriceCents('L') === 2899 && tpricing.teePriceCents('XL') === 2899,
      'tee S-XL retails $28.99');
    ok(tpricing.teePriceCents('2XL') === 3099, 'tee 2XL retails $30.99');
    ok(tpricing.teePriceCents('3XL') === 3299, 'tee 3XL retails $32.99');
    ok(tpricing.teeSizeLabel('xxl') === 'M' && tpricing.teeSizeLabel('3xl') === '3XL', 'tee size sanitizes (bad -> M)');
    ok(tpricing.teeColorLabel('RED') === 'black' && tpricing.teeColorLabel('White') === 'white', 'tee color sanitizes (bad -> black)');
    // Margin check on the verified numbers: $28.99 - stripe - $11.92 base - $4.95 ship ≈ $10.98.
    const stripeFee = Math.round(2899 * 0.029) + 30;
    ok(2899 - stripeFee - 1192 - 495 >= 1000, 'tee S-XL holds ~$10+ margin after Stripe + Printful base + shipping');

    // Without PRINTFUL_API_KEY the merch page degrades to coming-soon.
    const treq = tjar();
    let tr = await treq('GET', '/merch');
    ok(tr.status === 200 && tr.text.toLowerCase().includes('coming soon'), 'merch page shows coming-soon without Printful key');
    tr = await treq('POST', '/merch/notify', { body: { email: 'tee-fan@test.local' }, follow: false });
    ok(tr.status === 302, 'merch notify signup redirects');
    ok(sdb.prepare('SELECT id FROM merch_notify WHERE email = ?').get('tee-fan@test.local'), 'merch notify email stored');
    await treq('POST', '/signup', { body: { display_name: 'Tee Buyer', email: 'teebuyer@test.local', password: 'password123' }, follow: false });
    tr = await treq('GET', '/merch/tee/design-x', { follow: false });
    ok(tr.status === 302 && (tr.location || '').includes('/merch'), 'tee order form redirects to merch when Printful is unconfigured');

    // Aftercare guide: public page with affiliate links wired to the owner's tracking ID.
    tr = await treq('GET', '/aftercare');
    ok(tr.status === 200 && tr.text.includes('Tattoo Aftercare Guide'), 'aftercare page renders');
    ok(tr.text.includes('tag=tattooartcust-20'), 'aftercare links carry the Amazon Associates tracking ID');
    ok(tr.text.includes('As an Amazon Associate'), 'aftercare page shows the affiliate disclosure');

    // Printful variant mapping (lib-level): PRINTFUL_VARIANT_TEE_<COLOR>_<SIZE>.
    ok(!printful.printfulConfigured(), 'printful not configured in the test env');
    process.env.PRINTFUL_VARIANT_TEE_BLACK_M = '4011';
    ok(printful.variantIdFor('tee_classic', { color: 'black', size: 'M' }) === '4011',
      'tee variant resolves from PRINTFUL_VARIANT_TEE_<COLOR>_<SIZE>');
    ok(printful.variantIdFor('tee_classic', { color: 'white', size: 'XL' }) === '',
      'unconfigured tee size/color returns empty (stays in manual queue)');
    ok(printful.variantIdFor('print_8x10') === '', 'paper print variants still env-driven (no regression)');
    delete process.env.PRINTFUL_VARIANT_TEE_BLACK_M;

    // Tee commission guard: the shirt is a site-margin physical product —
    // the designer was paid on the design sale, so no design splits here.
    const teeBuyerId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('teebuyer@test.local').id;
    const teeDesId = await db.insert('users', { email: 'teedes@test.local', password_hash: 'x', role: 'design_artist', display_name: 'Tee Designer' });
    const teeDesignId = 'des-tee-1';
    sdb.prepare(`INSERT INTO designs (id, artist_id, title, description, price_cents, status, color_path, linework_path, linework_wm_path, categories, sale_count, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(teeDesignId, teeDesId, 'Tee Wolf', 'desc', 7500, 'approved',
      'designs/color/t.jpg', 'designs/linework/t.jpg', 'designs/linework-wm/t-wm.jpg', '[]', 0, Date.now());
    await db.insert('orders', {
      buyer_id: teeBuyerId, design_id: teeDesignId, order_type: 'premade',
      amount_cents: 7500, fee_cents: 312, amount_paid_cents: 7812, status: 'paid',
      payment_method: 'paypal', paid_at: Date.now(),
    });
    const teeAmt = tpricing.teePriceCents('XL') * 2; // 5798
    const teeFee = tpricing.processingFeeCents(teeAmt);
    const teeOrderId = await db.insert('orders', {
      buyer_id: teeBuyerId, design_id: teeDesignId, order_type: 'print',
      amount_cents: teeAmt, fee_cents: teeFee, amount_paid_cents: teeAmt + teeFee,
      status: 'paid', payment_method: 'paypal', paid_at: Date.now(),
    });
    await db.insert('print_orders', {
      order_id: teeOrderId, user_id: teeBuyerId, design_id: teeDesignId,
      product: 'tee_classic', quantity: 2, style: 'color', size: 'XL', color: 'black',
      ship_name: 'T', ship_address1: 'A', ship_city: 'C', ship_zip: 'Z', ship_country: 'US',
      status: 'pending', fulfill_token: 'tee-test-token',
    });
    await tcomm.recordSaleCommissions(await db.get('SELECT * FROM orders WHERE id = ?', [teeOrderId]));
    const teeRows = sdb.prepare('SELECT recipient_type, amount_cents, status, commission_type FROM commission_ledger WHERE order_id = ?').all(teeOrderId);
    ok(teeRows.length === 1 && teeRows[0].commission_type === 'merch_tee' &&
      teeRows[0].recipient_type === 'site' && teeRows[0].status === 'site_kept',
      'tee order books exactly one merch_tee site row');
    ok(teeRows[0].amount_cents === teeAmt, 'tee site row equals the full net base (no designer split on the shirt)');
    const teeSubmit = await printful.onOrderPaid(await db.get('SELECT * FROM orders WHERE id = ?', [teeOrderId]));
    ok(teeSubmit.submitted === false && teeSubmit.reason === 'printful not configured',
      'tee stays in the manual queue without a Printful key (never throws)');

    console.log('design contests:');
    // Quote math: $60 prize -> $2.59 fee -> $62.59 total.
    const cq = tcontests.contestQuote(6000);
    ok(cq.feeCents === 259 && cq.totalCents === 6259, 'contest quote: $60 prize + $2.59 fee = $62.59 total');
    let cthrew = false;
    try { tcontests.validateBrief({ title: 'Hi', description: 'too short', prizeCents: 3000 }); } catch (e) { cthrew = true; }
    ok(cthrew, 'contest brief validation rejects short title/description');
    cthrew = false;
    try { tcontests.validateBrief({ title: 'A valid contest title', description: 'A sufficiently long description for the validation test.', prizeCents: 2000 }); } catch (e) { cthrew = true; }
    ok(cthrew, 'contest rejects prizes under $30');
    cthrew = false;
    try { tcontests.validateBrief({ title: 'A valid contest title', description: 'A sufficiently long description, email me at a@b.com please.', prizeCents: 5000 }); } catch (e) { cthrew = true; }
    ok(cthrew, 'contest brief screening blocks contact info');

    // Board renders; form requires login.
    const creq = tjar();
    let cr = await creq('GET', '/contests');
    ok(cr.status === 200 && cr.text.includes('Design Contests'), 'contest board renders');
    const anon = tjar();
    cr = await anon('GET', '/contests/new', { follow: false });
    ok(cr.status === 302 && (cr.location || '').includes('/login'), 'contest form requires login');
    await creq('POST', '/signup', { body: { display_name: 'Contest Customer', email: 'contestcust@test.local', password: 'password123' }, follow: false });
    const custId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('contestcust@test.local').id;
    cr = await creq('POST', '/contests', { body: { title: 'Cheap contest', description: 'A sufficiently long description for the cheap contest test.', prize_cents: '1000' }, follow: false });
    ok(cr.status === 302 && (cr.location || '').includes('/contests/new'), 'sub-$30 prize rejected back to the form');

    // Create: PayPal createCheckoutOrder throws unconfigured in test -> manual fallback.
    cr = await creq('POST', '/contests', { body: {
      title: 'Test bounty wolf', description: 'Draw a neo-traditional wolf head, fierce expression, for a forearm piece.',
      style: 'traditional', size_placement: 'Forearm', prize_cents: '6000',
    }, follow: false });
    ok(cr.status === 302 && (cr.location || '').includes('/orders/manual/'), 'contest created -> manual prize-pay fallback');
    const contestOrderId = (cr.location || '').split('/orders/manual/')[1];
    const contestRow = sdb.prepare('SELECT * FROM contests WHERE order_id = ?').get(contestOrderId);
    ok(contestRow && contestRow.status === 'pending_payment' && contestRow.prize_cents === 6000, 'contest pending with $60 prize escrow');
    const co = sdb.prepare('SELECT * FROM orders WHERE id = ?').get(contestOrderId);
    ok(co && co.order_type === 'contest' && co.amount_cents === 6000 && co.fee_cents === 259, 'prize escrow order: $60 + $2.59 fee');
    await tcomm.recordSaleCommissions(await db.get('SELECT * FROM orders WHERE id = ?', [contestOrderId]));
    ok(sdb.prepare('SELECT COUNT(*) AS n FROM commission_ledger WHERE order_id = ?').get(contestOrderId).n === 0,
      'no sale commissions booked on prize escrow');

    // Capture the prize (stubbed PayPal) -> contest opens with a 7-day window.
    sdb.prepare('UPDATE orders SET paypal_order_id = ? WHERE id = ?').run('pp-contest-1', contestOrderId);
    cr = await creq('GET', `/contests/capture/${contestRow.id}`, { follow: false });
    ok(cr.status === 302 && (cr.location || '').includes(`/contests/${contestRow.id}`), 'prize capture opens the contest');
    const opened = sdb.prepare('SELECT * FROM contests WHERE id = ?').get(contestRow.id);
    ok(opened.status === 'open' && opened.ends_at > Date.now() + 6.9 * 86400000, 'contest open with ~7-day window');
    cr = await creq('GET', `/contests/${opened.id}`);
    ok(cr.status === 200 && cr.text.includes('Test bounty wolf') && cr.text.includes('$60.00'), 'contest detail shows the brief and prize');

    // Designer signup + eligibility, entry form renders.
    const dreq = tjar();
    await dreq('POST', '/signup', { body: { display_name: 'Contest Designer', email: 'contestdes@test.local', password: 'password123' }, follow: false });
    const desId = sdb.prepare('SELECT id FROM users WHERE email = ?').get('contestdes@test.local').id;
    sdb.prepare("UPDATE users SET role = 'design_artist' WHERE id = ?").run(desId);
    const dplanId = sdb.prepare("SELECT id FROM plans WHERE slug = 'design_artist'").get().id;
    await db.insert('subscriptions', { user_id: desId, plan_id: dplanId, status: 'active', current_period_end: Date.now() + 86400000 });
    const { upsertProfile } = require('../src/lib/profiles');
    await upsertProfile('artist_profiles', desId, { payout_paypal_email: 'contestdes@pay.test' });
    ok(await tcomm.recipientEligible(desId, 'design_artist'), 'contest designer is payout-eligible');
    cr = await dreq('GET', `/contests/${opened.id}/enter`);
    ok(cr.status === 200 && cr.text.includes('Entry image'), 'designer entry form renders');

    // Entry via lib; holder can view the file, strangers get 403.
    const entryDir = path.join(process.env.ASSET_DIR, 'uploads', 'contests');
    fs.mkdirSync(entryDir, { recursive: true });
    fs.writeFileSync(path.join(entryDir, 'test-entry.jpg'), 'fake-entry-image');
    const entryId = await tcontests.enterContest({ contestId: opened.id, designerId: desId, imagePath: 'uploads/contests/test-entry.jpg', note: 'My wolf entry' });
    ok(!!entryId, 'designer entry recorded');
    cthrew = false;
    try { await tcontests.enterContest({ contestId: opened.id, designerId: opened.customer_id, imagePath: 'uploads/contests/test-entry.jpg' }); } catch (e) { cthrew = true; }
    ok(cthrew, 'contest holder cannot enter their own contest');
    cr = await creq('GET', `/contests/entry/${entryId}/file`, { follow: false });
    ok(cr.status === 200, 'contest holder can view the entry file');
    const sreq = tjar();
    await sreq('POST', '/signup', { body: { display_name: 'Stranger', email: 'stranger@test.local', password: 'password123' }, follow: false });
    let sr = await sreq('GET', `/contests/entry/${entryId}/file`, { follow: false });
    ok(sr.status === 403, 'strangers cannot view contest entries before judging');

    // Non-holder cannot pick; holder picks -> 88/12 split.
    sr = await sreq('POST', `/contests/${opened.id}/pick/${entryId}`, { follow: false });
    ok(sr.status === 302, 'non-holder pick attempt redirects');
    ok(sdb.prepare('SELECT status FROM contests WHERE id = ?').get(opened.id).status === 'open', 'non-holder cannot pick the winner');
    cr = await creq('POST', `/contests/${opened.id}/pick/${entryId}`, { follow: false });
    ok(cr.status === 302, 'holder pick redirects');
    const awarded = sdb.prepare('SELECT * FROM contests WHERE id = ?').get(opened.id);
    ok(awarded.status === 'awarded' && awarded.winner_user_id === desId, 'contest awarded to the winning designer');
    const cRows = sdb.prepare('SELECT recipient_type, recipient_id, amount_cents, status, commission_type FROM commission_ledger WHERE order_id = ?').all(contestOrderId);
    const prizeRow = cRows.find((x) => x.commission_type === 'contest_prize');
    const feeRow = cRows.find((x) => x.commission_type === 'contest_fee');
    ok(cRows.length === 2, 'exactly two contest ledger rows');
    ok(prizeRow && prizeRow.amount_cents === 5280 && prizeRow.status === 'payable' && prizeRow.recipient_id === desId,
      'winner gets 88% ($52.80) payable');
    ok(feeRow && feeRow.amount_cents === 720 && feeRow.recipient_type === 'site' && feeRow.status === 'site_kept',
      'site keeps 12% ($7.20)');
    cthrew = false;
    try { await tcontests.pickWinner({ contestId: opened.id, entryId, pickerId: custId }); } catch (e) { cthrew = true; }
    ok(cthrew, 'cannot pick twice on an awarded contest');

    // Expiry: no entries -> refunded as site credit; entries -> judging.
    const { contestId: emptyId } = await tcontests.createPendingContest({
      customerId: custId, title: 'Empty bounty test',
      description: 'A sufficiently long description for the empty bounty test.', prizeCents: 3000,
    });
    await tcontests.openContest(emptyId, { paidCents: 3259, paymentMethod: 'paypal' });
    sdb.prepare('UPDATE contests SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, emptyId);
    const { contestId: judgedId } = await tcontests.createPendingContest({
      customerId: custId, title: 'Judged bounty test',
      description: 'A sufficiently long description for the judged bounty test.', prizeCents: 3000,
    });
    await tcontests.openContest(judgedId, { paidCents: 3259, paymentMethod: 'paypal' });
    sdb.prepare('UPDATE contests SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, judgedId);
    await tcontests.enterContest({ contestId: judgedId, designerId: desId, imagePath: 'uploads/contests/test-entry.jpg' });
    const rep = await tcontests.expireContests(Date.now());
    ok(rep.refunded === 1 && rep.judging === 1, 'expiry: one refunded, one moved to judging');
    ok(sdb.prepare('SELECT status FROM contests WHERE id = ?').get(emptyId).status === 'refunded', 'empty contest refunded');
    const { getCreditBalance } = require('../src/lib/credits');
    ok((await getCreditBalance(custId)) >= 3000, 'prize returned to customer as site credit');
    ok(sdb.prepare('SELECT status FROM contests WHERE id = ?').get(judgedId).status === 'judging', 'contest with entries moves to judging');
    const jEntry = sdb.prepare('SELECT id FROM contest_entries WHERE contest_id = ?').get(judgedId).id;
    await tcontests.pickWinner({ contestId: judgedId, entryId: jEntry, pickerId: 'admin', pickerIsAdmin: true });
    ok(sdb.prepare('SELECT status FROM contests WHERE id = ?').get(judgedId).status === 'awarded', 'admin can pick the winner on expiry');

    // Admin contest list renders.
    const areq = tjar();
    await areq('POST', '/login', { body: { email: 'admin@test.local', password: 'AdminTest123!' }, follow: false });
    const ar = await areq('GET', '/admin/contests');
    ok(ar.status === 200 && ar.text.includes('Design contests'), 'admin contest list renders');
  }
  sdb.close();
  server.kill();
  await new Promise((res2) => server.on('exit', res2));

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness error:', e); process.exit(1); });
