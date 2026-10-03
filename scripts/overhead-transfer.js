// Monthly overhead transfer amount — run by the `overhead-transfer-reminder`
// cron on the 1st of each month (America/Chicago).
// Sums the website's kept share (status 'site_kept': the 10% overhead cut,
// forfeited shares, tee margins, raffle) earned in the prior calendar month
// and prints the transfer amount. The cron worker emails the owner:
// "Transfer $X from the PayPal business balance to the website overhead
// bank account." This script never moves money itself.
//
// Usage: node scripts/overhead-transfer.js
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');

async function main() {
  await migrate();
  await db.init();
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const end = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const label = new Date(start).toISOString().slice(0, 7);
  const row = await db.get(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total_cents,
            COUNT(*) AS entries
     FROM commission_ledger
     WHERE recipient_type = 'site' AND status = 'site_kept'
       AND created_at >= ? AND created_at < ?`,
    [start, end]
  );
  const dollars = (row.total_cents / 100).toFixed(2);
  console.log(`OVERHEAD_TRANSFER ${label} $${dollars} (${row.total_cents} cents across ${row.entries} ledger entries)`);
}

main().catch((e) => { console.error('overhead transfer calc failed:', e); process.exit(1); });
