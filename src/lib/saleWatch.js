// First-sale watcher: verifies the money machinery on every paid order and
// every newly-active paid subscription, and reports to the owner.
// The first 5 paid orders get a deep verification report (commission ledger
// integrity vs. the net sale, buyer download readiness, custom routing,
// fulfillment state); every sale after that gets a brief owner notification.
// Runs in production, called from each paid path: PayPal capture, admin
// manual confirm, site-credit payment, subscription activation (/approve +
// webhook). All notifications are best-effort and never break checkout.
const db = require('../db');
const config = require('../config');
const { sendMail } = require('./mail');
const { money } = require('./pricing');

const DEEP_VERIFY_SALES = 5;

async function tellOwner({ title, body, link, emailSubject }) {
  try {
    // In-app + email to every admin AND push (notifyAdmins pushes to admins'
    // browsers/phones) — the owner sees the first sales immediately.
    await require('./notify').notifyAdmins({ kind: 'sale', title, body, link: link || '/admin/orders' });
  } catch (e) { console.error('saleWatch notify failed:', e.message); }
  try {
    if (config.adminEmail) await sendMail({ to: config.adminEmail, subject: emailSubject || title, text: body });
  } catch (e) { console.error('saleWatch email failed:', e.message); }
}

async function watchOrderPaid(order) {
  try {
    const o = await db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
    if (!o || o.status !== 'paid') return;
    const paidCount = (await db.get("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'")).n;
    const ledger = await db.all(
      'SELECT recipient_type, recipient_id, amount_cents, status FROM commission_ledger WHERE order_id = ?', [o.id]);
    // Commissions are computed on the net sale (fee excluded) and the ledger
    // always sums exactly to it (recordSaleCommissions plugs rounding).
    const net = Math.max(0, (o.amount_paid_cents || 0) - (o.fee_cents || 0));
    const ledgerSum = ledger.reduce((s, r) => s + (r.amount_cents || 0), 0);
    const buyer = await db.get('SELECT email, display_name FROM users WHERE id = ?', [o.buyer_id]);
    const design = o.design_id ? await db.get('SELECT title, artist_id FROM designs WHERE id = ?', [o.design_id]) : null;
    const artist = design && design.artist_id
      ? await db.get('SELECT display_name, email FROM users WHERE id = ?', [design.artist_id]) : null;
    const problems = [];
    if (!ledger.length) problems.push('NO commission ledger rows — the money has nowhere to go');
    else if (ledgerSum !== net) problems.push(`ledger sums to ${money(ledgerSum)} but the net sale is ${money(net)}`);
    for (const r of ledger) {
      if (r.amount_cents == null || r.amount_cents < 0) {
        problems.push(`bad ledger row: ${r.recipient_type} ${r.amount_cents}`);
      } else if (!r.recipient_id && r.recipient_type !== 'site') {
        // 'site' rows legitimately carry no recipient; everyone else must.
        problems.push(`ledger row with no recipient: ${r.recipient_type}`);
      }
    }
    let fulfillment;
    if (o.order_type === 'custom') {
      const routed = !!o.designer_id;
      fulfillment = `custom_status=${o.custom_status || '?'}` + (routed ? ', designer assigned' : ', NO designer assigned yet');
      if (!routed) problems.push('custom order paid but not routed to a designer yet');
    } else {
      const dl = await db.get('SELECT COUNT(*) AS n FROM downloads WHERE order_id = ?', [o.id]);
      fulfillment = (dl && dl.n > 0) ? 'download token(s) already issued' : 'no download token yet — buyer mints it from the order page';
    }
    const item = o.order_type === 'custom'
      ? 'custom design deposit (50%)'
      : `premade "${design ? design.title : o.design_id || '?'}" by ${artist ? (artist.display_name || artist.email) : 'site'}`;
    const lines = [
      `Sale #${paidCount}: ${money(o.amount_paid_cents)} paid via ${o.payment_method || '?'}`,
      `Item: ${item}`,
      `Buyer: ${buyer ? (buyer.display_name || buyer.email) : o.buyer_id}`,
      `Net for splits (fee excluded): ${money(net)}`,
      'Commissions:',
      ...ledger.map((r) => `  - ${r.recipient_type} ${String(r.recipient_id).slice(0, 8)}: ${money(r.amount_cents)} (${r.status})`),
      `Fulfillment: ${fulfillment}`,
    ];
    if (problems.length) lines.push('', 'PROBLEMS:', ...problems.map((p) => `  ! ${p}`));
    const deep = paidCount <= DEEP_VERIFY_SALES;
    await tellOwner({
      title: deep ? `SALE #${paidCount} — verify: ${money(o.amount_paid_cents)} ${o.order_type}` : `Sale: ${money(o.amount_paid_cents)} — ${o.order_type} (${o.payment_method || '?'})`,
      body: lines.join('\n'),
      link: '/admin/orders',
      emailSubject: `${problems.length ? '[ACTION NEEDED] ' : ''}Tattoo Art Customs sale #${paidCount}: ${money(o.amount_paid_cents)}${deep ? ' — please verify' : ''}`,
    });
  } catch (e) { console.error('saleWatch order failed:', e.message); }
}

async function watchSubscriptionActive(sub) {
  try {
    const s = await db.get(
      `SELECT s.*, p.slug AS plan_slug FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = ?`, [sub.id]);
    if (!s || s.status !== 'active') return;
    const user = await db.get('SELECT email, display_name FROM users WHERE id = ?', [s.user_id]);
    const activeCount = (await db.get("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'")).n;
    await tellOwner({
      title: `New paid membership: ${s.plan_slug} — ${user ? (user.display_name || user.email) : s.user_id}`,
      body: [
        `Plan: ${s.plan_slug}`,
        `Member: ${user ? `${user.display_name || ''} <${user.email}>` : s.user_id}`,
        `PayPal: ${s.paypal_subscription_id || 'manual'}`,
        `Active paid subscriptions: ${activeCount}`,
      ].join('\n'),
      link: '/admin/members',
      emailSubject: `Tattoo Art Customs: new ${s.plan_slug} subscriber`,
    });
  } catch (e) { console.error('saleWatch subscription failed:', e.message); }
}

module.exports = { watchOrderPaid, watchSubscriptionActive, DEEP_VERIFY_SALES };
