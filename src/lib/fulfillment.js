// Immediate digital delivery for PREMADE purchases.
// On verified payment the buyer instantly gets the clean (unwatermarked)
// files via a signed, time-limited download token — the link is shown on the
// purchase confirmation page and emailed in the receipt. Tokens are bearer
// secrets: never linked publicly, only the buyer (or an admin) can mint one
// for their own order, and each expires after 24h.
// Custom commissions keep the 48-hour draft/waiting flow and are NEVER
// auto-fulfilled here — fulfillPremadeOrder returns null for them.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { withFeeCents } = require('./pricing');
const { sendMail } = require('./mail');

const DOWNLOAD_TTL_MS = 24 * 3600 * 1000;

// Idempotent: returns the existing unexpired token for the order when one
// exists, so double-captures, retries, and re-sends never mint duplicate links.
async function issueDownloadToken(orderId) {
  const existing = await db.get(
    'SELECT * FROM downloads WHERE order_id = ? AND expires_at > ? ORDER BY created_at DESC',
    [orderId, Date.now()]
  );
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('hex');
  const id = await db.insert('downloads', {
    order_id: orderId, token, expires_at: Date.now() + DOWNLOAD_TTL_MS,
  });
  return db.get('SELECT * FROM downloads WHERE id = ?', [id]);
}

// Fulfill a paid premade order: issue the download token and email the buyer
// a receipt carrying the download link. Returns the download row, or null
// when the order is not a paid premade (customs pass through untouched).
async function fulfillPremadeOrder(order) {
  if (!order || order.order_type !== 'premade' || order.status !== 'paid' || !order.design_id) {
    return null;
  }
  const dl = await issueDownloadToken(order.id);
  const design = await db.get('SELECT title FROM designs WHERE id = ?', [order.design_id]);
  const buyer = await db.get('SELECT email, display_name FROM users WHERE id = ?', [order.buyer_id]);
  const title = design ? design.title : 'your design';
  const viewUrl = `${config.baseUrl}/orders/download/${dl.token}/view`;
  const orderUrl = `${config.baseUrl}/orders/${order.id}`;
  if (buyer && buyer.email) {
    const first = String(buyer.display_name || '').split(' ')[0] || 'there';
    const lines = [
      `Hi ${first},`,
      ``,
      `Thanks for your purchase from Tattoo Art Customs!`,
      ``,
      `Design: ${title}`,
      `Order: ${order.id.slice(0, 8)}`,
      ``,
      `Your download is ready right now — clean full files, no watermarks:`,
      viewUrl,
    ];
    if (order.linework_only) lines.push(`(Linework-only purchase: the clean linework file is included.)`);
    lines.push(
      ``,
      `This is a private link just for you and it expires in 24 hours.`,
      `You can generate a fresh link any time from your order page:`,
      orderUrl,
      ``,
      `Please don't share these files — they're licensed to you only.`,
      `— Tattoo Art Customs`
    );
    try {
      await sendMail({
        to: buyer.email,
        subject: `Your download is ready — ${title} (Tattoo Art Customs)`,
        text: lines.join('\n'),
      });
    } catch (e) {
      console.error('premade receipt email failed:', e.message);
    }
  }
  return dl;
}

// Buyer receipt for a paid custom deposit (the 50% checkout). Carries the
// "First custom — 20% off" line item when the one-time subscriber discount
// priced the order. Safe to call for any order; no-ops unless it is a paid
// custom. SMTP-absent dev/test mode just logs (sendMail handles it); a send
// failure never breaks the order flow.
async function sendCustomDepositReceipt(order) {
  if (!order || order.order_type !== 'custom' || order.status !== 'paid') return null;
  const buyer = await db.get('SELECT email, display_name FROM users WHERE id = ?', [order.buyer_id]);
  if (!buyer || !buyer.email) return null;
  const money = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;
  const first = String(buyer.display_name || '').split(' ')[0] || 'there';
  const rush = Number(order.rush_fee_cents || 0);
  const depositTotal = Number(order.deposit_cents || 0) + rush + Number(order.fee_cents || 0);
  // Balance due at delivery: the remaining 50% of the design price plus its
  // processing fee. The rush fee is fully collected with the deposit.
  const balanceDue = withFeeCents(Number(order.amount_cents || 0) - Number(order.deposit_cents || 0));
  const lines = [
    `Hi ${first},`,
    ``,
    `Your custom design request is in — deposit received!`,
    ``,
    `Order: ${order.id.slice(0, 8)}`,
  ];
  if (order.discount_applied === 'first_custom_20') {
    lines.push(`Opening sale — first custom 20% off: ${money(order.amount_cents)} (regular ${money(15574)})`);
  } else if (order.discount_applied === 'member_20') {
    lines.push(`Member discount — 20% off: ${money(order.amount_cents)} (regular ${money(15574)})`);
  } else {
    lines.push(`Design price: ${money(order.amount_cents)}`);
  }
  if (rush > 0) lines.push(`Rush (24-hour delivery): ${money(rush)}`);
  lines.push(
    `Deposit paid: ${money(depositTotal)} (includes ${money(order.fee_cents)} processing fee)`,
    `Balance of ${money(balanceDue)} due when your design is delivered (${rush > 0 ? 'within 24 hours' : 'within 48 hours'}).`,
    ``,
    `View your order: ${config.baseUrl}/orders/${order.id}`,
    ``,
    `— Tattoo Art Customs`
  );
  try {
    await sendMail({
      to: buyer.email,
      subject: `Custom deposit received — order ${order.id.slice(0, 8)} (Tattoo Art Customs)`,
      text: lines.join('\n'),
    });
  } catch (e) {
    console.error('custom deposit receipt email failed:', e.message);
  }
  return true;
}

module.exports = { fulfillPremadeOrder, issueDownloadToken, sendCustomDepositReceipt };
