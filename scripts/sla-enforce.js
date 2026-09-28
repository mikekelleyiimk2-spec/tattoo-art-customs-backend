// Custom 48h SLA enforcement — run by the `custom-sla-enforcer` cron (every
// 6 hours) or by hand. Applies uncharged daily late penalties (idempotent),
// sends the assigned artist their due deadline reminders (idempotent per
// order+key), and prints the at-risk/overdue watchlist report the cron worker
// uses for its "keep bugging us" owner notification.
//
// Usage: node scripts/sla-enforce.js
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');
const {
  applyPenalties, sendDueReminders, slaWatchlist,
} = require('../src/lib/slaEnforcer');

function money(c) { return '$' + (c / 100).toFixed(2); }

async function main() {
  await migrate();
  await db.init();
  const now = Date.now();
  const pen = await applyPenalties({ now });
  const reminders = await sendDueReminders({ now });
  const { atRisk, overdue } = await slaWatchlist({ now });

  console.log('=== SLA enforcement run ===');
  console.log(`penalties applied: ${pen.penalties.length} across ${pen.processed} order(s)`);
  for (const p of pen.penalties) {
    console.log(`  order ${p.order_id.slice(0, 8)} day ${p.day}: -${money(p.deduction_cents)} designer, ` +
      `+${money(p.owner_cents)} owner, +${money(p.credit_cents)} buyer credit`);
  }
  for (const t of pen.terminations) {
    console.log(`  TERMINATED designer ${t.designer_id} on order ${t.order_id.slice(0, 8)} — replacement offered to buyer`);
  }
  console.log(`reminders sent: ${reminders.length}`);
  for (const r of reminders) console.log(`  order ${r.order_id.slice(0, 8)} -> ${r.key}`);
  console.log(`at-risk (<24h): ${atRisk.length}`);
  for (const o of atRisk) {
    console.log(`  ${o.id.slice(0, 8)} | ${o.hours_left}h left | ${o.artist} | ${o.status} | ${o.brief}`);
  }
  console.log(`overdue: ${overdue.length}`);
  for (const o of overdue) {
    console.log(`  ${o.id.slice(0, 8)} | ${o.days_late}d late | penalty ${money(o.penalty_cents)} | ${o.artist} | ${o.status}${o.terminated ? ' | CONTRACT TERMINATED' : ''} | ${o.brief}`);
  }
  await db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
