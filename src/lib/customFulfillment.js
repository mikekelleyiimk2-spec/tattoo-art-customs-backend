// Custom 48h fulfillment routing.
// Called once a custom order's deposit is paid: routes to the requested artist
// or drops it into the draft pipeline ('needs_drafts') for the 30-min draft cron.
const path = require('path');
const db = require('../db');
const config = require('../config');
const { screenText } = require('./screening');

const FULFILLMENT_STATUSES = [
  'new', 'routed_to_artist', 'needs_drafts', 'drafts_ready',
  'in_revision', 'approved', 'delivered',
];

function draftsDir(orderId) {
  return path.join(config.assetDir, 'uploads', 'custom-drafts', String(orderId));
}

function parseDrafts(order) {
  try {
    const d = JSON.parse(order.drafts_json || '[]');
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

async function routeCustomOrder(order) {
  if (!order || order.order_type !== 'custom' || order.status !== 'paid') return order;
  const cur = order.custom_status || 'new';
  if (cur !== 'new') return order; // already routed
  if (order.requested_artist_id) {
    const artist = await db.get(
      "SELECT id, email, display_name FROM users WHERE id = ? AND role = 'design_artist'",
      [order.requested_artist_id]);
    if (artist) {
      await db.update('orders', order.id, { custom_status: 'routed_to_artist' });
      await notifyArtist(order, artist);
      return { ...order, custom_status: 'routed_to_artist' };
    }
    // Requested artist is gone/invalid — fall through to the draft pipeline.
  }
  await db.update('orders', order.id, { custom_status: 'needs_drafts' });
  return { ...order, custom_status: 'needs_drafts' };
}

async function notifyArtist(order, artist) {
  const buyer = await db.get('SELECT display_name, email FROM users WHERE id = ?', [order.buyer_id]);
  const due = order.delivery_due ? new Date(order.delivery_due).toLocaleString() : 'within 48 hours';
  const subject = `Custom order ${order.id.slice(0, 8)} assigned to you`;
  const body =
    `Hi ${artist.display_name || 'artist'},\n\n` +
    `A customer requested you for a custom tattoo design (deposit paid).\n\n` +
    `Brief: ${order.custom_brief || '(no brief)'}\n\n` +
    `Delivery due: ${due}.\n\n` +
    `Reply in this thread to coordinate with ${buyer.display_name || buyer.email}.`;
  const convId = await db.insert('conversations', { subject, created_at: db.now() });
  await db.insert('conversation_participants', { conversation_id: convId, user_id: order.buyer_id });
  await db.insert('conversation_participants', { conversation_id: convId, user_id: artist.id });
  // Screen the brief before it reaches the artist — buyer briefs may contain
  // off-site contact info, which is not allowed in on-site messages.
  const screen = screenText(body);
  const msgId = await db.insert('messages', {
    conversation_id: convId, sender_id: order.buyer_id, body,
    screened: screen.ok ? 0 : 1,
    flags: JSON.stringify(screen.ok ? [] : screen.flags),
    created_at: db.now(),
  });
  if (!screen.ok) {
    await db.insert('review_queue', {
      item_type: 'message', item_id: msgId,
      reason: 'Custom-order brief to artist held: ' + screen.flags.map((f) => f.label).join(', '),
      status: 'open', created_at: db.now(),
    });
  }
  if (config.smtpConfigured()) {
    try {
      const { sendMail } = require('./mail');
      await sendMail({
        to: artist.email, subject,
        text: `A custom design order was routed to you.\n\nBrief: ${order.custom_brief || '(no brief)'}\nDelivery due: ${due}\n\nView it: ${config.baseUrl}/messages/${convId}`,
      });
    } catch (e) { console.error('artist notify email failed:', e.message); }
  }
  return convId;
}

module.exports = { FULFILLMENT_STATUSES, draftsDir, parseDrafts, routeCustomOrder, notifyArtist };
