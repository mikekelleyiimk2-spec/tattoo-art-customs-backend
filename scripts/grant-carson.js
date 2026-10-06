// One-off: grant Carson Poirier a 6-month Design Artist comp subscription.
// Run via Render shell: node scripts/grant-carson.js
const db = require('../src/db');

async function main() {
  await db.init();
  const email = 'carsonpoirier78@gmail.com';
  const user = await db.get('SELECT id, role, display_name FROM users WHERE email = ?', [email]);
  if (!user) { console.log('USER NOT FOUND'); process.exit(1); }
  console.log('User:', user.display_name, user.role, user.id);

  const plan = await db.get("SELECT * FROM plans WHERE slug = 'design_artist' AND active = 1");
  if (!plan) { console.log('PLAN NOT FOUND'); process.exit(1); }
  console.log('Plan:', plan.name, plan.interval);

  const nowMs = Date.now();
  const existing = await db.get(
    `SELECT * FROM subscriptions WHERE user_id = ? AND plan_id = ? AND status = 'active'
     AND (current_period_end IS NULL OR current_period_end > ?)`,
    [user.id, plan.id, nowMs]);
  const termMs = 6 * 30 * 86400000; // 6 months × 30 days
  if (existing) {
    const from = Math.max(Number(existing.current_period_end) || nowMs, nowMs);
    await db.update('subscriptions', existing.id, { current_period_end: from + termMs });
    console.log('Extended existing subscription to', new Date(from + termMs).toISOString());
  } else {
    const id = await db.insert('subscriptions', {
      user_id: user.id, plan_id: plan.id, status: 'active',
      paypal_subscription_id: '', current_period_end: nowMs + termMs,
      paid_with_credit: 0, created_at: db.now(),
    });
    console.log('Created subscription', id, 'until', new Date(nowMs + termMs).toISOString());
  }

  // Grant the designer role + artist profile (same as grantPlanRole)
  const { grantPlanRole } = require('../src/lib/planRoles');
  await grantPlanRole(user.id, 'design_artist');
  console.log('Role granted.');

  const check = await db.get('SELECT role FROM users WHERE id = ?', [user.id]);
  console.log('Final role:', check.role);
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
