// Waitlist (shop toolset, Phase 3).
//
// A customer joins a shop's waitlist (optionally for a specific staff
// member). When a slot frees up, the shop offers it to the first 'waiting'
// entry: status -> 'offered', offer_expires_at = now + 24h. The customer
// claims from the emailed/app link; unclaimed offers expire and the next
// entry in line is offered automatically.
//
// PHASE 2 INTEGRATION: Phase 2's cancelBooking MUST call offerNextInLine
// when a confirmed booking is cancelled, so the freed slot goes to the
// waitlist before it goes public:
//
//   const { offerNextInLine } = require('../lib/waitlist');
//   await offerNextInLine({
//     shopUserId: booking.shop_user_id,
//     staffId: booking.staff_id,      // may be null
//     startAt: booking.start_at,      // unix-ms of the freed slot
//     endAt: booking.end_at,          // unix-ms of the freed slot
//   });
//
// startAt/endAt are OPTIONAL. When omitted (e.g. the expiry cascade), the
// offer is for "the next opening" and the claim page links the customer to
// the shop's booking flow instead of a concrete slot. Slot times are NOT
// stored on the waitlist row — they travel in the claim link's query string
// (?start=&end=) and come back as hidden form fields on POST /claim/:id, so
// no migration was needed. Claim-time slot availability must still be
// re-verified by whoever creates the booking (Phase 2).
const db = require('../db');
const config = require('../config');
const { notifyUser } = require('./notify');
const { sendMail } = require('./mail');

const OFFER_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours to claim

async function joinWaitlist({ shopUserId, staffId, customerUserId, notes }) {
  const shop = await db.get("SELECT id FROM users WHERE id = ? AND role = 'tattoo_shop'", [String(shopUserId)]);
  if (!shop) throw new Error('That shop was not found.');
  let staff = null;
  if (staffId) {
    staff = await db.get(
      'SELECT id FROM shop_staff WHERE id = ? AND shop_user_id = ? AND active = 1',
      [String(staffId), shop.id]);
    if (!staff) throw new Error('That staff member was not found at this shop.');
  }
  const existing = await db.get(
    `SELECT id FROM waitlist WHERE shop_user_id = ? AND customer_user_id = ?
     AND status IN ('waiting', 'offered')`,
    [shop.id, customerUserId]);
  if (existing) throw new Error('You are already on this waitlist.');
  return db.insert('waitlist', {
    shop_user_id: shop.id, staff_id: staff ? staff.id : null,
    customer_user_id: customerUserId,
    notes: String(notes || '').trim().slice(0, 500) || null,
    status: 'waiting', offer_expires_at: null,
  });
}

// Offer the freed slot to the first waiting entry. Staff-specific entries
// (staff_id set) only match their own staff's slots; general entries
// (staff_id NULL) match any slot at the shop.
async function offerNextInLine({ shopUserId, staffId = null, startAt = null, endAt = null }) {
  const entry = await db.get(
    `SELECT w.*, u.email AS customer_email, u.display_name AS customer_name
     FROM waitlist w JOIN users u ON u.id = w.customer_user_id
     WHERE w.shop_user_id = ? AND w.status = 'waiting'
       AND (w.staff_id IS NULL OR w.staff_id = ? OR ? IS NULL)
     ORDER BY w.created_at ASC LIMIT 1`,
    [String(shopUserId), staffId, staffId]);
  if (!entry) return null;
  const expiresAt = Date.now() + OFFER_TTL_MS;
  await db.update('waitlist', entry.id, { status: 'offered', offer_expires_at: expiresAt });
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [String(shopUserId)]);
  const shopName = (shop && shop.display_name) || 'the shop';
  const slotText = startAt && endAt
    ? ` for ${new Date(Number(startAt)).toLocaleString('en-US', { timeZone: 'America/Chicago' })}`
    : '';
  let claimLink = `/waitlist/claim/${entry.id}`;
  if (startAt && endAt) claimLink += `?start=${Number(startAt)}&end=${Number(endAt)}`;
  const body = `${shopName} has a spot open${slotText}! Claim it within 24 hours or it goes to the next person in line.`;
  await notifyUser(entry.customer_user_id, {
    kind: 'waitlist-offer', title: 'A spot opened up!',
    body, link: claimLink,
  });
  if (entry.customer_email) {
    await sendMail({
      to: entry.customer_email,
      subject: `A spot opened up at ${shopName}!`,
      text: `Hi ${entry.customer_name || 'there'},\n\n${body}\n\nClaim it here: ${config.baseUrl}${claimLink}\n\n— Tattoo Art Customs`,
    });
  }
  return { entryId: entry.id, customerUserId: entry.customer_user_id, claimLink, startAt, endAt };
}

// Customer claims their offered slot. Returns the slot info for booking.
async function claimOffer({ id, customerUserId, startAt = null, endAt = null }) {
  const entry = await db.get('SELECT * FROM waitlist WHERE id = ?', [String(id)]);
  if (!entry || entry.customer_user_id !== customerUserId) throw new Error('Offer not found.');
  if (entry.status === 'claimed') return { already: true, startAt, endAt, entry };
  if (entry.status !== 'offered') throw new Error('This offer is no longer available.');
  if (entry.offer_expires_at && entry.offer_expires_at <= Date.now()) {
    await db.update('waitlist', entry.id, { status: 'expired' });
    // Keep the line moving: immediately offer the next person.
    await expireOffers();
    throw new Error('This offer expired — the next person in line has been offered the spot.');
  }
  await db.update('waitlist', entry.id, { status: 'claimed' });
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [entry.shop_user_id]);
  await notifyUser(entry.shop_user_id, {
    kind: 'waitlist-claimed', title: 'Waitlist spot claimed',
    body: `${(await db.get('SELECT display_name FROM users WHERE id = ?', [customerUserId]) || {}).display_name || 'A customer'} claimed the offered spot.`,
    link: '/waitlist/list',
  });
  return { startAt: startAt != null ? Number(startAt) : null, endAt: endAt != null ? Number(endAt) : null, entry, shopName: (shop && shop.display_name) || '' };
}

// Expire stale offers and cascade: each expired offer triggers an offer to
// the next entry in line (general offer — no concrete slot times; whoever
// calls this after a cancellation passes the freed slot explicitly via
// offerNextInLine instead).
async function expireOffers() {
  const stale = await db.all(
    "SELECT * FROM waitlist WHERE status = 'offered' AND offer_expires_at IS NOT NULL AND offer_expires_at <= ?",
    [Date.now()]);
  const results = [];
  for (const entry of stale) {
    await db.update('waitlist', entry.id, { status: 'expired' });
    await notifyUser(entry.customer_user_id, {
      kind: 'waitlist-expired', title: 'Waitlist offer expired',
      body: 'Your 24-hour claim window passed. You are back in line for the next opening.',
      link: '/waitlist/mine',
    });
    const next = await offerNextInLine({ shopUserId: entry.shop_user_id, staffId: entry.staff_id });
    results.push({ expiredId: entry.id, nextOfferedId: next ? next.entryId : null });
  }
  return results;
}

async function getWaitlistForShop(shopUserId) {
  return db.all(
    `SELECT w.*, u.display_name AS customer_name, u.email AS customer_email,
            s.name AS staff_name
     FROM waitlist w
     JOIN users u ON u.id = w.customer_user_id
     LEFT JOIN shop_staff s ON s.id = w.staff_id
     WHERE w.shop_user_id = ?
     ORDER BY CASE w.status WHEN 'offered' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,
              w.created_at ASC`,
    [String(shopUserId)]);
}

async function getWaitlistForCustomer(customerUserId) {
  return db.all(
    `SELECT w.*, u.display_name AS shop_name, s.name AS staff_name
     FROM waitlist w
     JOIN users u ON u.id = w.shop_user_id
     LEFT JOIN shop_staff s ON s.id = w.staff_id
     WHERE w.customer_user_id = ?
     ORDER BY w.created_at DESC`,
    [String(customerUserId)]);
}

async function cancelWaitlistEntry({ id, customerUserId }) {
  const entry = await db.get('SELECT * FROM waitlist WHERE id = ?', [String(id)]);
  if (!entry || entry.customer_user_id !== customerUserId) throw new Error('Entry not found.');
  if (!['waiting', 'offered'].includes(entry.status)) throw new Error('This entry can no longer be cancelled.');
  await db.update('waitlist', entry.id, { status: 'cancelled' });
  return true;
}

module.exports = {
  OFFER_TTL_MS,
  joinWaitlist, offerNextInLine, claimOffer, expireOffers,
  getWaitlistForShop, getWaitlistForCustomer, cancelWaitlistEntry,
};
