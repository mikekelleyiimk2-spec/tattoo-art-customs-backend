// Site-wide gift cards (owner rule 2026-09-30).
//
// Purchase model: denominations $25 / $50 / $75 / $100 / $150 with a flat
// $1.95 purchase fee built into the checkout price and disclosed (never
// hidden); free email delivery of the code; optional physical mail for
// +$4.95 shipping (a small profit line). The processing fee is passed
// through on the whole charge, never absorbed.
//
// Code lifecycle: 'pending' (PayPal order created, unpaid — the code does
// NOT exist yet) -> 'active' (payment cleared: unguessable single-use code
// issued and emailed) -> 'redeemed' | 'expired'. Anti-fraud: a code can
// only be activated by a completed, amount-verified capture.
//
// Redemption converts the card to site credit (kind 'gift_card'), which is
// spendable on premade designs and custom deposits through the existing
// site-credit flows, and on memberships through POST /membership/credit.
const db = require('../db');
const config = require('../config');
const pricing = require('./pricing');
const paypal = require('./paypal');
const { notifyUser } = require('./notify');
const { sendMail } = require('./mail');
const {
  generateGiftCardCode, normalizeCode,
  gcCreateCheckoutOrder, gcCaptureCheckoutOrder,
} = require('../shop/giftcards');

const SITE_GIFT_CARD_AMOUNTS = [2500, 5000, 7500, 10000, 15000];
const SITE_GIFT_CARD_FEE_CENTS = 195;      // flat purchase fee, disclosed at checkout
const SITE_GIFT_CARD_SHIPPING_CENTS = 495; // optional physical mail
const SITE_GIFT_CARD_EXPIRY_MS = 5 * 365 * 86400000; // codes valid 5 years

function validateSiteGiftCardAmount(amountCents) {
  const n = Number(amountCents);
  if (!SITE_GIFT_CARD_AMOUNTS.includes(n)) {
    throw new Error('Choose a gift card amount: $25, $50, $75, $100, or $150.');
  }
  return n;
}

// Checkout quote: amount + $1.95 fee (+ $4.95 physical shipping), then the
// processing-fee pass-through on the whole charge.
function siteGiftCardQuote(amountCents, physical) {
  const amount = validateSiteGiftCardAmount(amountCents);
  const fee = SITE_GIFT_CARD_FEE_CENTS;
  const shipping = physical ? SITE_GIFT_CARD_SHIPPING_CENTS : 0;
  const base = amount + fee + shipping;
  const processing = pricing.processingFeeCents(base);
  return { amount, fee, shipping, processing, total: base + processing };
}

async function generateUniqueSiteCode() {
  for (let i = 0; i < 25; i++) {
    const code = generateGiftCardCode();
    const hit = await db.get('SELECT id FROM site_gift_cards WHERE code = ?', [code]);
    if (!hit) return code;
  }
  throw new Error('Could not generate a unique gift card code.');
}

function giftCardEmailBody(card, code) {
  const money = pricing.money;
  return [
    `Your Tattoo Art Customs gift card is here!`,
    ``,
    `Gift card code: ${code}`,
    `Value: ${money(card.amount_cents)}`,
    ``,
    `Redeem it at ${config.baseUrl}/gift-cards/redeem — the full value becomes`,
    `site credit you can spend on premade designs, custom designs, and memberships.`,
    `The code is single-use and expires ${new Date(card.expires_at).toLocaleDateString()}.`,
  ].join('\n');
}

// Create the pending purchase row (no code yet — issued only on activation).
async function createPendingSiteGiftCard({ purchaserUserId, amountCents, recipientEmail, recipientName, physical, shipAddress }) {
  const quote = siteGiftCardQuote(amountCents, physical);
  const email = String(recipientEmail || '').trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid recipient email, or leave it blank.');
  if (physical && String(shipAddress || '').trim().length < 10) {
    throw new Error('Enter the full mailing address for the physical card.');
  }
  const id = await db.insert('site_gift_cards', {
    code: null,
    purchaser_user_id: purchaserUserId,
    recipient_email: email || null,
    recipient_name: String(recipientName || '').trim().slice(0, 120) || null,
    amount_cents: quote.amount,
    fee_cents: quote.fee,
    shipping_cents: quote.shipping,
    total_paid_cents: quote.total,
    status: 'pending',
    ship_pending: physical ? 1 : 0,
    ship_address: physical ? String(shipAddress || '').trim().slice(0, 500) : null,
    expires_at: Date.now() + SITE_GIFT_CARD_EXPIRY_MS,
    created_at: db.now(),
  });
  return { id, quote };
}

// Start the PayPal checkout for a pending card. In tests (PayPal
// unconfigured) this throws and the route falls back to a manual-payment
// path, same as the orders buy flow.
async function startSiteGiftCardCheckout({ pendingId, purchaserUserId }) {
  const card = await db.get('SELECT * FROM site_gift_cards WHERE id = ? AND purchaser_user_id = ?',
    [pendingId, purchaserUserId]);
  if (!card || card.status !== 'pending') throw new Error('Gift card purchase not found.');
  const order = await gcCreateCheckoutOrder({
    amountCents: card.total_paid_cents,
    description: `Tattoo Art Customs gift card — ${pricing.money(card.amount_cents)}`,
    returnUrl: `${config.baseUrl}/gift-cards/capture/${card.id}`,
  });
  await db.update('site_gift_cards', card.id, { paypal_order_id: order.id });
  return order;
}

// Issue the code + deliver it (shared by the PayPal-capture path and the
// admin-confirmed manual-payment path). The code is born here — never before
// payment is verified.
async function finalizeSiteGiftCardActivation(card) {
  const code = await generateUniqueSiteCode();
  await db.update('site_gift_cards', card.id, { code, status: 'active' });
  const fresh = await db.get('SELECT * FROM site_gift_cards WHERE id = ?', [card.id]);
  const purchaser = await db.get('SELECT email, display_name FROM users WHERE id = ?', [fresh.purchaser_user_id]);
  const first = String(purchaser?.display_name || '').split(' ')[0] || 'there';
  const body = giftCardEmailBody(fresh, code);
  // Email delivery is free and always attempted: recipient first, then the
  // purchaser (so the buyer always has the code to forward).
  const targets = [];
  if (fresh.recipient_email) targets.push(fresh.recipient_email);
  if (purchaser?.email && purchaser.email !== fresh.recipient_email) targets.push(purchaser.email);
  for (const to of targets) {
    try {
      await sendMail({
        to,
        subject: `Your ${pricing.money(fresh.amount_cents)} Tattoo Art Customs gift card`,
        text: `Hi ${first},\n\n${body}`,
      });
    } catch (e) { console.error('gift card email failed:', e.message); }
  }
  try {
    await notifyUser(fresh.purchaser_user_id, {
      kind: 'gift-card-purchased', title: 'Gift card purchased',
      body: `Your ${pricing.money(fresh.amount_cents)} gift card (${code}) is ready.`,
      link: '/gift-cards/mine',
    });
  } catch (e) { console.error('gift card notify failed:', e.message); }
  return fresh;
}

// Activate after payment clears: capture, verify the exact amount, issue
// the unguessable code, and email it (free delivery). Physical cards also
// queue for mailing. Idempotent — a second call returns the existing card.
async function activateSiteGiftCard({ pendingId, purchaserUserId, paypalOrderId }) {
  const card = await db.get('SELECT * FROM site_gift_cards WHERE id = ? AND purchaser_user_id = ?',
    [pendingId, purchaserUserId]);
  if (!card) throw new Error('Gift card purchase not found.');
  if (card.status === 'active') return card;
  if (card.status !== 'pending') throw new Error('This gift card purchase is no longer pending.');
  // Capture is idempotent-safe: if a previous attempt captured the money
  // but we crashed before recording it, recover from the earlier capture.
  let paidCents;
  try {
    paidCents = await gcCaptureCheckoutOrder(paypalOrderId);
  } catch (e) {
    if (!paypal.isAlreadyCapturedError(e)) throw e;
    console.error(`[site-gift-cards] already-captured recovery for pending ${pendingId}`);
    const order = await paypal.getCheckoutOrder(paypalOrderId);
    const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
    paidCents = Math.round(parseFloat(cap?.amount?.value || '0', 10) * 100);
    if (!(paidCents > 0)) {
      throw new Error('Payment was already captured but could not be verified — contact support.');
    }
  }
  if (paidCents !== card.total_paid_cents) {
    throw new Error(`Captured ${pricing.money(paidCents)} but expected ${pricing.money(card.total_paid_cents)} — card not activated.`);
  }
  await db.update('site_gift_cards', card.id, { paypal_order_id: paypalOrderId });
  return finalizeSiteGiftCardActivation(card);
}

// Admin path: the buyer paid manually (CashApp/Venmo) and an admin verified
// the payment. Activates the card without a PayPal capture.
async function activateSiteGiftCardManual(cardId) {
  const card = await db.get('SELECT * FROM site_gift_cards WHERE id = ?', [cardId]);
  if (!card) throw new Error('Gift card not found.');
  if (card.status === 'active') return card;
  if (card.status !== 'pending') throw new Error('This gift card is no longer pending.');
  return finalizeSiteGiftCardActivation(card);
}

// Redeem an active code: single-use, converts to site credit. The code is
// entered by the RECIPIENT (any logged-in user), not just the purchaser.
async function redeemSiteGiftCard({ userId, code }) {
  const norm = normalizeCode(code);
  if (!norm) throw new Error('Enter your gift card code.');
  const card = await db.get('SELECT * FROM site_gift_cards WHERE code = ?', [norm]);
  if (!card) throw new Error('That gift card code was not found — check it and try again.');
  if (card.status === 'redeemed') throw new Error('This gift card has already been redeemed.');
  if (card.status !== 'active') throw new Error('This gift card is not active yet.');
  if (card.expires_at && card.expires_at < Date.now()) {
    await db.update('site_gift_cards', card.id, { status: 'expired' });
    throw new Error('This gift card has expired.');
  }
  await db.update('site_gift_cards', card.id, {
    status: 'redeemed', redeemed_by_user_id: userId, redeemed_at: db.now(),
  });
  const { addCredit } = require('./credits');
  await addCredit({
    userId, amountCents: card.amount_cents, kind: 'gift_card', refId: card.id,
    note: `Redeemed gift card ${norm.slice(0, 4)}…${norm.slice(-4)}`,
  });
  return card;
}

async function getSiteGiftCardsForPurchaser(userId) {
  return db.all('SELECT * FROM site_gift_cards WHERE purchaser_user_id = ? ORDER BY created_at DESC', [userId]);
}

async function getUnshippedSiteGiftCards() {
  return db.all(
    `SELECT g.*, u.email AS purchaser_email FROM site_gift_cards g
     JOIN users u ON u.id = g.purchaser_user_id
     WHERE g.ship_pending = 1 AND g.shipped_at IS NULL AND g.status = 'active'
     ORDER BY g.created_at ASC`);
}

async function markSiteGiftCardShipped(cardId) {
  await db.update('site_gift_cards', cardId, { shipped_at: db.now(), ship_pending: 0 });
}

module.exports = {
  SITE_GIFT_CARD_AMOUNTS, SITE_GIFT_CARD_FEE_CENTS, SITE_GIFT_CARD_SHIPPING_CENTS,
  SITE_GIFT_CARD_EXPIRY_MS,
  validateSiteGiftCardAmount, siteGiftCardQuote, normalizeCode,
  createPendingSiteGiftCard, startSiteGiftCardCheckout, activateSiteGiftCard,
  activateSiteGiftCardManual,
  redeemSiteGiftCard, getSiteGiftCardsForPurchaser, getUnshippedSiteGiftCards,
  markSiteGiftCardShipped,
};
