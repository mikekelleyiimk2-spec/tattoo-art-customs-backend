// Review request automation (shop toolset, phase 8).
//
// The shop sets their Google review URL once, in the SAME settings row the
// aftercare review machine already uses (shop_review_settings, migration
// 051) — settings storage is owned by src/shop/aftercare.js
// (saveReviewSettings / getReviewSettings). This module reuses those
// functions and writes NO competing settings code.
//
// After a booking is marked complete, the shop can trigger a review request
// manually (sendReviewRequest, POST /shop/reviews/send/:bookingId), or let
// the scheduler auto-send it (enabled = 1, the default).
//
// ANTI-SPAM: exactly one ask per booking EVER, across all sources. Before
// sending we check (1) the aftercare check-in log (aftercare.js
// maybeAskReview already asked on a 'great' response — tracked via
// aftercare_checkins.review_requested_at) and (2) this module's unified
// sent-log, shop_review_requests. The UNIQUE(booking_id) constraint is the
// final backstop: even a double-clicked form or two concurrent sweeps can
// only ever log (and send) one ask per booking.
//
// shop_review_requests is the UNIFIED sent-log: the aftercare ask writes
// here too (source='aftercare', logged inside aftercare.js), alongside
// manual ('manual') and scheduler ('auto') asks.
//
// SCHEDULER WIRING (coordinator): add ONE line inside startScheduler() in
// src/lib/scheduler.js:
//
//   require('../shop/reviewRequests').registerReviewRequestJobs();
//
// The sweep runs every 6 hours and sends only for bookings completed
// 24h–7d ago whose shop has enabled on, a review URL set, and an active
// tattoo_shop subscription. Conservative on purpose: late-night completions
// never email the customer before a day has passed.
//
// SHOP-SUPPLY AFFILIATE RULE (owner directive 2026-10-09): shop-supply
// affiliate links live ONLY in shop-gated areas. This module sends to the
// shop's own customers; it carries no affiliate content at all.
const cron = require('node-cron');
const db = require('../db');
const { sendMail } = require('../lib/mail');
const { notifyUser } = require('../lib/notify');
const { hasActiveSubscription } = require('../middleware/auth');
const aftercare = require('./aftercare');

const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_KIND = 'review-request';

// Settings live in aftercare.js's storage (shop_review_settings from 051).
// aftercare owns the table and the validation; this wrapper only adds the
// "never saved yet" defaults so views always get an object.
async function getSettings(shopUserId) {
  const row = await aftercare.getReviewSettings(shopUserId);
  return row || { shop_user_id: shopUserId, google_review_url: null, enabled: 1 };
}
const saveSettings = aftercare.saveReviewSettings;

// True when the customer was already asked for a review on this booking by
// ANY source: the aftercare 'great' ask, or a manual/auto send in the log.
async function alreadyAsked(bookingId) {
  const aftercareAsk = await db.get(
    'SELECT id FROM aftercare_checkins WHERE booking_id = ? AND review_requested_at IS NOT NULL LIMIT 1',
    [String(bookingId)]);
  if (aftercareAsk) return { by: 'aftercare', id: aftercareAsk.id };
  const logged = await db.get(
    'SELECT id, source FROM shop_review_requests WHERE booking_id = ? LIMIT 1',
    [String(bookingId)]);
  if (logged) return { by: logged.source || 'manual', id: logged.id };
  return null;
}

// Write one row to the unified sent-log. Duplicate-safe: the caller already
// asked was allowed to send; the UNIQUE(booking_id) backstop means a lost
// race just swallows the duplicate instead of crashing.
async function logAsk({ shopUserId, bookingId, clientEmail, source }) {
  try {
    return await db.insert('shop_review_requests', {
      shop_user_id: String(shopUserId),
      booking_id: String(bookingId),
      client_email: clientEmail || null,
      sent_at: Date.now(),
      clicked: 0,
      source,
    });
  } catch (e) {
    if (!/unique|UNIQUE|constraint/i.test(e.message)) throw e;
    return null;
  }
}

// Recently completed bookings eligible for a review request (this shop only).
// A booking is eligible when it is completed, no ask has ever gone out for
// it (aftercare ask OR log row), and it is not older than 90 days.
async function getEligibleBookings(shopUserId) {
  const rows = await db.all(
    `SELECT b.id, b.completed_at, c.email AS customer_email, c.display_name AS customer_name
     FROM bookings b
     JOIN users c ON c.id = b.customer_user_id
     WHERE b.shop_user_id = ? AND b.status = 'completed'
       AND b.completed_at >= ?
     ORDER BY b.completed_at DESC`,
    [String(shopUserId), Date.now() - 90 * DAY_MS]);
  const eligible = [];
  for (const b of rows) {
    if (!(await alreadyAsked(b.id))) eligible.push(b); // eslint-disable-line no-await-in-loop
  }
  return eligible;
}

// Unified sent-request log for one shop (all sources), newest first.
async function getSentLog(shopUserId) {
  return db.all(
    `SELECT r.*, u.display_name AS customer_name
     FROM shop_review_requests r
     LEFT JOIN bookings b ON b.id = r.booking_id
     LEFT JOIN users u ON u.id = b.customer_user_id
     WHERE r.shop_user_id = ?
     ORDER BY r.sent_at DESC`,
    [String(shopUserId)]);
}

// Send a review request for one completed booking (shop-scoped). Returns
// { already: true, by } when the customer was already asked by any source
// (aftercare 'great' ask, manual, or auto) — never double-ask.
//
// Throws when the booking isn't this shop's, isn't completed, or the shop
// hasn't set a Google review URL.
async function sendReviewRequest({ shopUserId, bookingId }) {
  const booking = await db.get(
    `SELECT b.*, s.display_name AS shop_name,
            c.email AS customer_email, c.display_name AS customer_name
     FROM bookings b
     JOIN users s ON s.id = b.shop_user_id
     JOIN users c ON c.id = b.customer_user_id
     WHERE b.id = ? AND b.shop_user_id = ?`,
    [String(bookingId), String(shopUserId)]);
  if (!booking) throw new Error('Booking not found.');
  if (booking.status !== 'completed') {
    throw new Error('Review requests only go out after a booking is completed.');
  }
  const prior = await alreadyAsked(bookingId);
  if (prior) return { already: true, by: prior.by };
  const settings = await getSettings(shopUserId);
  if (!settings || Number(settings.enabled) !== 1 || !settings.google_review_url) {
    throw new Error('Set your Google review URL in the review settings first.');
  }
  if (!booking.customer_email) {
    throw new Error('The customer has no email address on file.');
  }
  const shopName = booking.shop_name || 'the shop';
  const subject = `How was your visit to ${shopName}?`;
  const text =
    `Hi ${booking.customer_name || 'there'},\n\n` +
    `Thanks for getting tattooed at ${shopName}! If you loved the work, ` +
    `a quick Google review means the world to us:\n\n` +
    `${settings.google_review_url}\n\n` +
    `— Tattoo Art Customs`;
  await sendMail({ to: booking.customer_email, subject, text });
  await notifyUser(booking.customer_user_id, {
    kind: REVIEW_KIND, title: subject,
    body: `Thanks for visiting ${shopName}! If you loved the work, a quick Google review means a lot.`,
    link: `/journal#booking-${booking.id}`,
  });
  const id = await logAsk({
    shopUserId, bookingId: booking.id, clientEmail: booking.customer_email, source: 'manual',
  });
  if (!id) {
    // Lost a race with a concurrent send: the email still went out exactly
    // once (the send above happened, the log just records one row).
    return { already: true, by: 'manual' };
  }
  return { already: false, id };
}

// Mark a request as clicked (e.g. if a click-through endpoint is added).
// Kept separate from sending; never blocks or retries a send.
async function markClicked(shopUserId, requestId) {
  const done = await db.query(
    'UPDATE shop_review_requests SET clicked = 1 WHERE id = ? AND shop_user_id = ?',
    [String(requestId), String(shopUserId)]);
  return !!(done && done.changes);
}

// Scheduler sweep: auto-send review requests for shops that opted in.
// Called by cron every 6 hours. Conservative windows:
//   - bookings completed 24h–7d ago (fresh enough to remember, not instant)
//   - shop has enabled = 1 AND a review URL set
//   - shop still holds an active tattoo_shop subscription
//   - the aftercare 'great' ask hasn't already fired for the booking
// Fault isolation: one booking's failure never aborts the sweep.
async function runReviewSweep() {
  const now = Date.now();
  const sent = [];
  const rows = await db.all(
    `SELECT b.id AS booking_id, b.shop_user_id, b.completed_at,
            c.email AS customer_email, c.display_name AS customer_name,
            s.display_name AS shop_name, st.google_review_url
     FROM bookings b
     JOIN users s ON s.id = b.shop_user_id
     JOIN users c ON c.id = b.customer_user_id
     JOIN shop_review_settings st ON st.shop_user_id = b.shop_user_id
     WHERE b.status = 'completed'
       AND b.completed_at >= ? AND b.completed_at < ?
       AND st.enabled = 1 AND st.google_review_url IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM shop_review_requests r WHERE r.booking_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM aftercare_checkins ac
                       WHERE ac.booking_id = b.id AND ac.review_requested_at IS NOT NULL)`,
    [now - 7 * DAY_MS, now - DAY_MS]);
  for (const row of rows) {
    try {
      if (!(await hasActiveSubscription(row.shop_user_id, 'tattoo_shop'))) continue;
      if (!row.customer_email) continue;
      const prior = await alreadyAsked(row.booking_id);
      if (prior) continue;
      await sendReviewRequest({ shopUserId: row.shop_user_id, bookingId: row.booking_id });
      // Mark this one as an auto-send, not manual, in the unified log.
      await db.query(
        "UPDATE shop_review_requests SET source = 'auto' WHERE booking_id = ?",
        [String(row.booking_id)]);
      sent.push(row.booking_id);
    } catch (e) {
      console.error(`[scheduler] review request failed for booking ${row.booking_id}:`, e.message);
    }
  }
  return sent;
}

// Registers the cron job in the existing scheduler style. Called once from
// startScheduler() in src/lib/scheduler.js (see the wiring note at the top).
function registerReviewRequestJobs() {
  // Every 6 hours, at 20 past the hour.
  const task = cron.schedule('20 */6 * * *', async () => {
    try {
      const sent = await runReviewSweep();
      if (sent.length) {
        console.log(`[scheduler] review requests auto-sent: ${sent.length} (${sent.join(',')}).`);
      }
    } catch (e) {
      console.error('[scheduler] review request sweep crashed:', e.message);
    }
  }, { timezone: 'America/Chicago' });
  console.log('Review request auto-send scheduled: every 6 hours.');
  return task;
}

module.exports = {
  getSettings, saveSettings, alreadyAsked, logAsk,
  getEligibleBookings, getSentLog,
  sendReviewRequest, markClicked, runReviewSweep, registerReviewRequestJobs,
  REVIEW_KIND,
};
