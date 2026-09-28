// One-time cleanup: cancel duplicate pending custom orders left by QA
// double-submit testing (no money moved on any of them).
// Usage: node scripts/cancel-duplicate-orders.js --email=<user email>
// Only touches orders that are still pending with nothing paid.
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

async function main() {
  const email = arg('email').toLowerCase();
  if (!email) { console.error('Usage: node scripts/cancel-duplicate-orders.js --email=<email>'); process.exit(1); }
  await migrate();
  const user = await db.get('SELECT id, email FROM users WHERE email = ?', [email]);
  if (!user) { console.error('No such user: ' + email); process.exit(1); }
  const dupes = await db.all(
    `SELECT id FROM orders WHERE buyer_id = ? AND order_type = 'custom'
     AND status = 'pending' AND (amount_paid_cents IS NULL OR amount_paid_cents = 0)`,
    [user.id]);
  for (const o of dupes) await db.update('orders', o.id, { status: 'canceled' });
  console.log(`CANCELED ${dupes.length} pending unpaid custom order(s) for ${email}`);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
