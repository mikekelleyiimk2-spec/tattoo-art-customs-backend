// Gift cards (shop toolset, Phase 3).
//
// Purchase model mirrors shop bookings (src/shop/bookingFees.js): the BUYER
// pays amount + 5% platform fee + grossed-up processing. Redemption is
// fee-FREE — the full amount_cents applies against the booking balance.
//
// Code format: 12 characters, uppercase, unambiguous alphabet (no 0/O/1/I).
// Lifecycle: 'pending' (PayPal order created, unpaid — invisible to every
// query except the capture step) -> 'active' -> 'redeemed' | 'expired'.
// Gift cards are NOT shop revenue until redeemed: the receipts row records
// shop_receives_cents = 0 and kind = 'gift_card'.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { computeBookingFees } = require('./bookingFees');
const { money } = require('../lib/pricing');
const paypal = require('../lib/paypal');
const { notifyUser } = require('../lib/notify');
const { sendMail } = require('../lib/mail');

const GIFT_CARD_AMOUNTS = [2500, 5000, 10000]; // $25 / $50 / $100 presets
const MIN_CUSTOM_CENTS = 1000;   // $10
const MAX_CUSTOM_CENTS = 50000;  // $500
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function generateGiftCardCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

async function generateUniqueCode() {
  for (let i = 0; i < 25; i++) {
    const code = generateGiftCardCode();
    const hit = await db.get('SELECT id FROM gift_cards WHERE code = ?', [code]);
    if (!hit) return code;
  }
  throw new Error('Could not generate a unique gift card code.');
}

// Fee math for a gift-card purchase: buyer total = amount + 5% + processing.
function giftCardFees(amountCents) {
  return computeBookingFees(amountCents);
}

function giftCardReceiptLines(fees) {
  return [
    `Gift card value: ${money(fees.base)}`,
    `Platform fee (5%): ${money(fees.platformFee)} (non-refundable)`,
    `Processing: ${money(fees.processing)}`,
    `Total charged: ${money(fees.total)}`,
    'Note: the shop receives this value when the card is redeemed, not at purchase.',
  ];
}

function validateAmount(amountCents) {
  if (!Number.isInteger(amountCents)) throw new Error('Pick a gift card amount.');
  if (GIFT_CARD_AMOUNTS.includes(amountCents)) return amountCents;
  if (amountCents >= MIN_CUSTOM_CENTS && amountCents <= MAX_CUSTOM_CENTS) return amountCents;
  throw new Error(`Custom amounts must be between ${money(MIN_CUSTOM_CENTS)} and ${money(MAX_CUSTOM_CENTS)}.`);
}

// Test-only checkout shim (offline support without touching paypal.js).
// With TAC_TEST_PAYPAL_STUB=1 the PayPal order + capture are fabricated
// locally in the canned stub shape; production always goes through
// src/lib/paypal.js. The shim lives HERE and not in paypal.js because the
// existing orders.js buy flow depends on paypal.createCheckoutOrder
// throwing when PayPal is unconfigured (the suite asserts the manual-payment
// fallback) — a global stub would break that contract.
const stubGcOrders = new Map();
let stubGcSeq = 0;

async function gcCreateCheckoutOrder({ amountCents, description, returnUrl }) {
  if (process.env.TAC_TEST_PAYPAL_STUB === '1') {
    stubGcSeq += 1;
    const id = `GC-ORDER-STUB-${stubGcSeq}`;
    stubGcOrders.set(id, amountCents);
    // ?token= mirrors PayPal's real return behavior (order id appended to
    // return_url), so the capture step can echo the exact amount back.
    return { id, approveUrl: `https://paypal.test/approve/stub?token=${id}` };
  }
  const pp = await paypal.createCheckoutOrder({
    amountCents, description, returnUrl, cancelUrl: `${config.baseUrl}/giftcards/buy`,
  });
  const approve = (pp.links || []).find((l) => l.rel === 'approve');
  if (!approve) throw new Error('PayPal did not return an approval link.');
  return { id: pp.id, approveUrl: approve.href };
}

// Returns the captured total in cents.
async function gcCaptureCheckoutOrder(paypalOrderId) {
  if (process.env.TAC_TEST_PAYPAL_STUB === '1') {
    const amountCents = stubGcOrders.get(String(paypalOrderId || ''));
    if (amountCents == null) throw new Error(`PayPal stub: unknown order ${paypalOrderId}`);
    return amountCents;
  }
  const capture = await paypal.captureCheckoutOrder(paypalOrderId);
  const captured = capture.purchase_units?.[0]?.payments?.captures?.[0];
  return Math.round(parseFloat(captured?.amount?.value || '0') * 100);
}

// Step 1 of purchase: validate + create the pending row + PayPal order.
// Returns { pendingId, code, fees, approveUrl }.
async function createPendingGiftCard({ purchaserUserId, amountCents, recipientEmail, shopUserId }) {
  const amount = validateAmount(amountCents);
  const email = String(recipientEmail || '').trim().slice(0, 200) || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That recipient email does not look valid.');
  let shopId = null;
  if (shopUserId) {
    const shop = await db.get("SELECT id FROM users WHERE id = ? AND role = 'tattoo_shop'", [String(shopUserId)]);
    if (!shop) throw new Error('That shop was not found.');
    shopId = shop.id;
  }
  const fees = giftCardFees(amount);
  const code = await generateUniqueCode();
  const pendingId = await db.insert('gift_cards', {
    code, purchaser_user_id: purchaserUserId, recipient_email: email,
    amount_cents: fees.base, platform_fee_cents: fees.platformFee,
    processing_cents: fees.processing, total_paid_cents: 0,
    status: 'pending', shop_user_id: shopId, redeemed_booking_id: null,
    expires_at: null,
  });
  let order;
  try {
    order = await gcCreateCheckoutOrder({
      amountCents: fees.total,
      description: `Tattoo Art Customs gift card — ${money(fees.base)}`,
      returnUrl: `${config.baseUrl}/giftcards/capture/${pendingId}`,
    });
  } catch (e) {
    await db.update('gift_cards', pendingId, { status: 'abandoned' });
    throw new Error('PayPal checkout is unavailable right now — please try again later.');
  }
  return { pendingId, code, fees, approveUrl: order.approveUrl };
}

// Step 2 of purchase: capture the PayPal order, activate the card, receipt,
// and email the code to the purchaser (+ the recipient when one was given).
// Throws when the captured total does not match the fee math.
async function activateGiftCard({ pendingId, purchaserUserId, paypalOrderId }) {
  const row = await db.get(
    'SELECT * FROM gift_cards WHERE id = ? AND purchaser_user_id = ?', [pendingId, purchaserUserId]);
  if (!row) throw new Error('Gift card purchase not found.');
  if (row.status === 'active') return { code: row.code, amount_cents: row.amount_cents, already: true };
  if (row.status !== 'pending') throw new Error('This gift card purchase is no longer pending.');
  const paidCents = await gcCaptureCheckoutOrder(paypalOrderId);
  const fees = giftCardFees(row.amount_cents);
  if (paidCents !== fees.total) {
    throw new Error(`Captured ${money(paidCents)} but expected ${money(fees.total)} — card not activated.`);
  }
  await db.update('gift_cards', row.id, {
    status: 'active', platform_fee_cents: fees.platformFee,
    processing_cents: fees.processing, total_paid_cents: fees.total,
  });
  await db.insert('receipts', {
    booking_id: null, gift_card_id: row.id, kind: 'gift_card',
    lines_json: JSON.stringify(giftCardReceiptLines(fees)),
    // Gift cards are not shop revenue until redeemed.
    shop_receives_cents: 0, customer_total_cents: fees.total,
  });
  const purchaser = await db.get('SELECT email, display_name FROM users WHERE id = ?', [purchaserUserId]);
  const codeText = `Your Tattoo Art Customs gift card code is: ${row.code}\n` +
    `Value: ${money(row.amount_cents)}. ` +
    (row.shop_user_id ? 'It can be redeemed at the shop it was bought for.\n' : 'It can be redeemed at any shop on Tattoo Art Customs.\n') +
    `Redeem it when booking: ${config.baseUrl}/giftcards/redeem`;
  await notifyUser(purchaserUserId, {
    kind: 'gift-card-purchased', title: 'Gift card purchased',
    body: `Your ${money(row.amount_cents)} gift card (${row.code}) is ready.`,
    link: '/giftcards/redeem',
  });
  if (purchaser && purchaser.email) {
    await sendMail({
      to: purchaser.email, subject: `Your ${money(row.amount_cents)} Tattoo Art Customs gift card`,
      text: `Hi ${purchaser.display_name || 'there'},\n\n${codeText}`,
    });
  }
  if (row.recipient_email && row.recipient_email !== (purchaser && purchaser.email)) {
    await sendMail({
      to: row.recipient_email, subject: `You received a ${money(row.amount_cents)} Tattoo Art Customs gift card!`,
      text: `Someone sent you a Tattoo Art Customs gift card!\n\n${codeText}`,
    });
  }
  return { code: row.code, amount_cents: row.amount_cents };
}

// Redemption is fee-FREE: the full amount_cents applies against the booking.
// Returns { amount_cents, giftCardId }. Throws on any validation failure.
// Runs in a transaction with a row lock so two concurrent redeems cannot
// both succeed (double-redeem rejected).
async function redeemGiftCard({ code, bookingId, customerUserId }) {
  const clean = normalizeCode(code);
  if (!clean) throw new Error('Enter a gift card code.');
  return db.transaction(async (tx) => {
    const lock = db.getMode() === 'pg' ? ' FOR UPDATE' : '';
    const gc = await tx.get(`SELECT * FROM gift_cards WHERE code = ?${lock}`, [clean]);
    if (!gc || gc.status !== 'active') throw new Error('That gift card code is not valid or has already been used.');
    if (gc.expires_at && gc.expires_at <= Date.now()) {
      await tx.query("UPDATE gift_cards SET status = 'expired' WHERE id = ?", [gc.id]);
      throw new Error('That gift card has expired.');
    }
    const booking = await tx.get('SELECT * FROM bookings WHERE id = ?', [String(bookingId)]);
    if (!booking) throw new Error('Booking not found.');
    if (booking.customer_user_id !== customerUserId) throw new Error('That booking is not yours.');
    if (booking.status === 'cancelled') throw new Error('That booking was cancelled.');
    if (booking.status === 'completed') throw new Error('That booking is already completed.');
    if (gc.shop_user_id && gc.shop_user_id !== booking.shop_user_id) {
      throw new Error('That gift card is only redeemable at the shop it was bought for.');
    }
    await tx.query(
      "UPDATE gift_cards SET status = 'redeemed', redeemed_booking_id = ? WHERE id = ? AND status = 'active'",
      [booking.id, gc.id]);
    return { amount_cents: gc.amount_cents, giftCardId: gc.id };
  });
}

async function getGiftCardsForShop(shopUserId) {
  return db.all(
    `SELECT g.*, u.display_name AS purchaser_name
     FROM gift_cards g LEFT JOIN users u ON u.id = g.purchaser_user_id
     WHERE g.shop_user_id = ? AND g.status NOT IN ('pending', 'abandoned')
     ORDER BY g.created_at DESC`, [shopUserId]);
}

async function getGiftCardsForPurchaser(userId) {
  return db.all(
    "SELECT * FROM gift_cards WHERE purchaser_user_id = ? AND status NOT IN ('pending', 'abandoned') ORDER BY created_at DESC",
    [userId]);
}

module.exports = {
  GIFT_CARD_AMOUNTS, MIN_CUSTOM_CENTS, MAX_CUSTOM_CENTS,
  normalizeCode, generateGiftCardCode, generateUniqueCode,
  giftCardFees, giftCardReceiptLines, validateAmount,
  createPendingGiftCard, activateGiftCard, redeemGiftCard,
  getGiftCardsForShop, getGiftCardsForPurchaser,
};
