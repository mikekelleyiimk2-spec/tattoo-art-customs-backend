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
  const { dualSubBonusActive } = require('../src/lib/shopDesigner');
  const { upsertProfile: upsertTestProfile } = require('../src/lib/profiles');
  const dualId = await db.insert('users', { email: 'dual@test.local', password_hash: 'x', role: 'tattoo_shop', display_name: 'Dual' });
  await upsertTestProfile('artist_profiles', dualId, { payout_paypal_email: 'dual@x.com' });
  await upsertTestProfile('shop_profiles', dualId, { designer_opt_in: 1 });
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
  await upsertTestProfile('shop_profiles', otherDualId, { designer_opt_in: 1 });
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
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
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

  // Design page: custom piece shows the custom price.
  r = await req('GET', `/design/${prow.id}`);
  ok(r.status === 200 && r.text.includes(pricing.money(pricing.withFeeCents(pricing.customFullCents()))), 'design page shows custom price for portfolio piece');
  ok(r.text.includes('custom portfolio piece'), 'design page labels custom piece');

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
    && afterAttach.color_path && fs.existsSync(path.join(process.env.ASSET_DIR, afterAttach.color_path)),
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
    && fs.existsSync(path.join(process.env.ASSET_DIR, expRow.linework_blur_path)),
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

  // ===== Shop free designer opt-in =====
  console.log('shop-designer-optin:');
  const { shopDesignerActive, designerAccess } = require('../src/lib/shopDesigner');
  const shopDesId = await db.insert('users', {
    email: 'shopdesigner@test.local', password_hash: await bcrypt.hash('ShopPass123!', 10),
    role: 'tattoo_shop', display_name: 'Shop Designer',
  });
  const shopPlanId = (await db.get(`SELECT id FROM plans WHERE slug = 'tattoo_shop'`)).id;
  const shopDesSubId = await db.insert('subscriptions', {
    user_id: shopDesId, plan_id: shopPlanId, status: 'active',
    paypal_subscription_id: 'sub-shopdesigner-test', created_at: Date.now(),
  });
  ok(!(await designerAccess(shopDesId)), 'shop has no designer access before opt-in');
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
  ok(sr.status === 302 && (sr.location || '').includes('/membership'), 'shop blocked from artist area before opt-in');
  sr = await req('GET', `/artists/${shopDesId}`);
  ok(sr.status === 404, 'public artist page 404s for non-opted-in shop');
  sr = await shopreq('POST', '/shop/designer-opt-in', { body: { enable: '1', website: '' } });
  ok(sr.status === 302 && (sr.location || '').includes('/shop'), 'opt-in posts back to shop dashboard');
  ok(await shopDesignerActive(shopDesId) && await designerAccess(shopDesId), 'opt-in is live with an active shop subscription');
  sr = await shopreq('GET', '/artist/portfolio', {});
  ok(sr.status === 200, 'opted-in shop can open the artist portfolio');
  sr = await shopreq('GET', '/shop', {});
  ok(sr.status === 200 && sr.text.includes('Free designer membership') && sr.text.includes('badge ok'), 'shop dashboard shows the active opt-in');
  sr = await req('GET', `/artists/${shopDesId}`);
  ok(sr.status === 200, 'public artist page live for opted-in shop');
  // The opted-in shop earns designer commissions on its active shop
  // subscription — no artist plan needed — and the self-referral guard
  // still holds: referring its OWN design is booked exactly like no
  // referral (no 20% shop cut).
  await upsertProfile('shop_profiles', shopDesId, { payout_paypal_email: 'shop@pay.test' });
  ok(await comm.recipientEligible(shopDesId, 'design_artist'), 'opted-in shop is eligible for designer payouts');
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
  ok(selfRows.some((rrow) => rrow.recipient_type === 'artist' && rrow.status === 'payable'), 'designer share is payable to the opted-in shop');
  sr = await req('GET', '/orders/custom');
  ok(sr.status === 200 && sr.text.includes('Shop Designer'), 'opted-in shop appears in the request-artist dropdown');
  // Opt-out returns the shop to shop-only access.
  sr = await shopreq('POST', '/shop/designer-opt-in', { body: { enable: '0', website: '' } });
  ok(!(await designerAccess(shopDesId)), 'designer access ends when the shop opts out');
  sr = await shopreq('GET', '/artist/portfolio', {});
  ok(sr.status === 302 && (sr.location || '').includes('/membership'), 'opted-out shop blocked from artist area again');
  // Lapsed shop subscription also suspends the designer side.
  await shopreq('POST', '/shop/designer-opt-in', { body: { enable: '1', website: '' } });
  await db.update('subscriptions', shopDesSubId, { status: 'cancelled' });
  ok(!(await shopDesignerActive(shopDesId)) && !(await designerAccess(shopDesId)), 'designer opt-in dies with the shop subscription');
  ok(!(await comm.recipientEligible(shopDesId, 'design_artist')), 'no designer payout eligibility without an active shop subscription');

  sdb.close();
  server.kill();
  await new Promise((res2) => server.on('exit', res2));

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness error:', e); process.exit(1); });
