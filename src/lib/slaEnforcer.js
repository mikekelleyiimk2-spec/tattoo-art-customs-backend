// SLA enforcement for custom design orders (48h delivery deadline).
//
// Penalty rules (owner-defined):
// - Days 1-4 past deadline: designer's commission reduced by 3.7% of the
//   ORIGINAL commission per day.
// - Days 5-7 past deadline: reduced by 4.3% of the original commission per day.
// - Each day's deduction splits: 2 percentage points of the original
//   commission -> site owner (payable commission balance); the remainder ->
//   purchaser as SITE CREDIT ("late-delivery credit"). Never a cash refund.
// - Cumulative per day; idempotent via sla_penalties (one row per order+day)
//   mirrored on orders.late_penalty_days.
// - Day 7: designer's contract terminated (users.sla_suspended = 1 — they
//   cannot take new custom orders pending admin review); admins + purchaser
//   notified; order.replacement_status = 'offered' for the admin to resolve.
const db = require('../db');
const config = require('../config');
const { addCredit } = require('./credits');
const { recordCustomDesignerCommission } = require('./commissions');

const DAY_MS = 86400000;
const TERMINATION_DAY = 7;
// % of the designer's ORIGINAL commission deducted per late day.
function rateForDay(d) { return d <= 4 ? 0.037 : 0.043; }
// Of each day's deducted points, 2 pts go to the owner; the rest -> buyer credit.
const OWNER_PTS = 0.02;

function daysLate(order, now) {
  if (!order || !order.delivery_due) return 0;
  return Math.max(0, Math.floor((now - order.delivery_due) / DAY_MS));
}

function isCustomOpenWhere() {
  return `order_type = 'custom' AND status = 'paid' AND custom_status NOT IN ('delivered')`;
}

async function ownerUserId() {
  if (!config.adminEmail) return null;
  const u = await db.get('SELECT id FROM users WHERE email = ?', [config.adminEmail.toLowerCase()]);
  return u ? u.id : null;
}

// The designer's commission ledger row for this order (the penalty base).
async function designerRow(order, designerId) {
  let row = await db.get(
    `SELECT * FROM commission_ledger WHERE order_id = ? AND recipient_type = 'artist' AND recipient_id = ?`,
    [order.id, designerId]);
  if (!row) {
    await recordCustomDesignerCommission(order, designerId);
    row = await db.get(
      `SELECT * FROM commission_ledger WHERE order_id = ? AND recipient_type = 'artist' AND recipient_id = ?`,
      [order.id, designerId]);
  }
  return row;
}

// The ORIGINAL commission = amount recorded before any penalties. Read from
// the first penalty row when penalties exist (robust even if the live row was
// already paid out and could not be reduced).
async function originalCommission(order, designerId) {
  const first = await db.get(
    `SELECT original_cents FROM sla_penalties WHERE order_id = ? ORDER BY day_number ASC LIMIT 1`,
    [order.id]);
  if (first) return first.original_cents;
  const row = await designerRow(order, designerId);
  return row ? row.amount_cents : 0;
}

// Charge a single late day. Idempotent — returns null if already charged.
async function chargeDay(order, designerId, day, now) {
  const done = await db.get(
    `SELECT id FROM sla_penalties WHERE order_id = ? AND day_number = ?`, [order.id, day]);
  if (done) return null;
  const original = await originalCommission(order, designerId);
  if (original <= 0) return null;
  const deduction = Math.round(original * rateForDay(day));
  const ownerShare = Math.round(original * OWNER_PTS);
  const creditShare = Math.max(0, deduction - ownerShare);
  if (deduction <= 0) return null;

  const row = await designerRow(order, designerId);
  if (row && row.status !== 'paid') {
    // Reduce the designer's live commission. Already-paid rows cannot be
    // clawed back — the penalty is still recorded and the owner/buyer shares
    // are still granted (the site absorbs the difference).
    await db.update('commission_ledger', row.id, {
      amount_cents: Math.max(0, row.amount_cents - deduction),
    });
  }
  const ownerId = await ownerUserId();
  if (ownerShare > 0) {
    await db.insert('commission_ledger', {
      order_id: order.id, recipient_type: 'site', recipient_id: ownerId,
      amount_cents: ownerShare, status: ownerId ? 'payable' : 'site_kept', created_at: now,
    });
  }
  if (creditShare > 0) {
    await addCredit({
      userId: order.buyer_id, amountCents: creditShare, kind: 'late_delivery_credit',
      refId: order.id,
      note: `Late-delivery credit — custom order ${order.id.slice(0, 8)} ${day}d late`,
    });
  }
  await db.insert('sla_penalties', {
    order_id: order.id, day_number: day, designer_id: designerId,
    original_cents: original, deduction_cents: deduction,
    owner_cents: ownerShare, credit_cents: creditShare, created_at: now,
  });
  await db.update('orders', order.id, { late_penalty_days: day });
  return { day, deduction_cents: deduction, owner_cents: ownerShare, credit_cents: creditShare };
}

// Day-7: terminate the designer's contract, flag the order for replacement.
async function terminateDesigner(order, designerId, now) {
  await db.update('users', designerId, { sla_suspended: 1 });
  await db.update('orders', order.id, {
    designer_contract_terminated: 1, replacement_status: 'offered',
  });
  const buyer = await db.get('SELECT email, display_name FROM users WHERE id = ?', [order.buyer_id]);
  const designer = await db.get('SELECT display_name FROM users WHERE id = ?', [designerId]);
  const ownerId = await ownerUserId();
  const subject = `Your custom order ${order.id.slice(0, 8)} — 7 days overdue`;
  const body =
    `Hi ${buyer.display_name || 'there'},\n\n` +
    `Your custom tattoo design order is now 7 days past its 48-hour delivery deadline. ` +
    `The assigned designer (${designer.display_name || 'the artist'}) has been removed from the job.\n\n` +
    `You choose what happens next — reply here or contact us:\n` +
    `1. A new designer takes the job (fresh 48-hour deadline)\n` +
    `2. The site owner makes your design personally\n` +
    `3. Website credit for a replacement design\n` +
    `4. Equivalent value in pre-made designs + edits\n\n` +
    `Late-delivery credits already added to your account remain yours. All sales are final — no cash refunds.`;
  const convId = await db.insert('conversations', { subject, created_at: now });
  await db.insert('conversation_participants', { conversation_id: convId, user_id: order.buyer_id });
  if (ownerId) await db.insert('conversation_participants', { conversation_id: convId, user_id: ownerId });
  await db.insert('messages', {
    conversation_id: convId, sender_id: ownerId || order.buyer_id,
    body, screened: 0, flags: '[]', created_at: now,
  });
  if (config.smtpConfigured()) {
    try {
      const { sendMail } = require('./mail');
      await sendMail({ to: buyer.email, subject, text: body + `\n\n${config.baseUrl}/messages/${convId}` });
    } catch (e) { console.error('termination email failed:', e.message); }
  }
  return { order_id: order.id, designer_id: designerId };
}

// Apply all uncharged daily penalties. Idempotent.
async function applyPenalties({ now = Date.now() } = {}) {
  const orders = await db.all(
    `SELECT * FROM orders WHERE ${isCustomOpenWhere()}
     AND delivery_due IS NOT NULL AND delivery_due < ?
     AND COALESCE(late_penalty_days, 0) < ?`,
    [now, TERMINATION_DAY]);
  const result = { processed: 0, penalties: [], terminations: [] };
  for (const order of orders) {
    const designerId = order.requested_artist_id;
    if (!designerId) continue; // draft pipeline / owner — no designer commission to penalize
    const target = Math.min(daysLate(order, now), TERMINATION_DAY);
    const charged = order.late_penalty_days || 0;
    let changed = false;
    for (let d = charged + 1; d <= target; d++) {
      const p = await chargeDay(order, designerId, d, now);
      if (p) { result.penalties.push({ order_id: order.id, designer_id: designerId, ...p }); changed = true; }
    }
    if (changed) result.processed++;
    if (target >= TERMINATION_DAY && !order.designer_contract_terminated) {
      const t = await terminateDesigner(order, designerId, now);
      result.terminations.push(t);
    }
  }
  return result;
}

// --- Reminders ---

function reminderKeyFor(order, now) {
  const late = daysLate(order, now);
  if (late >= 1 && late <= TERMINATION_DAY) return 'late_' + late;
  const msLeft = (order.delivery_due || now) - now;
  if (msLeft <= 0) return 'due_now'; // <24h past due
  if (msLeft <= 24 * 3600 * 1000) return 'warn_24h';
  return null;
}

function reminderCopy(key, order, penaltyCents) {
  const id8 = order.id.slice(0, 8);
  const due = order.delivery_due ? new Date(order.delivery_due).toLocaleString() : 'ASAP';
  const n = key.startsWith('late_') ? parseInt(key.slice(5), 10) : 0;
  const rate = n >= 1 ? (n <= 4 ? '3.7%' : '4.3%') : null;
  const heads = {
    warn_24h: `Custom order ${id8} — due in under 24 hours`,
    due_now: `Custom order ${id8} — delivery deadline reached`,
  };
  const subject = heads[key] || `Custom order ${id8} — ${n} day${n === 1 ? '' : 's'} overdue`;
  let body;
  if (key === 'warn_24h') {
    body = `Heads up: custom order ${id8} is due within 24 hours (deadline: ${due}). ` +
      `Please deliver the finished design now — late delivery costs you 3.7% of your commission per day for the first 4 days, then 4.3% per day.`;
  } else if (key === 'due_now') {
    body = `The 48-hour deadline for custom order ${id8} has been reached (${due}). ` +
      `Deliver immediately — every late day now reduces your commission (3.7%/day for days 1-4, 4.3%/day for days 5-7).`;
  } else if (n <= 4) {
    body = `Custom order ${id8} is ${n} day${n === 1 ? '' : 's'} overdue. ` +
      `Your commission has been reduced by ${rate} per late day so far ` +
      `($${(penaltyCents / 100).toFixed(2)} total). Deliver now to stop further penalties. ` +
      `At 7 days overdue your contract for this job is terminated.`;
  } else {
    body = `FINAL WARNING: custom order ${id8} is ${n} days overdue. ` +
      `Penalties are now ${rate} of your commission per day ` +
      `($${(penaltyCents / 100).toFixed(2)} total deducted). ` +
      `At 7 days overdue your designer contract is terminated and the buyer chooses a replacement. Deliver immediately.`;
  }
  return { subject, body: body + `\n\nBrief: ${(order.custom_brief || '(no brief)').slice(0, 300)}` };
}

// Send every due artist reminder. Idempotent per order+key.
async function sendDueReminders({ now = Date.now() } = {}) {
  const orders = await db.all(
    `SELECT o.*, u.email AS artist_email, u.display_name AS artist_name FROM orders o
     JOIN users u ON u.id = o.requested_artist_id
     WHERE ${isCustomOpenWhere()} AND o.delivery_due IS NOT NULL`);
  const sent = [];
  for (const order of orders) {
    const key = reminderKeyFor(order, now);
    if (!key) continue;
    const done = await db.get(
      `SELECT id FROM sla_reminders WHERE order_id = ? AND reminder_key = ?`, [order.id, key]);
    if (done) continue;
    const pen = await db.get(
      `SELECT COALESCE(SUM(deduction_cents),0) AS t FROM sla_penalties WHERE order_id = ?`, [order.id]);
    const { subject, body } = reminderCopy(key, order, pen.t);
    const ownerId = await ownerUserId();
    const convId = await db.insert('conversations', { subject, created_at: now });
    await db.insert('conversation_participants', { conversation_id: convId, user_id: order.requested_artist_id });
    if (ownerId) await db.insert('conversation_participants', { conversation_id: convId, user_id: ownerId });
    await db.insert('messages', {
      conversation_id: convId, sender_id: ownerId || order.requested_artist_id,
      body, screened: 0, flags: '[]', created_at: now,
    });
    await db.insert('sla_reminders', { order_id: order.id, reminder_key: key, created_at: now });
    if (config.smtpConfigured() && order.artist_email) {
      try {
        const { sendMail } = require('./mail');
        await sendMail({ to: order.artist_email, subject, text: body + `\n\n${config.baseUrl}/messages/${convId}` });
      } catch (e) { console.error('reminder email failed:', e.message); }
    }
    sent.push({ order_id: order.id, key });
  }
  return sent;
}

// Watchlist for the "keep bugging us" report: at-risk (<24h left) + overdue.
async function slaWatchlist({ now = Date.now() } = {}) {
  const rows = await db.all(
    `SELECT o.*, u.display_name AS artist_name FROM orders o
     LEFT JOIN users u ON u.id = o.requested_artist_id
     WHERE ${isCustomOpenWhere()} AND o.delivery_due IS NOT NULL
     ORDER BY o.delivery_due ASC`);
  const atRisk = [], overdue = [];
  for (const o of rows) {
    const pen = await db.get(
      `SELECT COALESCE(SUM(deduction_cents),0) AS t FROM sla_penalties WHERE order_id = ?`, [o.id]);
    const info = {
      id: o.id, brief: (o.custom_brief || '').slice(0, 80),
      artist: o.artist_name || '(draft pipeline / owner)',
      status: (o.custom_status || '').replace(/_/g, ' '),
      penalty_cents: pen.t, terminated: !!o.designer_contract_terminated,
      replacement: o.replacement_status || null,
    };
    const late = daysLate(o, now);
    if (late > 0) overdue.push({ ...info, days_late: Math.min(late, TERMINATION_DAY) });
    else if (o.delivery_due - now <= 24 * 3600 * 1000) {
      atRisk.push({ ...info, hours_left: Math.max(0, Math.floor((o.delivery_due - now) / 3600000)) });
    }
  }
  return { atRisk, overdue };
}

async function penaltyLedger(orderId) {
  return db.all(`SELECT * FROM sla_penalties WHERE order_id = ? ORDER BY day_number ASC`, [orderId]);
}

module.exports = {
  DAY_MS, TERMINATION_DAY, rateForDay, OWNER_PTS,
  daysLate, applyPenalties, sendDueReminders, slaWatchlist,
  penaltyLedger, terminateDesigner, originalCommission, designerRow,
};
