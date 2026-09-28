// Production diagnostic: runs the exact queries behind GET /admin
// (dashboard stats + SLA offender watch + terminated-orders list).
// If these all succeed, the /admin crash is fixed.
// Usage (Render shell): node scripts/diag-admin.js
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');

async function main() {
  await migrate();
  const checks = [];
  async function check(name, fn) {
    try { const r = await fn(); checks.push([name, 'OK', JSON.stringify(r).slice(0, 80)]); }
    catch (e) { checks.push([name, 'FAIL', e.message]); }
  }
  await check('users', () => db.get('SELECT COUNT(*) AS n FROM users'));
  await check('designs', () => db.get('SELECT COUNT(*) AS n FROM designs'));
  await check('pendingDesigns', () => db.get("SELECT COUNT(*) AS n FROM designs WHERE status = 'pending'"));
  await check('orders', () => db.get('SELECT COUNT(*) AS n FROM orders'));
  await check('revenue', () => db.get("SELECT COALESCE(SUM(amount_paid_cents),0) AS t FROM orders WHERE status = 'paid'"));
  await check('openReviews', () => db.get("SELECT COUNT(*) AS n FROM review_queue WHERE status = 'open'"));
  await check('payableOut', () => db.get("SELECT COALESCE(SUM(amount_cents),0) AS t FROM commission_ledger WHERE status = 'payable'"));
  await check('offenderWatch', async () => {
    const { offenderWatch } = require('../src/lib/slaEnforcer');
    const w = await offenderWatch({ now: Date.now() });
    return { count: w.length };
  });
  await check('terminatedOrders', () => db.all(
    `SELECT o.id, o.replacement_status, u.email AS buyer_email
     FROM orders o JOIN users u ON u.id = o.buyer_id
     WHERE o.designer_contract_terminated = 1 AND o.custom_status NOT IN ('delivered')
     ORDER BY o.delivery_due ASC`));
  let failed = 0;
  for (const [name, st, detail] of checks) {
    console.log(`${st} ${name} ${detail}`);
    if (st === 'FAIL') failed++;
  }
  console.log(failed ? `DIAG_FAIL ${failed}` : 'DIAG_OK');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('DIAG_FAIL ' + e.message); process.exit(1); });
