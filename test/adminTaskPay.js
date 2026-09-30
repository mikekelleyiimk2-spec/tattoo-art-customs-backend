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

  // --- Tier 1: design triage is pool-funded. Empty pool → defensive hold ---
  const d0 = await mkDesign(otherArtist);
  const r0 = await atp.recordTask({ adminUserId: admin, taskType: 'design_approve', refType: 'design', refId: d0 });
  ok(r0.status === 'held' && !r0.ledger_id && r0.funded_by === 'pool',
    'triage with an empty pool is held, never paid as owner debt');
  ok((await atp.releaseHeld()) === 0, 'releaseHeld cannot promote a pool-held row while the pool is short');

  // Seed the prepaid pool (as upload fees would), then the held row promotes
  // from the pool — never from overhead.
  await db.insert('review_fee_pool', {
    kind: 'fee_in', amount_cents: 100, user_id: otherArtist, ref_type: 'design', ref_id: 'seed',
  });
  ok((await atp.poolBalance()) === 100, 'pool balance tallies fee_in credits');
  ok((await atp.releaseHeld()) === 1, 'releaseHeld promotes the pool-held row once fees arrive');
  const promoted0 = await db.get('SELECT status, ledger_id, funded_by FROM admin_task_pay WHERE id = ?', [r0.id]);
  ok(promoted0.status === 'payable' && !!promoted0.ledger_id && promoted0.funded_by === 'pool',
    'promoted triage row is payable + pool-funded');
  ok((await atp.poolBalance()) === 75, 'pool debited exactly $0.25 for the triage');

  // --- Basic record: design triage on someone else's design ---
  const d1 = await mkDesign(otherArtist);
  const r1 = await atp.recordTask({ adminUserId: admin, taskType: 'design_approve', refType: 'design', refId: d1 });
  ok(!r1.duplicate && r1.status === 'payable' && r1.amount_cents === 25 && r1.funded_by === 'pool',
    'design approval records $0.25 payable from the pool');
  ok(r1.ledger_id, 'payable task pay books a commission_ledger row');
  const ledgerRow = await db.get('SELECT * FROM commission_ledger WHERE id = ?', [r1.ledger_id]);
  ok(ledgerRow && ledgerRow.recipient_type === 'admin' && ledgerRow.recipient_id === admin &&
    ledgerRow.status === 'payable' && ledgerRow.order_id === `admintask:design_approve:design:${d1}`,
    'ledger row is admin/payable with a synthetic order_id');
  ok((await atp.poolBalance()) === 50, 'second triage debits the pool again');
  ok((await atp.grantedCents()) === 0, 'pool-funded pay does NOT count toward the overhead cap');
  ok((await comm.payableBalance('admin', admin)) === 50, 'admin task pay flows into payableBalance');

  // --- Idempotency: double-record pays once ---
  const r2 = await atp.recordTask({ adminUserId: admin, taskType: 'design_approve', refType: 'design', refId: d1 });
  ok(r2.duplicate === true, 'second record of the same task+ref is a duplicate');
  ok((await db.get('SELECT COUNT(*) AS n FROM admin_task_pay WHERE task_type = ? AND ref_type = ? AND ref_id = ?',
    ['design_approve', 'design', String(d1)])).n === 1, 'duplicate pays nothing — one row only');
  ok((await comm.payableBalance('admin', admin)) === 50, 'duplicate does not inflate the payable balance');

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
  const grantedNow = await atp.grantedCents(); // 0 — the two triage rows above are pool-funded
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
  const expectedTotal = 50 + (nPayable + 1) * 200;
  ok((await comm.payableBalance('admin', admin)) === expectedTotal, `stacked payable balance is $${(expectedTotal / 100).toFixed(2)}`);

  // --- Tier 1 upload quota: 15 free per month, $0.40 from #16 ---
  const uploader = await mkUser('atp-uploader@test.local', 'design_artist');
  for (let i = 0; i < atp.FREE_UPLOADS_PER_MONTH; i++) {
    const f = await atp.recordDesignUploadFee(uploader, `upl${i}`);
    ok(!f.charged && f.count === i + 1, `upload ${i + 1} is free (within quota)`);
  }
  const poolBeforeFee = await atp.poolBalance();
  const f16 = await atp.recordDesignUploadFee(uploader, 'upl16');
  ok(f16.charged && f16.amount_cents === atp.REVIEW_FEE_CENTS && f16.count === 16,
    '16th upload in the month books the $0.40 review fee');
  ok((await atp.poolBalance()) - poolBeforeFee === 40, 'fee credits the prepaid pool');
  const feeRow = await db.get(`SELECT * FROM commission_ledger WHERE order_id = 'reviewfee:upl16'`);
  ok(feeRow && feeRow.amount_cents === -40 && feeRow.recipient_type === 'designer' &&
    feeRow.recipient_id === uploader && feeRow.commission_type === 'review_fee',
    'fee is a negative designer ledger row (nets against earnings)');
  const usage = await db.get(
    'SELECT * FROM artist_upload_usage WHERE user_id = ? AND month = ?', [uploader, atp.chicagoMonthKey()]);
  ok(usage && usage.count === 16 && /^\d{4}-\d{2}$/.test(usage.month),
    'usage tracked per Chicago calendar month');
  // A second month starts a fresh quota.
  await db.query(`UPDATE artist_upload_usage SET month = '2000-01' WHERE user_id = ?`, [uploader]);
  const fNew = await atp.recordDesignUploadFee(uploader, 'upl-newmonth');
  ok(!fNew.charged && fNew.count === 1, 'quota resets each calendar month');

  // --- Fee nets against the designer's payable balance ---
  await db.insert('commission_ledger', {
    order_id: 'test-earn', recipient_type: 'designer', recipient_id: uploader,
    amount_cents: 1000, status: 'payable', commission_type: 'premade',
  });
  ok((await comm.payableBalance('designer', uploader)) === 960,
    'review fee nets against payable earnings ($10.00 - $0.40)');
  const uploader2 = await mkUser('atp-uploader2@test.local', 'design_artist');
  for (let i = 0; i < atp.FREE_UPLOADS_PER_MONTH; i++) await atp.recordDesignUploadFee(uploader2, `u2-${i}`);
  await atp.recordDesignUploadFee(uploader2, 'u2-16');
  ok((await comm.payableBalance('designer', uploader2)) === -40,
    'fee with no balance books as negative — nets against FUTURE earnings');

  // --- population_admin flag: ONLY flagged accounts are exempt (owner rule,
  // narrowed 2026-09-29). Every other lifetime holder follows normal rules.
  const { maybeBookReviewFee } = require('../src/lib/portfolioUpload');
  const { hasLifetimeSubscription, isPopulationAdmin, assertNotPopulationAdmin } = require('../src/middleware/auth');
  const planArtist = await db.get("SELECT id FROM plans WHERE slug = 'design_artist'");
  ok(await isPopulationAdmin('nobody') === false, 'unknown user is not a population admin');
  // Flagged account: 20 uploads, zero fees, zero quota rows, pool untouched.
  const popId = await mkUser('atp-popadmin@test.local', 'design_artist');
  await db.query('UPDATE users SET population_admin = 1 WHERE id = ?', [popId]);
  ok(await isPopulationAdmin(popId) === true, 'population_admin flag detected');
  const poolBeforePop = await atp.poolBalance();
  for (let i = 0; i < 20; i++) {
    const pf = await maybeBookReviewFee(popId, `pop-upl${i}`);
    ok(pf.exempt === true && !pf.charged && !pf.note,
      `flagged upload ${i + 1} is free, exempt, and shows no fee note`);
  }
  const popUsage = await db.get('SELECT * FROM artist_upload_usage WHERE user_id = ?', [popId]);
  ok(!popUsage, 'flagged uploads never touch quota');
  const popFees = await db.get(
    `SELECT COUNT(*) AS n FROM commission_ledger WHERE recipient_id = ? AND commission_type = 'review_fee'`,
    [popId]);
  ok(popFees.n === 0, 'flagged uploads book zero review fees');
  ok((await atp.poolBalance()) === poolBeforePop, 'pool untouched by flagged uploads');
  // Non-flag lifetime holder (the Adolfo case): normal quota/fee rules apply.
  const lifeId = await mkUser('atp-lifetime@test.local', 'design_artist');
  await db.insert('subscriptions', {
    user_id: lifeId, plan_id: planArtist.id, status: 'active', current_period_end: null,
  });
  ok(await hasLifetimeSubscription(lifeId) === true, 'lifetime grant detected (active + NULL period end)');
  ok(await isPopulationAdmin(lifeId) === false, 'non-flag lifetime holder is NOT a population admin');
  for (let i = 0; i < 15; i++) await maybeBookReviewFee(lifeId, `life-upl${i}`);
  const life16 = await maybeBookReviewFee(lifeId, 'life-upl16');
  ok(life16.charged && life16.amount_cents === 40 && !!life16.note,
    'non-flag lifetime holder: 16th upload books the $0.40 fee like everyone else');
  // Unflagging rejoins quota at upload 1.
  await db.query('UPDATE users SET population_admin = 0 WHERE id = ?', [popId]);
  ok(await isPopulationAdmin(popId) === false, 'unflagged account loses the exemption');
  const pfAfter = await maybeBookReviewFee(popId, 'pop-upl21');
  ok(!pfAfter.exempt && !pfAfter.charged && pfAfter.count === 1,
    'unflagged account rejoins quota at upload 1');
  // Regular subscriber through the same hook path: 16th upload still pays.
  const regId = await mkUser('atp-regular@test.local', 'design_artist');
  await db.insert('subscriptions', {
    user_id: regId, plan_id: planArtist.id, status: 'active', current_period_end: Date.now() + 86400000,
  });
  for (let i = 0; i < 15; i++) await maybeBookReviewFee(regId, `reg-upl${i}`);
  const r16 = await maybeBookReviewFee(regId, 'reg-upl16');
  ok(r16.charged && r16.amount_cents === 40 && !!r16.note,
    'regular subscriber: 16th upload books the $0.40 fee via the hook');
  // Monthly-charge guard: throws for flagged accounts, passes for everyone else.
  await db.query('UPDATE users SET population_admin = 1 WHERE id = ?', [popId]);
  let guardErr = null;
  try { await assertNotPopulationAdmin(popId); } catch (e) { guardErr = e; }
  ok(!!guardErr && /population-admin/i.test(guardErr.message),
    'assertNotPopulationAdmin throws a clear error for flagged accounts');
  let guardOk = false;
  try { await assertNotPopulationAdmin(regId); guardOk = true; } catch (e) { /* must not throw */ }
  ok(guardOk, 'assertNotPopulationAdmin passes for non-flagged accounts');

  // --- Tier 3: ad revenue split ---
  const ads = require('../src/lib/ads');
  const ohBefore = await atp.overheadCents();
  const split = await ads.recordAdRevenue({ amountCents: 101, source: 'test' });
  ok(split.site_cents === 50 && split.owner_cents === 51,
    'ad revenue splits 50/50 to site overhead / owner (floor on odd cents)');
  ok((await atp.overheadCents()) - ohBefore === 50, 'site half lands in the overhead pool');
  const adRow = await db.get(
    `SELECT * FROM commission_ledger WHERE commission_type = 'ad_revenue' ORDER BY created_at DESC LIMIT 1`);
  ok(adRow && adRow.recipient_type === 'site' && adRow.status === 'site_kept' && adRow.amount_cents === 50,
    'ad revenue books a site_kept overhead row');
  const adCountBefore = (await db.get(
    `SELECT COUNT(*) AS n FROM commission_ledger WHERE commission_type = 'ad_revenue'`)).n;
  const zero = await ads.recordAdRevenue({ amountCents: 0, source: 'test' });
  ok(zero.site_cents === 0 && (await db.get(
    `SELECT COUNT(*) AS n FROM commission_ledger WHERE commission_type = 'ad_revenue'`)).n === adCountBefore,
    'zero revenue books no ledger row');

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
  const myIds = [admin, otherArtist, nonAdmin, uploader, uploader2, lifeId, regId];
  const ph = myIds.map(() => '?').join(',');
  await db.query(`DELETE FROM admin_task_pay WHERE admin_user_id IN (${ph})`, myIds);
  await db.query(`DELETE FROM review_fee_pool WHERE user_id IN (${ph}) OR ref_id = 'seed'`, myIds);
  await db.query(`DELETE FROM artist_upload_usage WHERE user_id IN (${ph})`, myIds);
  await db.query(`DELETE FROM commission_ledger WHERE order_id LIKE 'admintask:%' OR order_id LIKE 'test-site-%'
    OR order_id LIKE 'reviewfee:%' OR order_id LIKE 'adrev:%' OR order_id = 'test-earn'`);
  await db.query(`DELETE FROM subscriptions WHERE user_id IN (${ph})`, myIds);
  await db.query(`DELETE FROM artist_profiles WHERE user_id IN (${ph})`, myIds);
  await db.query('DELETE FROM designs WHERE id IN (?, ?, ?)', [d0, d1, own]);
  await db.query(`DELETE FROM users WHERE id IN (${ph})`, myIds);
  ok((await db.get(`SELECT COUNT(*) AS n FROM users WHERE id IN (${ph})`, myIds)).n === 0,
    'test users cleaned up');
  ok((await db.get(`SELECT COUNT(*) AS n FROM review_fee_pool`)).n === 0, 'pool rows cleaned up');
}

module.exports = { runDbTests };
