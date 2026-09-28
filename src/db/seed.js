// Seeds the three membership plans and the admin user.
// Requires ADMIN_EMAIL and ADMIN_PASSWORD in the environment.
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('./index');
const { migrate } = require('./migrate');

async function seed() {
  await migrate();

  for (const key of Object.keys(config.pricing.plans)) {
    const p = config.pricing.plans[key];
    const existing = await db.get('SELECT id FROM plans WHERE slug = ?', [p.slug]);
    const paypalPlanId = config.paypal.planIds[key] || '';
    if (existing) {
      await db.update('plans', existing.id, {
        name: p.name, price_cents: p.priceCents, interval: p.interval, paypal_plan_id: paypalPlanId,
      });
      console.log(`updated plan ${p.slug}`);
    } else {
      await db.insert('plans', {
        slug: p.slug, name: p.name, price_cents: p.priceCents,
        interval: p.interval, paypal_plan_id: paypalPlanId, active: 1,
        description: p.slug === 'customer'
          ? 'Lower-cost custom commissions, pre-made designs, early access to new content.'
          : p.slug === 'design_artist'
            ? 'Upload your art, write an artist bio, earn 60% commission per sale.'
            : 'Refer customers and earn 20% on every verified sale you refer.',
      });
      console.log(`created plan ${p.slug}`);
    }
  }

  if (config.adminEmail && config.adminPassword) {
    const existing = await db.get('SELECT id FROM users WHERE email = ?', [config.adminEmail.toLowerCase()]);
    if (!existing) {
      const hash = await bcrypt.hash(config.adminPassword, 12);
      await db.insert('users', {
        email: config.adminEmail.toLowerCase(), password_hash: hash,
        role: 'admin', display_name: 'Site Admin',
        created_at: db.now(), email_verified: 1,
      });
      console.log(`created admin ${config.adminEmail}`);
    } else {
      console.log(`admin ${config.adminEmail} already exists`);
    }
  } else {
    console.log('ADMIN_EMAIL/ADMIN_PASSWORD not set — skipping admin creation');
  }
}

if (require.main === module) {
  seed().then(() => db.close()).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { seed };
