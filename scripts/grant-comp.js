// Grants a complimentary (no-PayPal) subscription to a user, creating the
// user if needed. Idempotent: re-running extends/refreshes the comp grant.
// Usage: node scripts/grant-comp.js --plan=tattoo_shop --months=24 --name="Adolfo" --phone="337-517-5310"
//        node scripts/grant-comp.js --plan=design_artist --months=12 --email="x@y.com" --name="Jane"
//        node scripts/grant-comp.js --plan=design_artist --lifetime --name="Adolfo" --phone="337-517-5310" --keep-role
// Flags:
//   --lifetime   true indefinite access: current_period_end = NULL (the
//                durable lifetime form — hasActiveSubscription treats NULL
//                as active; never use a far-future date for lifetime).
//   --keep-role  don't overwrite the user's existing role. Needed when
//                granting a design_artist subscription to a tattoo_shop
//                account (dual role): the account keeps its shop role and
//                dashboards, gains full designer access via the subscription,
//                and shop_profiles.designer_opt_in is set so designer lists
//                (request-artist dropdown, public portfolios, custom routing,
//                admin designer actions) include the account.
// If the matched account still has a reserved placeholder email
// (@reserved.tattooartcustoms.local) and --email is supplied, the login
// email is updated to the real address. Real emails are never overwritten.
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
function flag(name) { return process.argv.includes(`--${name}`); }

async function main() {
  const planSlug = arg('plan');
  const months = parseInt(arg('months') || '0', 10);
  const email = arg('email');
  const phone = arg('phone');
  const name = arg('name') || 'Comp User';
  const lifetime = flag('lifetime');
  const keepRole = flag('keep-role');
  if (!ROLE_BY_SLUG[planSlug] || (!lifetime && months <= 0) || (!email && !phone)) {
    console.error('Usage: node scripts/grant-comp.js --plan=<design_artist|tattoo_shop> (--months=N | --lifetime) --name="Name" [--email=e] [--phone=p] [--keep-role]');
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
  // If the account still has a reserved placeholder email and a real --email
  // was supplied, adopt it as the login email (placeholder addresses can
  // never receive mail). Never overwrites a real email address.
  if (email && user.email.endsWith('@reserved.tattooartcustoms.local') &&
      user.email !== email.toLowerCase()) {
    await db.update('users', user.id, { email: email.toLowerCase() });
    console.log(`updated login email to ${email.toLowerCase()}`);
    user.email = email.toLowerCase();
  }

  const periodEnd = lifetime ? null : Date.now() + months * 30.44 * 24 * 3600 * 1000;
  const existing = await db.get(
    `SELECT s.* FROM subscriptions s WHERE s.user_id = ? AND s.plan_id = ? AND s.status = 'active'`,
    [user.id, plan.id]);
  if (existing) {
    if (lifetime) {
      await db.update('subscriptions', existing.id, { current_period_end: null });
      console.log('extended comp subscription to lifetime (no expiry)');
    } else {
      const end = Math.max(existing.current_period_end || 0, periodEnd);
      await db.update('subscriptions', existing.id, { current_period_end: end });
      console.log(`extended comp subscription to ${new Date(end).toISOString()}`);
    }
  } else {
    await db.insert('subscriptions', {
      user_id: user.id, plan_id: plan.id, status: 'active',
      paypal_subscription_id: '', current_period_end: periodEnd, created_at: db.now(),
    });
    console.log(lifetime
      ? `granted lifetime comp ${planSlug} subscription (no expiry)`
      : `granted ${months}-month comp ${planSlug} subscription, ends ${new Date(periodEnd).toISOString()}`);
  }

  const role = ROLE_BY_SLUG[planSlug];
  if (!keepRole && user.role !== 'admin') await db.update('users', user.id, { role });
  if (role === 'design_artist') await upsertProfile('artist_profiles', user.id, {});
  if (role === 'design_artist' && keepRole && user.role === 'tattoo_shop') {
    // Dual role: the shop keeps its role/dashboards; the designer_opt_in flag
    // puts the account in designer lists (request-artist dropdown, public
    // portfolios, custom routing, admin designer actions). Designer access
    // itself comes from the design_artist subscription, not the flag.
    await upsertProfile('shop_profiles', user.id, { designer_opt_in: 1 });
    console.log(`dual role: kept role=tattoo_shop, designer_opt_in=1 for designer lists`);
  }
  if (role === 'tattoo_shop') {
    const code = 'TAC-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    await upsertProfile('shop_profiles', user.id, { referral_code: code });
  }
  console.log(`user ${user.id} role=${keepRole ? user.role : role} phone=${user.phone || phone}`);
  await db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
