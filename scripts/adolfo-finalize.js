// One-off: finalize Adolfo's complimentary grant in production.
// Verifies and idempotently fixes: role=tattoo_shop, active 24-month
// tattoo_shop comp, lifetime design_artist comp, email verified,
// shop_profiles.designer_opt_in=1 (+ referral_code), artist_profiles row.
// Run in the Render shell: node scripts/adolfo-finalize.js
// Prints FINAL STATE lines the operator can paste back as verification.
const db = require('../src/db');
const { upsertProfile } = require('../src/lib/profiles');

const EMAIL = 'adolfo3301@yahoo.com';

async function ensureSub(userId, slug, { lifetime, months }) {
  const plan = await db.get('SELECT * FROM plans WHERE slug = ?', [slug]);
  if (!plan) throw new Error('missing plan ' + slug);
  const now = Date.now();
  const existing = await db.get(
    `SELECT * FROM subscriptions WHERE user_id = ? AND plan_id = ? AND status = 'active'
       AND (current_period_end IS NULL OR current_period_end > ?)`,
    [userId, plan.id, now]);
  if (existing) {
    if (lifetime && existing.current_period_end !== null) {
      await db.update('subscriptions', existing.id, { current_period_end: null });
      console.log(`FIX: ${slug} extended to lifetime`);
    } else {
      console.log(`OK: ${slug} active (period_end=${existing.current_period_end ? new Date(existing.current_period_end).toISOString() : 'lifetime'})`);
    }
    return;
  }
  const periodEnd = lifetime ? null : now + months * 30.44 * 24 * 3600 * 1000;
  await db.insert('subscriptions', {
    user_id: userId, plan_id: plan.id, status: 'active',
    paypal_subscription_id: '', current_period_end: periodEnd, created_at: db.now(),
  });
  console.log(`FIX: granted ${lifetime ? 'lifetime' : months + '-month'} ${slug}`);
}

async function main() {
  await db.init();
  const user = await db.get('SELECT * FROM users WHERE email = ?', [EMAIL]);
  if (!user) throw new Error('user not found: ' + EMAIL);
  console.log(`user: id=${user.id} email=${user.email} role=${user.role} verified=${user.email_verified}`);

  if (user.role !== 'tattoo_shop') {
    await db.update('users', user.id, { role: 'tattoo_shop' });
    console.log('FIX: role -> tattoo_shop');
  } else {
    console.log('OK: role=tattoo_shop');
  }
  if (!user.email_verified) {
    await db.update('users', user.id, { email_verified: 1 });
    console.log('FIX: email_verified=1');
  } else {
    console.log('OK: email verified');
  }

  await ensureSub(user.id, 'tattoo_shop', { lifetime: false, months: 24 });
  await ensureSub(user.id, 'design_artist', { lifetime: true });

  await upsertProfile('shop_profiles', user.id, { designer_opt_in: 1 });
  const shop = await db.get('SELECT designer_opt_in, referral_code FROM shop_profiles WHERE user_id = ?', [user.id]);
  console.log(`OK: shop_profiles designer_opt_in=${shop.designer_opt_in} referral_code=${shop.referral_code ? 'set' : 'MISSING'}`);
  if (!shop.referral_code) {
    const code = 'TAC-' + require('crypto').randomBytes(4).toString('hex').toUpperCase();
    await upsertProfile('shop_profiles', user.id, { referral_code: code });
    console.log('FIX: referral_code set');
  }

  await upsertProfile('artist_profiles', user.id, {});
  const artist = await db.get('SELECT user_id FROM artist_profiles WHERE user_id = ?', [user.id]);
  console.log(`OK: artist_profiles row ${artist ? 'exists' : 'MISSING'}`);

  // Final state summary.
  const subs = await db.all(
    `SELECT p.slug, s.status, s.current_period_end FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id WHERE s.user_id = ? ORDER BY p.slug`, [user.id]);
  const fin = await db.get('SELECT role, email_verified FROM users WHERE id = ?', [user.id]);
  console.log('FINAL STATE: ' + JSON.stringify({
    email: EMAIL, role: fin.role, verified: !!fin.email_verified,
    subs: subs.map((s) => ({ slug: s.slug, status: s.status, end: s.current_period_end ? new Date(s.current_period_end).toISOString().slice(0, 10) : 'lifetime' })),
    designer_opt_in: (await db.get('SELECT designer_opt_in FROM shop_profiles WHERE user_id = ?', [user.id])).designer_opt_in,
    artist_profile: !!(await db.get('SELECT user_id FROM artist_profiles WHERE user_id = ?', [user.id])),
  }));
  await db.close();
}

main().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
