// Daily owner sweep — run by the `owner-daily-sweep` cron every morning
// (America/Chicago). Finalizes newly-cleared sales (paid, past the 24h
// clearing window, not on hold) by marking the owner's ledger rows cleared,
// then emails the owner the daily summary. Artist/shop commissions stay on
// the weekly Monday payout schedule — this script never pays anyone.
//
// Usage: node scripts/owner-daily-sweep.js
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { runOwnerSweep } = require('../src/lib/ownerSweep');

async function main() {
  await migrate();
  await db.init();
  const summary = await runOwnerSweep({ now: Date.now() });
  console.log('=== Owner daily sweep ===');
  console.log(summary.report);
}

main().catch((e) => { console.error('owner sweep failed:', e); process.exit(1); });
