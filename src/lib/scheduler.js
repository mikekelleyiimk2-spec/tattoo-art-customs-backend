// In-app scheduler: weekly automated commission payouts + daily referral
// subscription resumes.
//
// Runs inside the web service (which holds DATABASE_URL + PayPal secrets),
// every Monday at ~9:00 AM America/Chicago (payouts) and daily at ~6:00 AM
// America/Chicago (referral resumes). Set WEEKLY_PAYOUTS_ENABLED=false
// to disable payouts; the admin can also trigger a run manually from
// /admin/payouts or POST /admin/payouts/auto.
const cron = require('node-cron');
const { runWeeklyPayouts } = require('./autopayout');
const { resumeReferralSubscriptions } = require('./referrals');

let started = false;

function startScheduler() {
  if (started) return;
  started = true;
  // Booking reminders (shop toolset) run independently of the payouts toggle.
  require('../shop/bookingReminders').registerBookingReminderJobs();
  if (process.env.WEEKLY_PAYOUTS_ENABLED === 'false') {
    console.log('Weekly payouts disabled (WEEKLY_PAYOUTS_ENABLED=false).');
    return;
  }
  // Monday 9:00 AM America/Chicago.
  cron.schedule('0 9 * * 1', async () => {
    console.log('[scheduler] Running weekly commission payouts…');
    try {
      const summary = await runWeeklyPayouts();
      console.log(`[scheduler] Weekly payouts done: ${summary.paid.length} paid, ${summary.queued.length} queued for manual send, ${summary.skipped.length} skipped${summary.failed ? ', FAILED: ' + summary.error : ''}`);
    } catch (e) {
      console.error('[scheduler] Weekly payouts crashed:', e.message);
    }
  }, { timezone: 'America/Chicago' });
  // Daily 6:00 AM America/Chicago: resume PayPal subscriptions whose referral
  // free month has ended, so billing picks back up.
  cron.schedule('0 6 * * *', async () => {
    console.log('[scheduler] Resuming referral free-month subscriptions…');
    try {
      const resumed = await resumeReferralSubscriptions();
      console.log(`[scheduler] Referral resumes done: ${resumed.length} resumed.`);
    } catch (e) {
      console.error('[scheduler] Referral resumes crashed:', e.message);
    }
  }, { timezone: 'America/Chicago' });
  // 1-hour designer-approval rule (owner standing order): any pending design
  // no admin personally approved within an hour gets approved automatically.
  // Same 10-minute block also runs the 2-hour SLA escalation: flagged and
  // on_hold pieces (never auto-approved) and stuck pending pieces get
  // re-notified to all admins, and the artist gets their 2h notice.
  cron.schedule('*/10 * * * *', async () => {
    try {
      const { autoApproveStaleDesigns } = require('./autoApprove');
      const { approved, blocked } = await autoApproveStaleDesigns();
      if (approved.length || blocked.length) {
        console.log(`[scheduler] 1h auto-approval: approved ${approved.length} (${approved.join(',') || 'none'})` +
          (blocked.length ? `; blocked (no watermark) ${blocked.length} (${blocked.join(',')})` : ''));
      }
    } catch (e) {
      console.error('[scheduler] 1h auto-approval crashed:', e.message);
    }
    try {
      const { escalateOverdueDesigns } = require('./contentSla');
      const { escalated } = await escalateOverdueDesigns();
      if (escalated.length) {
        console.log(`[scheduler] 2h SLA escalation: ${escalated.length} design(s) (${escalated.join(',')})`);
      }
    } catch (e) {
      console.error('[scheduler] 2h SLA escalation crashed:', e.message);
    }
  }, { timezone: 'America/Chicago' });
  console.log('Weekly commission payouts scheduled: Mondays ~9:00 AM CT.');
  console.log('Referral subscription resumes scheduled: daily ~6:00 AM CT.');
  console.log('1-hour design auto-approval scheduled: every 10 minutes.');
}

module.exports = { startScheduler };
