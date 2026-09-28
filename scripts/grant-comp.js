// Grants a complimentary (no-PayPal) subscription to a user, creating the
// user if needed. Idempotent: re-running extends/refreshes the comp grant.
// Usage: node scripts/grant-comp.js --plan=tattoo_shop --months=24 --name="Adolfo" --phone="337-517-5310"
//        node scripts/grant-comp.js --plan=design_artist --months=12 --email="x@y.com" --name="Jane"
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { upsertProfile } = require('../src/lib/profiles');

const ROLE_BY_SLUG = { design_artist: 'design_artist', tattoo_shop: 'tattoo_shop' };

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

async function main() {
  const planSlug = arg('plan');
  const months = parseInt(arg('months') || '0', 10);
  const email = arg('email');
  const phone = arg('phone');
  const name = arg('name') || 'Comp User';
  if (!ROLE_BY_SLUG[planSlug] || months <= 0 || (!email && !phone)) {
    console.error('Usage: node scripts/grant-comp.js --plan=<design_artist|tattoo_shop> --months=N --name="Name" [--email=e] [--phone=p]');
    process.exit(1);
  }
  await migrate();

  const plan = await db.get('SELECT * FROM plans WHERE slug = ? AND active = 1', [planSlug]);
  if (!plan) throw new Error(`plan not found: ${planSlug}`);

  let user = email
    ? await db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()])
    : await db.get('SELECT * FROM users WHERE phone = ? AND email LIKE ?', [phone, '%@reserved.tattooartcustoms.local']);
  if (!user && phone && email) {
    user = await db.get('SELECT * FROM users WHERE phone = ?', [phone]);
  }

  if (!user) {
    const placeholderEmail = (email || `reserved.${phone.replace(/\D/g, '')}@reserved.tattooartcustoms.local`).toLowerCase();
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    const id = await db.insert('users', {
      email: placeholderEmail, password_hash: hash, role: 'customer',
      display_name: name, phone: phone || '', created_at: db.now(), email_verified: 0,
    });
    user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    console.log(`created user ${user.id} (${placeholderEmail})`);
  } else if (phone && !user.phone) {
    await db.update('users', user.id, { phone });
    console.log(`added phone to user ${user.id}`);
  }

  const periodEnd = Date.now() + months * 30.44 * 24 * 3600 * 1000;
  const existing = await db.get(
    `SELECT s.* FROM subscriptions s WHERE s.user_id = ? AND s.plan_id = ? AND s.status = 'active'`,
    [user.id, plan.id]);
  if (existing) {
    await db.update('subscriptions', existing.id, { current_period_end: Math.max(existing.current_period_end || 0, periodEnd) });
    console.log(`extended comp subscription to ${new Date(Math.max(existing.current_period_end || 0, periodEnd)).toISOString()}`);
  } else {
    await db.insert('subscriptions', {
      user_id: user.id, plan_id: plan.id, status: 'active',
      paypal_subscription_id: '', current_period_end: periodEnd, created_at: db.now(),
    });
    console.log(`granted ${months}-month comp ${planSlug} subscription, ends ${new Date(periodEnd).toISOString()}`);
  }

  const role = ROLE_BY_SLUG[planSlug];
  if (user.role !== 'admin') await db.update('users', user.id, { role });
  if (role === 'design_artist') await upsertProfile('artist_profiles', user.id, {});
  if (role === 'tattoo_shop') {
    const code = 'TAC-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    await upsertProfile('shop_profiles', user.id, { referral_code: code });
  }
  console.log(`user ${user.id} role=${role} phone=${user.phone || phone}`);
  await db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
