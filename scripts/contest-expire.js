// Design-contest expiry — run by cron (hourly is plenty) or by hand.
// Past-deadline open contests: no entries -> prize refunded to the customer
// as site credit; entries but no winner -> 'judging' (customer or admin
// picks). Idempotent.
//
// Usage: node scripts/contest-expire.js
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { expireContests } = require('../src/lib/contests');

function money(c) { return '$' + (c / 100).toFixed(2); }

async function main() {
  await migrate();
  await db.init();
  const report = await expireContests(Date.now());
  console.log('=== Contest expiry run ===');
  console.log(`expired: ${report.expired} (${report.refunded} refunded to site credit, ${report.judging} moved to judging)`);
  const judging = await db.all(
    `SELECT c.id, c.title, COUNT(e.id) AS entries FROM contests c
     LEFT JOIN contest_entries e ON e.contest_id = c.id
     WHERE c.status = 'judging' GROUP BY c.id ORDER BY c.ends_at ASC`
  ).catch(() => []);
  if (judging.length) {
    console.log('awaiting a winner pick:');
    for (const j of judging) console.log(`  ${j.id.slice(0, 8)} | "${j.title}" | ${j.entries} entries`);
  }
  await db.close();
}

main().catch((e) => { console.error('contest-expire failed:', e); process.exit(1); });
