// Shop toolkit scheduled jobs (F1/F2/F3/F5/F6/F8/F9).
//
// Registered from src/lib/scheduler.js via registerToolkitJobs(). All jobs
// are best-effort and never throw out of the cron callback.
const cron = require('node-cron');

function registerToolkitJobs() {
  const tasks = [];
  const run = (expr, label, fn, opts) => {
    const t = cron.schedule(expr, async () => {
      try {
        const n = await fn();
        if (n) console.log(`[toolkit] ${label}: ${n}`);
      } catch (e) {
        console.error(`[toolkit] ${label} crashed:`, e.message);
      }
    }, opts || { timezone: 'America/Chicago' });
    tasks.push(t);
    return t;
  };

  // Aftercare check-in sweep (hourly): due day-3/7/14 nudges via push+email.
  run('7 * * * *', 'aftercare sweep done', async () => {
    const { runAftercareSweep } = require('./aftercare');
    const n = await runAftercareSweep();
    return n ? `${n} check-in(s) sent` : '';
  });

  // Auto-fill offer expiry (every 15 min): stale open slot offers -> expired.
  run('*/15 * * * *', 'autofill expiry done', async () => {
    const { expireOffers } = require('./autofill');
    const n = await expireOffers();
    return n ? `${n} offer(s) expired` : '';
  });

  // Waiver ID doc purge (daily): hard-delete ID photos past retention.
  run('23 3 * * *', 'waiver ID purge done', async () => {
    const { purgeExpiredIdDocs } = require('./waivers');
    const n = await purgeExpiredIdDocs();
    return n ? `${n} ID doc(s) purged` : '';
  });

  // Client reactivation (daily): nudge lapsed clients.
  run('41 8 * * *', 'reactivation sweep done', async () => {
    const { runReactivationSweep } = require('./blasts');
    const n = await runReactivationSweep();
    return n ? `${n} client(s) nudged` : '';
  });

  // No-show forfeiture sweep (hourly): decided holds without live PayPal or
  // with auto-charge disabled are logged and re-queued — never charged.
  run('19 * * * *', 'forfeiture sweep done', async () => {
    const { runForfeitureSweep } = require('./noshow');
    const n = await runForfeitureSweep();
    return n ? `${n} hold(s) reviewed` : '';
  });

  // Payment-plan charge sweep (hourly): due installments without live PayPal
  // or with auto-charge disabled are marked due_awaiting_paypal — never charged.
  run('37 * * * *', 'plan charge sweep done', async () => {
    const { runPlanChargeSweep } = require('./plans');
    const r = await runPlanChargeSweep();
    return r && r.marked ? `${r.marked} installment(s) marked awaiting PayPal` : '';
  });

  return tasks;
}

module.exports = { registerToolkitJobs };
