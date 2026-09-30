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

module.exports = { fulfillPremadeOrder, issueDownloadToken, DOWNLOAD_TTL_MS };
