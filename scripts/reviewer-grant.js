// One-off ops script: grants the Google Play reviewer account a 24-month
// complimentary customer membership (for Play Console app-access review).
// The Render web shell cannot paste long text, so this is committed and run
// as two short shell commands: `cd scripts` then `node reviewer-grant.js`.
// Idempotent: re-running extends the comp instead of stacking.
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');

const REVIEWER_EMAIL = 'tattoo.art.customs+googlereview@gmail.com';
const MONTHS = 24;

async function main() {
  await migrate();
  const user = await db.get('SELECT id, email, role FROM users WHERE email = ?', [REVIEWER_EMAIL]);
  if (!user) throw new Error('reviewer user not found: ' + REVIEWER_EMAIL);
  if (user.role !== 'customer') throw new Error('refusing: role is ' + user.role + ', expected customer');
  const plan = await db.get("SELECT id, slug FROM plans WHERE slug = 'customer' AND active = 1");
  if (!plan) throw new Error('active customer plan not found');
  const now = Date.now();
  const termMs = MONTHS * 30 * 86400000;
  const existing = await db.get(
    "SELECT id, current_period_end FROM subscriptions WHERE user_id = ? AND plan_id = ? AND status = 'active' AND (current_period_end IS NULL OR current_period_end > ?)",
    [user.id, plan.id, now]);
  if (existing) {
    const base = Math.max(Number(existing.current_period_end) || now, now);
    await db.update('subscriptions', existing.id, { current_period_end: base + termMs });
    console.log('EXTENDED comp to ' + new Date(base + termMs).toISOString());
  } else {
    await db.insert('subscriptions', {
      user_id: user.id, plan_id: plan.id, status: 'active',
      paypal_subscription_id: '', current_period_end: now + termMs, created_at: db.now(),
    });
    console.log('GRANTED ' + MONTHS + '-month customer comp, ends ' + new Date(now + termMs).toISOString());
  }
  const check = await db.get(
    "SELECT s.status, s.current_period_end FROM subscriptions s WHERE s.user_id = ? AND s.plan_id = ? AND s.status = 'active' AND s.current_period_end > ?",
    [user.id, plan.id, now]);
  console.log('VERIFY: ' + JSON.stringify(check));
  await db.close();
}

main().catch((e) => { console.error('GRANT_FAILED: ' + e.message); process.exit(1); });
