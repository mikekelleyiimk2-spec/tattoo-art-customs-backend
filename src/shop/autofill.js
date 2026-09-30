// Cancellation auto-fill (shop toolset expansion, F1).
//
// When a confirmed booking cancels, the freed slot is broadcast to the
// shop's waitlist (optionally + past clients) FIRST-CLAIM-WINS — instead of
// the one-at-a-time 24h waitlist offer. Fastest finger wins; the slot never
// sits empty.
//
// INTEGRATION (bookingFlow.cancelBooking): when the shop's
// shop_booking_settings.autofill_enabled = 1, call maybeAutofill({ booking })
// INSTEAD of waitlist.offerNextInLine:
//
//   const s = await getBookingSettings(booking.shop_user_id);
//   if (Number(s.autofill_enabled) === 1) {
//     const { maybeAutofill } = require('./autofill');
//     await maybeAutofill({ booking });
//   } else {
//     const { offerNextInLine } = require('./waitlist');
//     await offerNextInLine({ shopUserId: booking.shop_user_id, ... });
//   }
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { notifyUser } = require('../lib/notify');
const { pushToUser } = require('../lib/push');
const { sendMail } = require('../lib/mail');
const { getBookingSettings } = require('./bookingFlow');

function fmtWhen(ms) {
  return new Date(Number(ms)).toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// Create the broadcast offer and notify the audience. Never throws —
// cancellation must never break because auto-fill failed.
async function maybeAutofill({ booking }) {
  try {
    if (!booking || booking.status !== 'cancelled') return null;
    const settings = await getBookingSettings(booking.shop_user_id);
    if (Number(settings.autofill_enabled) !== 1) return null;
    const ttlMin = Math.max(15, Math.min(1440, Number(settings.autofill_expiry_minutes) || 120));
    const token = crypto.randomBytes(16).toString('hex');
    const offerId = await db.insert('slot_offers', {
      shop_user_id: booking.shop_user_id,
      staff_id: booking.staff_id || null,
      start_at: booking.start_at, end_at: booking.end_at,
      source_booking_id: booking.id,
      status: 'open', claim_token: token,
      winner_customer_id: null,
      expires_at: Date.now() + ttlMin * 60000,
    });
    const audience = await collectAudience(booking, settings);
    if (!audience.length) return { offerId, notified: 0 };
    const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [booking.shop_user_id]);
    const shopName = (shop && shop.display_name) || 'the shop';
    const when = fmtWhen(booking.start_at);
    const claimLink = `/toolkit/autofill/claim/${token}`;
    const title = `Spot just opened at ${shopName}!`;
    const body = `${shopName} had a cancellation — ${when} is up for grabs. First to claim it gets it!`;
    let notified = 0;
    for (const person of audience) {
      try {
        await notifyUser(person.id, { kind: 'autofill-offer', title, body, link: claimLink });
        try { await pushToUser(person.id, { title, body, url: claimLink }); } catch (_) { /* best-effort */ }
        if (person.email) {
          await sendMail({
            to: person.email,
            subject: title,
            text: `Hi ${person.name || 'there'},\n\n${body}\n\nClaim it here (first come, first served): ${config.baseUrl}${claimLink}\n\n— Tattoo Art Customs`,
          });
        }
        notified += 1;
      } catch (e) { console.error('autofill notify failed:', e.message); }
    }
    return { offerId, notified };
  } catch (e) {
    console.error('maybeAutofill failed:', e.message);
    return null;
  }
}

// Audience: waitlist 'waiting' entries for this shop/staff, plus — when the
// shop chose 'waitlist+past' — distinct customers with a completed booking in
// the last 365 days. Deduped by customer id.
async function collectAudience(booking, settings) {
  const seen = new Map();
  const waiting = await db.all(
    `SELECT w.customer_user_id AS id, u.email, u.display_name AS name
     FROM waitlist w JOIN users u ON u.id = w.customer_user_id
     WHERE w.shop_user_id = ? AND w.status = 'waiting'
       AND (w.staff_id IS NULL OR w.staff_id = ? OR ? IS NULL)`,
    [booking.shop_user_id, booking.staff_id || null, booking.staff_id || null]);
  for (const w of waiting) seen.set(String(w.id), w);
  if (String(settings.autofill_audience || 'waitlist') === 'waitlist+past') {
    const past = await db.all(
      `SELECT DISTINCT b.customer_user_id AS id, u.email, u.display_name AS name
       FROM bookings b JOIN users u ON u.id = b.customer_user_id
       WHERE b.shop_user_id = ? AND b.status = 'completed'
         AND b.completed_at >= ?`,
      [booking.shop_user_id, Date.now() - 365 * 86400000]);
    for (const p of past) if (!seen.has(String(p.id))) seen.set(String(p.id), p);
  }
  return [...seen.values()];
}

// Customer claims a broadcast offer. Race-safe: the open->claimed flip is
// conditional, so exactly one claimant wins even under concurrency.
async function claimOffer({ token, customerUserId }) {
  const offer = await db.get('SELECT * FROM slot_offers WHERE claim_token = ?', [String(token)]);
  if (!offer) throw new Error('Offer not found.');
  if (offer.status === 'claimed') {
    const mine = String(offer.winner_customer_id) === String(customerUserId);
    return { already: true, mine, offer };
  }
  if (offer.status !== 'open') throw new Error('This offer is no longer available.');
  if (Number(offer.expires_at) <= Date.now()) {
    await db.query("UPDATE slot_offers SET status = 'expired' WHERE id = ? AND status = 'open'", [offer.id]);
    throw new Error('This offer expired.');
  }
  const won = await db.query(
    `UPDATE slot_offers SET status = 'claimed', winner_customer_id = ?
     WHERE id = ? AND status = 'open'`,
    [String(customerUserId), offer.id]);
  if (!won.changes) {
    const fresh = await db.get('SELECT * FROM slot_offers WHERE id = ?', [offer.id]);
    if (fresh && fresh.status === 'claimed') {
      return { already: true, mine: String(fresh.winner_customer_id) === String(customerUserId), offer: fresh };
    }
    throw new Error('Someone just claimed this spot.');
  }
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [offer.shop_user_id]);
  const customer = await db.get('SELECT display_name FROM users WHERE id = ?', [String(customerUserId)]);
  await notifyUser(offer.shop_user_id, {
    kind: 'autofill-claimed', title: 'Cancelled slot claimed',
    body: `${(customer && customer.display_name) || 'A customer'} claimed the auto-fill slot (${fmtWhen(offer.start_at)}).`,
    link: '/bookings/manage',
  });
  return {
    won: true, offer,
    shopName: (shop && shop.display_name) || '',
    startAt: Number(offer.start_at), endAt: Number(offer.end_at),
    staffId: offer.staff_id,
  };
}

// Expire stale open offers (sweeper, every 15 min).
async function expireOffers() {
  const stale = await db.all(
    "SELECT id FROM slot_offers WHERE status = 'open' AND expires_at <= ?",
    [Date.now()]);
  let n = 0;
  for (const s of stale) {
    const done = await db.query(
      "UPDATE slot_offers SET status = 'expired' WHERE id = ? AND status = 'open'", [s.id]);
    if (done.changes) n += 1;
  }
  return n;
}

async function getOffersForShop(shopUserId, limit = 50) {
  return db.all(
    `SELECT o.*, u.display_name AS winner_name
     FROM slot_offers o LEFT JOIN users u ON u.id = o.winner_customer_id
     WHERE o.shop_user_id = ? ORDER BY o.created_at DESC LIMIT ?`,
    [String(shopUserId), Number(limit)]);
}

module.exports = { maybeAutofill, claimOffer, expireOffers, getOffersForShop };
