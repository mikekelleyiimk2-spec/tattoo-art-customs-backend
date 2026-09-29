// Booking reminders (shop toolset, Phase 3).
//
// sendBookingConfirmation(bookingId) — called immediately when Phase 2
// creates/confirms a booking. PHASE 2 INTEGRATION: call it from the booking
// creation path:
//
//   const { sendBookingConfirmation } = require('../lib/bookingReminders');
//   await sendBookingConfirmation(booking.id);
//
// runReminderSweep() — called by cron every ~15 minutes. Sends:
//   - 'reminder-day-before': booking starts in ~24h (23h–25h window)
//   - 'reminder-day-of':     booking starts in ~2h (1.5h–2.5h window)
//   - 'aftercare-checkin':   booking completed ~3 days ago (60h–84h window)
// Each goes to the CUSTOMER as an in-app notification + email.
//
// DEDUP (no new tables allowed): before sending, the sweep checks the
// `notifications` table for an existing row with the same user_id + kind +
// link (link = `/journal#booking-<id>`). The notification write IS the
// sent-log — a resend can only happen if the notifications row was deleted.
// Kinds: 'booking-confirmation', 'reminder-day-before', 'reminder-day-of',
// 'aftercare-checkin'.
//
// SCHEDULER WIRING (coordinator): add ONE line inside startScheduler() in
// src/lib/scheduler.js:
//
//   require('./bookingReminders').registerBookingReminderJobs();
//
// registerBookingReminderJobs() also schedules the waitlist offer-expiry
// sweep (every 15 min, same cadence).
const cron = require('node-cron');
const db = require('../db');
const { notifyUser } = require('./notify');
const { sendMail } = require('./mail');
const { expireOffers } = require('./waitlist');

const DAY_BEFORE_KIND = 'reminder-day-before';
const DAY_OF_KIND = 'reminder-day-of';
const AFTERCARE_KIND = 'aftercare-checkin';
const CONFIRM_KIND = 'booking-confirmation';

function bookingLink(bookingId) {
  // The customer's journal timeline lists their bookings (read-only).
  return `/journal#booking-${bookingId}`;
}

function fmtWhen(ms) {
  return new Date(Number(ms)).toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

async function reminderSent(userId, kind, link) {
  const hit = await db.get(
    'SELECT id FROM notifications WHERE user_id = ? AND kind = ? AND link = ? LIMIT 1',
    [userId, kind, link]);
  return !!hit;
}

async function loadBookingContext(bookingId) {
  const booking = await db.get(
    `SELECT b.*, s.display_name AS shop_name, s.email AS shop_email,
            c.email AS customer_email, c.display_name AS customer_name
     FROM bookings b
     JOIN users s ON s.id = b.shop_user_id
     JOIN users c ON c.id = b.customer_user_id
     WHERE b.id = ?`, [String(bookingId)]);
  return booking;
}

async function sendBookingConfirmation(bookingId) {
  const b = await loadBookingContext(bookingId);
  if (!b) return false;
  const link = bookingLink(b.id);
  if (await reminderSent(b.customer_user_id, CONFIRM_KIND, link)) return false;
  const when = fmtWhen(b.start_at);
  const title = `Booking confirmed — ${b.shop_name}`;
  const body = `You're booked at ${b.shop_name} on ${when}. Fill out your intake form any time before the appointment.`;
  await notifyUser(b.customer_user_id, { kind: CONFIRM_KIND, title, body, link });
  if (b.customer_email) {
    await sendMail({
      to: b.customer_email, subject: title,
      text: `Hi ${b.customer_name || 'there'},\n\n${body}\n\nIntake form: ${require('../config').baseUrl}/intake/${b.id}\n\n— Tattoo Art Customs`,
    });
  }
  return true;
}

async function runReminderSweep() {
  const now = Date.now();
  const H = 60 * 60 * 1000;
  const sent = { dayBefore: 0, dayOf: 0, aftercare: 0 };

  async function sweepWindow(kind, fromMs, toMs, matchCompleted, titleFor, bodyFor) {
    const rows = await db.all(
      `SELECT b.*, s.display_name AS shop_name, c.email AS customer_email, c.display_name AS customer_name
       FROM bookings b
       JOIN users s ON s.id = b.shop_user_id
       JOIN users c ON c.id = b.customer_user_id
       WHERE b.status NOT IN ('cancelled')
         AND ${matchCompleted ? 'b.completed_at' : 'b.start_at'} >= ?
         AND ${matchCompleted ? 'b.completed_at' : 'b.start_at'} < ?`,
      [fromMs, toMs]);
    for (const b of rows) {
      const link = bookingLink(b.id);
      if (await reminderSent(b.customer_user_id, kind, link)) continue;
      const title = titleFor(b);
      const body = bodyFor(b);
      await notifyUser(b.customer_user_id, { kind, title, body, link });
      if (b.customer_email) {
        await sendMail({ to: b.customer_email, subject: title, text: `${body}\n\n— Tattoo Art Customs` });
      }
      if (kind === DAY_BEFORE_KIND) sent.dayBefore++;
      else if (kind === DAY_OF_KIND) sent.dayOf++;
      else sent.aftercare++;
    }
  }

  // Day-before: starts in 23–25h.
  await sweepWindow(DAY_BEFORE_KIND, now + 23 * H, now + 25 * H, false,
    (b) => `Appointment tomorrow — ${b.shop_name}`,
    (b) => `Reminder: you're booked at ${b.shop_name} tomorrow (${fmtWhen(b.start_at)}).`);
  // Day-of: starts in 1.5–2.5h.
  await sweepWindow(DAY_OF_KIND, now + 1.5 * H, now + 2.5 * H, false,
    (b) => `Appointment today — ${b.shop_name}`,
    (b) => `Heads up: your appointment at ${b.shop_name} is at ${fmtWhen(b.start_at)} — about 2 hours from now.`);
  // Aftercare: completed 60–84h ago (~3 days).
  await sweepWindow(AFTERCARE_KIND, now - 84 * H, now - 60 * H, true,
    (b) => `How's the healing? — ${b.shop_name}`,
    (b) => `It's been a few days since your appointment at ${b.shop_name}. Keep it clean, keep it moisturized, and reach out to the shop if anything looks off. Happy healing!`);

  return sent;
}

// Registers the cron jobs in the existing scheduler style. Called once from
// startScheduler() in src/lib/scheduler.js (see the wiring note at the top).
function registerBookingReminderJobs() {
  // Every 15 minutes: booking reminders + waitlist offer expiry.
  cron.schedule('*/15 * * * *', async () => {
    try {
      const sent = await runReminderSweep();
      if (sent.dayBefore || sent.dayOf || sent.aftercare) {
        console.log(`[scheduler] booking reminders: ${sent.dayBefore} day-before, ${sent.dayOf} day-of, ${sent.aftercare} aftercare.`);
      }
    } catch (e) {
      console.error('[scheduler] booking reminder sweep crashed:', e.message);
    }
    try {
      const expired = await expireOffers();
      if (expired.length) {
        console.log(`[scheduler] waitlist: expired ${expired.length} offer(s), re-offered ${expired.filter((x) => x.nextOfferedId).length}.`);
      }
    } catch (e) {
      console.error('[scheduler] waitlist expiry crashed:', e.message);
    }
  }, { timezone: 'America/Chicago' });
  console.log('Booking reminders + waitlist expiry scheduled: every 15 minutes.');
}

module.exports = {
  sendBookingConfirmation, runReminderSweep, registerBookingReminderJobs,
  DAY_BEFORE_KIND, DAY_OF_KIND, AFTERCARE_KIND, CONFIRM_KIND,
};
