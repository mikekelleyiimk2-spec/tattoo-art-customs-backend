// Art transfers: customer<->shop pipeline.
// Money-safety (non-negotiable): every transfer traces back to a PAID order.
// No free transfers, no exceptions. Favorites/wishlist shares stay watermarked
// previews until purchased — transfers only move paid art.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { sendMail } = require('./mail');

const TRANSFER_TTL_MS = 24 * 3600 * 1000; // 24h, mirrors buyer download tokens

function licenseNote(customerName) {
  return `Licensed to ${customerName || 'the purchasing customer'} for a single tattoo by the receiving shop. Single-client use only — not for resale, redistribution, or reuse on other clients.`;
}

// Create a transfer for a PAID premade order. Throws on any money-safety violation.
async function createTransfer({ orderId, fromUserId, toShopUserId, toEmail, kind }) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order || order.status !== 'paid') {
    throw new Error('Transfers are only available for paid orders.');
  }
  if (order.order_type !== 'premade' || !order.design_id) {
    throw new Error('Only paid premade design orders can be transferred.');
  }
  if (order.buyer_id !== fromUserId) {
    throw new Error('You can only transfer your own orders.');
  }
  const email = String(toEmail || '').trim().toLowerCase().slice(0, 160);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('A valid recipient email address is required.');
  }
  const customer = await db.get('SELECT display_name FROM users WHERE id = ?', [fromUserId]);
  const design = await db.get('SELECT title FROM designs WHERE id = ?', [order.design_id]);
  const token = crypto.randomBytes(24).toString('hex');
  const id = await db.insert('art_transfers', {
    order_id: orderId,
    design_id: order.design_id,
    from_user_id: fromUserId,
    to_shop_user_id: toShopUserId || null,
    to_email: email,
    kind: kind === 'to_client' ? 'to_client' : 'to_shop',
    token,
    expires_at: Date.now() + TRANSFER_TTL_MS,
    status: 'sent',
    license_note: licenseNote(customer && customer.display_name),
  });
  const transfer = await db.get('SELECT * FROM art_transfers WHERE id = ?', [id]);
  const viewUrl = `${config.baseUrl}/transfers/${token}`;
  const recipientLabel = transfer.kind === 'to_client' ? 'client' : 'shop';
  try {
    await sendMail({
      to: email,
      subject: `Tattoo design ready for download — "${design ? design.title : 'your design'}"`,
      text: [
        `Hi,`,
        ``,
        `${customer && customer.display_name ? customer.display_name : 'A Tattoo Art Customs customer'} sent you a purchased tattoo design.`,
        ``,
        `Design: ${design ? design.title : ''}`,
        `Order: ${order.id.slice(0, 8)}`,
        ``,
        `Download the clean full-color + linework files here (private link, expires in 24 hours):`,
        viewUrl,
        ``,
        transfer.license_note,
        ``,
        `— Tattoo Art Customs`,
      ].join('\n'),
    });
  } catch (e) { console.error('transfer email failed:', e.message); }
  return { transfer, viewUrl, recipientLabel };
}

// Resolve the design files for a transfer token (same clean files as buyer downloads).
async function transferFiles(token) {
  const tr = await db.get('SELECT * FROM art_transfers WHERE token = ?', [token]);
  if (!tr || tr.expires_at < Date.now()) return { error: 'expired' };
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [tr.order_id]);
  if (!order || order.status !== 'paid') return { error: 'unpaid' };
  const design = await db.get('SELECT color_path, linework_path FROM designs WHERE id = ?', [tr.design_id]);
  if (!design) return { error: 'missing' };
  if (!tr.claimed_at) {
    await db.update('art_transfers', tr.id, { status: 'claimed', claimed_at: Date.now() });
  }
  return { transfer: tr, order, design };
}

module.exports = { createTransfer, transferFiles, licenseNote, TRANSFER_TTL_MS };
