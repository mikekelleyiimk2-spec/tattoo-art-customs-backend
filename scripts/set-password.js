// Sets a user's password and optionally marks their email verified.
// Usage: node scripts/set-password.js --email=x@y.com --password="secret" [--verify-email]
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}
function flag(name) { return process.argv.includes(`--${name}`); }

async function main() {
  const email = arg('email').toLowerCase();
  const password = arg('password');
  if (!email || !password) {
    console.error('Usage: node scripts/set-password.js --email=e --password=p [--verify-email]');
    process.exit(1);
  }
  await migrate();
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) {
    console.error('no such user: ' + email);
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  const data = { password_hash: hash };
  if (flag('verify-email')) data.email_verified = 1;
  await db.update('users', user.id, data);
  console.log(`PASSWORD SET for ${email} (verified=${flag('verify-email') ? 1 : 0})`);
  await db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
