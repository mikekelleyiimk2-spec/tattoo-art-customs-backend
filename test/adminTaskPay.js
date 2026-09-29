// Admin task pay tests (DB phase — runs before db.close()).
// Per-task admin pay out of the site's 10% overhead, capped at 25% of
// cumulative site overhead. Active-only: no base pay, pay per completed task.
const db = require('../src/db');
const atp = require('../src/lib/adminTaskPay');
const comm = require('../src/lib/commissions');
const cashout = require('../src/lib/cashout');
const { upsertProfile } = require('../src/lib/profiles');

async function mkUser(email, role = 'admin') {
  return db.insert('users', {
    email, password_hash: 'x', role, display_name: email.split('@')[0],
  });
}

async function mkDesign(artistId) {
  return db.insert('designs', { title: 't', artist_id: artistId });
}

// Simulate the site's 10% overhead landing in the ledger.
async function bookSiteOverhead(cents, tag) {
  return db.insert('commission_ledger', {
    order_id: `test-site-${tag}`, recipient_type: 'site', recipient_id: null,
    amount_cents: cents, status: 'site_kept',
  });
}

async function runDbTests(ok) {
  console.log('admin task pay:');
  ok(atp.ADMIN_TASK_PAY_OVERHEAD_CAP_PCT === 25, 'overhead cap is 25%');
  ok(atp.RATE_CARD.design_approve === 25 && atp.RATE_CARD.design_reject === 25 && atp.RATE_CARD.design_hold === 25,
    'design triage pays $0.25');
  ok(atp.RATE_CARD.appeal_decide === 200, 'appeal decision pays $2.00');
  ok(atp.RATE_CARD.custom_approve === 100, 'custom order actions pay $1.00');
  ok(atp.RATE_CARD.ad_activate === 10 && atp.RATE_CARD.review_approve === 10, 'ads + review queue pay $0.10');

  const admin = await mkUser('atp-admin@test.local', 'admin');
  const otherArtist = await mkUser('atp-artist@test.local', 'design_artist');

  // $40.00 of site overhead → 25% cap = $10.00 of task pay.
  await bookSiteOverhead(4000, 'a');
  ok((await atp.overheadCents()) >= 4000, 'overhead tallied from site ledger rows');

  // --- Basic record: design triage on someone else's design ---
  const d1 = await mkDesign(otherArtist);
  const r1 = await atp.recordTask({ adminUserId: admin, taskType: 'design_approve', refType: 'design', refId: d1 });
  ok(!r1.duplicate && r1.status === 'payable' && r1.amount_cents === 25, 'design approval records $0.25 payable');
  ok(r1.ledger_id, 'payable task pay books a commission_ledger row');
  const ledgerRow = await db.get('SELECT * FROM commission_ledger WHERE id = ?', [r1.ledger_id]);
  ok(ledgerRow && ledgerRow.recipient_type === 'admin' && ledgerRow.recipient_id === admin &&
    ledgerRow.status === 'payable' && ledgerRow.order_id === `admintask:design_approve:design:${d1}`,
    'ledger row is admin/payable with a synthetic order_id');
  ok((await comm.payableBalance('admin', admin)) === 25, 'admin task pay flows into payableBalance');

  // --- Idempotency: double-record pays once ---
  const r2 = await atp.recordTask({ adminUserId: admin, taskType: 'design_approve', refType: 'design', refId: d1 });
  ok(r2.duplicate === true, 'second record of the same task+ref is a duplicate');
  ok((await db.get('SELECT COUNT(*) AS n FROM admin_task_pay WHERE task_type = ? AND ref_type = ? AND ref_id = ?',
    ['design_approve', 'design', String(d1)])).n === 1, 'duplicate pays nothing — one row only');
  ok((await comm.payableBalance('admin', admin)) === 25, 'duplicate does not inflate the payable balance');

  // --- Self-pay guard ---
  const own = await mkDesign(admin);
  const r3 = await atp.recordTask({ adminUserId: admin, taskType: 'design_approve', refType: 'design', refId: own });
  ok(r3.selfPay === true, 'moderating your own design earns nothing');
  ok((await db.get('SELECT COUNT(*) AS n FROM admin_task_pay WHERE ref_id = ?', [String(own)])).n === 0,
    'self-pay records no row at all');

  // --- Cap: 25% of cumulative site overhead ---
  // Earlier inline tests already booked real site overhead, so calibrate
  // against the live totals instead of assuming a clean ledger.
  const overheadNow = await atp.overheadCents();
  const capNow = Math.floor(overheadNow * 25 / 100);
  const grantedNow = await atp.grantedCents(); // $0.25 from the design approval above
  const room = capNow - grantedNow;
  const nPayable = Math.max(0, Math.floor(room / 200)); // $2 appeal decisions that fit
  for (let i = 0; i < nPayable; i++) {
    const r = await atp.recordTask({ adminUserId: admin, taskType: 'appeal_decide', refType: 'appeal', refId: `ap${i}` });
    ok(r.status === 'payable', `appeal decision ${i} payable under the cap`);
  }
  const held = await atp.recordTask({ adminUserId: admin, taskType: 'appeal_decide', refType: 'appeal', refId: `ap${nPayable}` });
  ok(held.status === 'held' && !held.ledger_id, 'pay beyond the 25% cap is held with no ledger row');
  const heldRow = await db.get('SELECT status, ledger_id FROM admin_task_pay WHERE id = ?', [held.id]);
  ok(heldRow.status === 'held' && !heldRow.ledger_id, 'held row sits in admin_task_pay only');

  // releaseHeld cannot promote while the cap binds.
  ok((await atp.releaseHeld()) === 0, 'releaseHeld promotes nothing while the cap binds');
  ok((await db.get('SELECT status FROM admin_task_pay WHERE id = ?', [held.id])).status === 'held',
    'held row stays held');

  // More overhead arrives → cap grows → releaseHeld promotes oldest first.
  const grantedHeld = await atp.grantedCents();
  const needOverhead = Math.ceil((grantedHeld + 1) * 100 / 25) - overheadNow + 100;
  await bookSiteOverhead(Math.max(needOverhead, 1), 'b');
  ok((await atp.releaseHeld()) === 1, 'releaseHeld promotes the held row once overhead grows');
  const promoted = await db.get('SELECT status, ledger_id FROM admin_task_pay WHERE id = ?', [held.id]);
  ok(promoted.status === 'payable' && !!promoted.ledger_id, 'promoted row becomes payable with a ledger row');
  const expectedTotal = 25 + (nPayable + 1) * 200;
  ok((await comm.payableBalance('admin', admin)) === expectedTotal, `stacked payable balance is $${(expectedTotal / 100).toFixed(2)}`);

  // --- Payout eligibility: admin + active designer sub + payout destination ---
  let threw = false;
  try { await cashout.requirePayoutEligible(admin, 'admin'); } catch (e) { threw = true; }
  ok(threw, 'admin with no subscription cannot receive task pay (forfeiture rule)');
  const planId = (await db.get(`SELECT id FROM plans WHERE slug = 'design_artist'`)).id;
  await db.insert('subscriptions', { user_id: admin, plan_id: planId, status: 'active' });
  await upsertProfile('artist_profiles', admin, { payout_paypal_email: 'atp-admin@test.local' });
  threw = false;
  try { await cashout.requirePayoutEligible(admin, 'admin'); } catch (e) { threw = true; }
  ok(!threw, 'admin with active designer sub + payout destination is payout-eligible');
  const nonAdmin = await mkUser('atp-nonaut@test.local', 'design_artist');
  await db.insert('subscriptions', { user_id: nonAdmin, plan_id: planId, status: 'active' });
  await upsertProfile('artist_profiles', nonAdmin, { payout_paypal_email: 'atp-nonaut@test.local' });
  threw = false;
  try { await cashout.requirePayoutEligible(nonAdmin, 'admin'); } catch (e) { threw = true; }
  ok(threw, 'non-admin designer cannot claim admin task pay');

  // --- UI data shape ---
  const earnings = await atp.adminEarnings();
  const mine = earnings.find((e) => e.id === admin);
  ok(mine && mine.earned === expectedTotal && mine.payable_now === expectedTotal && mine.paid_total === 0,
    'adminEarnings reports earned / stacked payable / paid totals');

  // --- Cleanup: this suite shares one test DB, and notifyAdmins() writes one
  // notification per admin user — a leftover role='admin' test user would
  // double later sale-notification counts. Remove everything we created. ---
  const myIds = [admin, otherArtist, nonAdmin];
  const ph = myIds.map(() => '?').join(',');
  await db.query(`DELETE FROM admin_task_pay WHERE admin_user_id IN (${ph})`, myIds);
  await db.query(`DELETE FROM commission_ledger WHERE order_id LIKE 'admintask:%' OR order_id LIKE 'test-site-%'`);
  await db.query(`DELETE FROM subscriptions WHERE user_id IN (${ph})`, myIds);
  await db.query(`DELETE FROM artist_profiles WHERE user_id IN (${ph})`, myIds);
  await db.query('DELETE FROM designs WHERE id IN (?, ?)', [d1, own]);
  await db.query(`DELETE FROM users WHERE id IN (${ph})`, myIds);
  ok((await db.get(`SELECT COUNT(*) AS n FROM users WHERE id IN (${ph})`, myIds)).n === 0,
    'test users cleaned up');
}

module.exports = { runDbTests };
