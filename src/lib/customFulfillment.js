// Custom 48h fulfillment routing.
// Called once a custom order's deposit is paid: routes to the requested artist
// or drops it into the draft pipeline ('needs_drafts') for the 30-min draft cron.
const path = require('path');
const db = require('../db');
const config = require('../config');
const { screenText } = require('./screening');
const { recordCustomDesignerCommission, recordRushFeeSplit } = require('./commissions');
const pricing = require('./pricing');

const FULFILLMENT_STATUSES = [
  'new', 'routed_to_artist', 'needs_drafts', 'drafts_ready',
  'in_revision', 'approved', 'delivered', 'order_terminated',
];

function draftsDir(orderId) {
  return path.join(config.uploadDir, 'custom-drafts', String(orderId));
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
  // Doodle-to-tattoo orders (owner rule 2026-10-07): fulfilled by the OWNER
  // directly. Never routed into the designer assignment/commission queue —
  // no designer payout entries. recordSaleCommissions() already books these
  // (no design_id) as owner art with no designer split.
  if (order.doodle_tier) {
    await db.update('orders', order.id, { custom_status: 'owner_fulfilled' });
    return { ...order, custom_status: 'owner_fulfilled' };
  }
  if (order.requested_artist_id) {
    // users.sla_suspended is a manual-admin-only flag — automatic enforcement
    // never sets or reads it, so routing does not filter on it. Tier-2
    // commission-suspended designers ARE skipped: their orders fall through
    // to the draft pipeline.
    const { commissionSuspended } = require('./commissions');
    let artist = await db.get(
      `SELECT u.id, u.email, u.display_name FROM users u
       LEFT JOIN shop_profiles sp ON sp.user_id = u.id
       WHERE u.id = ? AND u.role IN ('design_artist','tattoo_shop','admin','head_admin')`,
      [order.requested_artist_id]);
    if (artist && await commissionSuspended(artist.id, Date.now())) artist = null;
    if (artist) {
      await db.update('orders', order.id, { custom_status: 'routed_to_artist' });
      await recordCustomDesignerCommission(order, artist.id);
      // Rush orders: book the 60/40 rush-fee split ($18 designer incentive /
      // $12 site overhead) now that the fulfiller is known.
      try { await recordRushFeeSplit(order, artist.id); }
      catch (e) { console.error('rush fee split failed:', e.message); }
      await notifyArtist(order, artist);
      return { ...order, custom_status: 'routed_to_artist' };
    }
    // Requested artist is gone/invalid — fall through to the draft pipeline.
  }
  await db.update('orders', order.id, { custom_status: 'needs_drafts' });
  // In-house pipeline fulfills: the rush incentive stays with the site (the
  // site's own design team earns it, funding the admin-pay tiers).
  try { await recordRushFeeSplit(order, null); }
  catch (e) { console.error('rush fee split failed:', e.message); }
  return { ...order, custom_status: 'needs_drafts' };
}

async function notifyArtist(order, artist) {
  const buyer = await db.get('SELECT display_name, email FROM users WHERE id = ?', [order.buyer_id]);
  const rush = (order.rush_fee_cents || 0) > 0;
  const slaText = rush ? 'within 24 hours (RUSH)' : 'within 48 hours';
  const due = order.delivery_due ? new Date(order.delivery_due).toLocaleString() : slaText;
  const subject = `${rush ? 'RUSH \u2014 ' : ''}Custom order ${order.id.slice(0, 8)} assigned to you`;
  const body =
    `Hi ${artist.display_name || 'artist'},\n\n` +
    `A customer requested you for a custom tattoo design (deposit paid).\n\n` +
    (rush ? `\u26a1 RUSH ORDER \u2014 $18 rush incentive included. Deliver within 24 hours.\n\n` : '') +
    `Brief: ${order.custom_brief || '(no brief)'}\n\n` +
    `Delivery due: ${due}.\n\n` +
    `Reply in this thread to coordinate with ${buyer.display_name || 'your customer'}.`;
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
