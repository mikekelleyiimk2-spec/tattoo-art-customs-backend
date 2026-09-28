// In-app scheduler: weekly automated commission payouts.
//
// Runs inside the web service (which holds DATABASE_URL + PayPal secrets),
// every Monday at ~9:00 AM America/Chicago. Set WEEKLY_PAYOUTS_ENABLED=false
// to disable; the admin can also trigger a run manually from /admin/payouts
// or POST /admin/payouts/auto.
const cron = require('node-cron');
const { runWeeklyPayouts } = require('./autopayout');

let started = false;

function startScheduler() {
  if (started) return;
  started = true;
  if (process.env.WEEKLY_PAYOUTS_ENABLED === 'false') {
    console.log('Weekly payouts disabled (WEEKLY_PAYOUTS_ENABLED=false).');
    return;
  }
  // Monday 9:00 AM America/Chicago.
  cron.schedule('0 9 * * 1', async () => {
    console.log('[scheduler] Running weekly commission payouts…');
    try {
      const summary = await runWeeklyPayouts();
      console.log(`[scheduler] Weekly payouts done: ${summary.paid.length} paid, ${summary.skipped.length} skipped${summary.failed ? ', FAILED: ' + summary.error : ''}`);
    } catch (e) {
      console.error('[scheduler] Weekly payouts crashed:', e.message);
    }
  }, { timezone: 'America/Chicago' });
  console.log('Weekly commission payouts scheduled: Mondays ~9:00 AM CT.');
}

module.exports = { startScheduler };
