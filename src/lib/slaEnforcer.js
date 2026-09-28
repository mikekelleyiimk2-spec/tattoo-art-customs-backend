// SLA enforcement for custom design orders (48h delivery deadline).
//
// Penalty rules (owner-defined):
// - Days 1-4 past deadline: designer's commission reduced by 3.7% of the
//   ORIGINAL commission per day.
// - Days 5-7 past deadline: reduced by 4.3% of the original commission per day.
// - Each day's deduction splits: 2 percentage points of the original
//   commission -> site owner (payable commission balance); the remainder ->
//   purchaser as SITE CREDIT ("late-delivery apology credit"). Never a cash
//   refund (all sales final).
// - Cumulative per day; idempotent via sla_penalties (one row per order+day)
//   mirrored on orders.late_penalty_days.
// - REPEAT OFFENDERS: a "missed deadline" is an order that hit day-7 order
//   termination (orders.deadline_missed). More than 3 misses in the trailing
//   30 days doubles the designer's late-penalty rates (7.4%/day days 1-4,
//   8.6%/day days 5-7; same 2pts/day owner split, remainder to buyer credit).
//   Status lifts automatically when the trailing-30-day count drops to 3 or
//   fewer. An admin "forgive" (users.sla_forgiven_at) resets the count.
// - Day 7: the ORDER is terminated (designer's assignment on that order ends;
//   custom_status = 'order_terminated', replacement offered to the buyer).
//   The designer's account, subscription, and membership are NEVER touched
//   automatically — users.sla_suspended is a manual-admin-only flag.
//
// Tone: every message below is firm about deadlines but professional and
// warm — the site must feel legitimate, and buyers/artists should feel
// welcomed and appreciated. Buyer credits are framed as apology credits.
const db = require('../db');
const config = require('../config');
const { addCredit } = require('./credits');
const {
  recordCustomDesignerCommission, ownerUserId, missTimes,
  refreshCommissionSuspensions,
} = require('./commissions');

const DAY_MS = 86400000;
const TERMINATION_DAY = 7;
const REPEAT_WINDOW_MS = 30 * DAY_MS;
const REPEAT_OFFENDER_MISSES = 3; // more than this in 30 days -> 2x rates
const REPEAT_MULT = 2;
// % of the designer's ORIGINAL commission deducted per late day (x mult).
function rateForDay(d, mult = 1) { return (d <= 4 ? 0.037 : 0.043) * mult; }
function rateLabel(d, mult = 1) {
  const pct = ((d <= 4 ? 3.7 : 4.3) * mult).toFixed(1).replace(/\.0$/, '');
  return mult > 1 ? `${pct}% (doubled)` : `${pct}%`;
}
// Of each day's deducted points, 2 pts go to the owner; the rest -> buyer credit.
const OWNER_PTS = 0.02;
// Plain, neutral repeat-offender notice (also rendered on the artist banner).
const REPEAT_OFFENDER_NOTICE =
  'Late penalties are currently doubled because 4+ deadlines were missed in the last 30 days.';

function daysLate(order, now) {
  if (!order || !order.delivery_due) return 0;
  return Math.max(0, Math.floor((now - order.delivery_due) / DAY_MS));
}

function isCustomOpenWhere() {
  return `order_type = 'custom' AND status = 'paid' AND custom_status NOT IN ('delivered')`;
}

// --- Repeat-offender escalator ---

// Miss timestamps (desc) for this designer inside the trailing-30-day window,
// ignoring anything at/before an admin forgiveness.
async function missTimes30d(designerId, now) {
  return missTimes(designerId, now, REPEAT_WINDOW_MS);
}

async function repeatOffenderInfo(designerId, now) {
  const times = await missTimes30d(designerId, now);
  const misses = times.length;
  if (misses <= REPEAT_OFFENDER_MISSES) return { active: false, misses, liftsAt: null };
  // Status lifts when the count drops back to 3 — i.e. when the 4th-newest
  // miss ages out of the 30-day window.
  return { active: true, misses, liftsAt: times[REPEAT_OFFENDER_MISSES] + REPEAT_WINDOW_MS };
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
// mult is 2 while the designer is a repeat offender, else 1.
async function chargeDay(order, designerId, day, now, mult = 1) {
  const done = await db.get(
    `SELECT id FROM sla_penalties WHERE order_id = ? AND day_number = ?`, [order.id, day]);
  if (done) return null;
  const original = await originalCommission(order, designerId);
  if (original <= 0) return null;
  const deduction = Math.round(original * rateForDay(day, mult));
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
      note: `Our apology — late-delivery credit for custom order ${order.id.slice(0, 8)} (${day}d late)`,
    });
  }
  await db.insert('sla_penalties', {
    order_id: order.id, day_number: day, designer_id: designerId,
    original_cents: original, deduction_cents: deduction,
    owner_cents: ownerShare, credit_cents: creditShare,
    rate_mult: mult, created_at: now,
  });
  await db.update('orders', order.id, { late_penalty_days: day });
  return {
    day, deduction_cents: deduction, owner_cents: ownerShare,
    credit_cents: creditShare, rate_mult: mult,
  };
}

// Day-7: terminate the ORDER for this customer. The designer's assignment on
// the order ends (custom_status = 'order_terminated'), the missed deadline is
// recorded for the repeat-offender escalator, and the buyer is offered the 4
// replacement options. The designer's account, subscription, and membership
// are never touched here.
async function terminateOrder(order, designerId, now) {
  await db.update('orders', order.id, {
    designer_contract_terminated: 1, // designer removed from THIS order
    deadline_missed: 1,
    deadline_missed_at: now,
    custom_status: 'order_terminated',
    replacement_status: 'offered',
  });
  const buyer = await db.get('SELECT email, display_name FROM users WHERE id = ?', [order.buyer_id]);
  const ownerId = await ownerUserId();
  const cred = await db.get(
    `SELECT COALESCE(SUM(credit_cents),0) AS t FROM sla_penalties WHERE order_id = ?`, [order.id]);
  const id8 = order.id.slice(0, 8);
  const subject = `Your custom order ${id8} — let's get you taken care of`;
  const body =
    `Hi ${buyer.display_name || 'there'},\n\n` +
    `We owe you an apology: your custom tattoo design is now 7 days past its 48-hour delivery deadline, ` +
    `and that's not the experience we want for you. Thank you for sticking with us.\n\n` +
    `We've ended the designer's assignment on your order, and you get to choose exactly what happens next — ` +
    `just reply here with the number that's best for you:\n` +
    `1. A new designer takes the job (fresh 48-hour deadline)\n` +
    `2. We make your design for you personally\n` +
    `3. Website credit for a replacement design\n` +
    `4. The same value in pre-made designs + edits\n\n` +
    `We've also added late-delivery apology credits to your account ` +
    `($${(cred.t / 100).toFixed(2)} total) — they're yours to keep and use on anything you like.\n\n` +
    `All sales are final, so credits stay on your account for future designs rather than cash refunds.\n\n` +
    `Thank you for being part of Tattoo Art Customs. We'll make this right.\n\n` +
    `Warmly,\nTattoo Art Customs`;
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
    // Repeat-offender status is evaluated per order at charge time, so a
    // designer who crosses the threshold mid-run gets 2x on later orders.
    const offender = await repeatOffenderInfo(designerId, now);
    const mult = offender.active ? REPEAT_MULT : 1;
    const target = Math.min(daysLate(order, now), TERMINATION_DAY);
    const charged = order.late_penalty_days || 0;
    let changed = false;
    for (let d = charged + 1; d <= target; d++) {
      const p = await chargeDay(order, designerId, d, now, mult);
      if (p) { result.penalties.push({ order_id: order.id, designer_id: designerId, ...p }); changed = true; }
    }
    if (changed) result.processed++;
    if (target >= TERMINATION_DAY && !order.designer_contract_terminated
        && order.custom_status !== 'order_terminated') {
      const t = await terminateOrder(order, designerId, now);
      result.terminations.push(t);
    }
  }
  // Tier 2: trigger new 30-day commission suspensions and renew expired ones
  // whose misses persist.
  result.suspensions = await refreshCommissionSuspensions({ now });
  return result;
}

// --- Reminders (firm about deadlines, professional and warm) ---

function reminderKeyFor(order, now) {
  const late = daysLate(order, now);
  if (late >= 1 && late <= TERMINATION_DAY) return 'late_' + late;
  const msLeft = (order.delivery_due || now) - now;
  if (msLeft <= 0) return 'due_now'; // <24h past due
  if (msLeft <= 24 * 3600 * 1000) return 'warn_24h';
  return null;
}

function reminderCopy(key, order, penaltyCents, artistName, mult = 1, liftsAt = null) {
  const id8 = order.id.slice(0, 8);
  const due = order.delivery_due ? new Date(order.delivery_due).toLocaleString() : 'ASAP';
  const n = key.startsWith('late_') ? parseInt(key.slice(5), 10) : 0;
  const rate = n >= 1 ? rateLabel(n, mult) : null;
  const doubled = mult > 1
    ? ` ${REPEAT_OFFENDER_NOTICE}` + (liftsAt ? ` This lifts on ${new Date(liftsAt).toLocaleDateString()}.` : '')
    : '';
  const hi = `Hi ${artistName || 'there'},`;
  const heads = {
    warn_24h: `Custom order ${id8} — due within 24 hours`,
    due_now: `Custom order ${id8} — deadline reached`,
  };
  const subject = heads[key] || `Custom order ${id8} — ${n} day${n === 1 ? '' : 's'} overdue`;
  let body;
  if (key === 'warn_24h') {
    body = `${hi} just a friendly heads-up: custom order ${id8} is due within 24 hours (deadline: ${due}). ` +
      `Getting it delivered on time keeps your customer happy and your full commission intact — after the deadline, ` +
      `a late penalty applies to the commission: ${rateLabel(1, mult)}/day for days 1–4, then ${rateLabel(5, mult)}/day for days 5–7.` +
      doubled;
  } else if (key === 'due_now') {
    body = `${hi} the 48-hour deadline for custom order ${id8} has just passed (${due}). ` +
      `Please deliver the finished design as soon as you can — each late day reduces your commission ` +
      `(${rateLabel(1, mult)}/day for days 1–4, ${rateLabel(5, mult)}/day for days 5–7). Your customer is counting on you.` +
      doubled;
  } else if (n <= 4) {
    body = `${hi} custom order ${id8} is now ${n} day${n === 1 ? '' : 's'} past its deadline. ` +
      `A late penalty of ${rate} per day has been applied to your commission so far ` +
      `($${(penaltyCents / 100).toFixed(2)} total). Deliver the finished design now to stop further penalties — ` +
      `and if something's blocking you, just reply here and we'll help. ` +
      `At 7 days overdue the order is reassigned so the customer is taken care of.` + doubled;
  } else {
    body = `${hi} custom order ${id8} is ${n} days past its deadline, and penalties are now ${rate} of your commission ` +
      `per day ($${(penaltyCents / 100).toFixed(2)} total so far). Please deliver immediately — at 7 days overdue ` +
      `the order is reassigned to keep the customer's experience on track. ` +
      `If something's blocking you, reply here and we'll help.` + doubled;
  }
  return { subject, body: body + `\n\nBrief: ${(order.custom_brief || '(no brief)').slice(0, 300)}` };
}

// First-overdue-day notice to the buyer — warm, with the apology credit.
function buyerDelayCopy(order, buyerName, creditCents) {
  const id8 = order.id.slice(0, 8);
  const subject = `Your custom design is running a little behind — ${id8}`;
  const body =
    `Hi ${buyerName || 'there'},\n\n` +
    `Thank you for your patience — we wanted to let you know your custom tattoo design is running a little ` +
    `behind its 48-hour delivery window. We're on it, and getting your design finished is our top priority.\n\n` +
    `As a thank-you for bearing with us, we've added a late-delivery apology credit of ` +
    `$${(creditCents / 100).toFixed(2)} to your account — it's yours to use on any future design.\n\n` +
    `We'll keep you posted. If you have any questions, just reply here.\n\n` +
    `Warmly,\nTattoo Art Customs`;
  return { subject, body };
}

async function sendConversation({ userIds, subject, body, senderId, now }) {
  const convId = await db.insert('conversations', { subject, created_at: now });
  for (const uid of userIds) {
    if (uid) await db.insert('conversation_participants', { conversation_id: convId, user_id: uid });
  }
  await db.insert('messages', {
    conversation_id: convId, sender_id: senderId,
    body, screened: 0, flags: '[]', created_at: now,
  });
  return convId;
}

// Send every due artist reminder, plus the buyer's first-overdue-day notice.
// Idempotent per order+key.
async function sendDueReminders({ now = Date.now() } = {}) {
  const orders = await db.all(
    `SELECT o.*, u.email AS artist_email, u.display_name AS artist_name,
            b.email AS buyer_email, b.display_name AS buyer_name
     FROM orders o
     JOIN users u ON u.id = o.requested_artist_id
     JOIN users b ON b.id = o.buyer_id
     WHERE ${isCustomOpenWhere()} AND o.delivery_due IS NOT NULL
       AND o.custom_status != 'order_terminated'`);
  const sent = [];
  const ownerId = await ownerUserId();
  for (const order of orders) {
    const key = reminderKeyFor(order, now);
    if (key) {
      const done = await db.get(
        `SELECT id FROM sla_reminders WHERE order_id = ? AND reminder_key = ?`, [order.id, key]);
      if (!done) {
        const pen = await db.get(
          `SELECT COALESCE(SUM(deduction_cents),0) AS t FROM sla_penalties WHERE order_id = ?`, [order.id]);
        const offender = await repeatOffenderInfo(order.requested_artist_id, now);
        const { subject, body } = reminderCopy(
          key, order, pen.t, order.artist_name,
          offender.active ? REPEAT_MULT : 1, offender.liftsAt);
        const convId = await sendConversation({
          userIds: [order.requested_artist_id, ownerId], subject, body,
          senderId: ownerId || order.requested_artist_id, now,
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
    }
    // Buyer delay notice on the first overdue day.
    if (daysLate(order, now) === 1) {
      const bdone = await db.get(
        `SELECT id FROM sla_reminders WHERE order_id = ? AND reminder_key = 'buyer_late_1'`, [order.id]);
      if (!bdone) {
        const cred = await db.get(
          `SELECT COALESCE(SUM(credit_cents),0) AS t FROM sla_penalties WHERE order_id = ?`, [order.id]);
        const { subject, body } = buyerDelayCopy(order, order.buyer_name, cred.t);
        const convId = await sendConversation({
          userIds: [order.buyer_id, ownerId], subject, body,
          senderId: ownerId || order.buyer_id, now,
        });
        await db.insert('sla_reminders', { order_id: order.id, reminder_key: 'buyer_late_1', created_at: now });
        if (config.smtpConfigured() && order.buyer_email) {
          try {
            const { sendMail } = require('./mail');
            await sendMail({ to: order.buyer_email, subject, text: body + `\n\n${config.baseUrl}/messages/${convId}` });
          } catch (e) { console.error('buyer delay email failed:', e.message); }
        }
        sent.push({ order_id: order.id, key: 'buyer_late_1' });
      }
    }
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

// Repeat-offender watch for the admin dashboard: designers with 2+ missed
// deadlines in the trailing 30 days (respecting admin forgiveness), plus any
// designer currently under Tier-2 commission suspension.
async function offenderWatch({ now = Date.now() } = {}) {
  const rows = await db.all(
    `SELECT u.id, u.email, u.display_name, COALESCE(u.sla_suspended, 0) AS manual_restricted,
            u.commission_suspended_until AS susp_until,
            GROUP_CONCAT(o.deadline_missed_at) AS miss_times
     FROM users u LEFT JOIN orders o ON o.requested_artist_id = u.id
       AND o.deadline_missed = 1
       AND o.deadline_missed_at >= ?
       AND o.deadline_missed_at > COALESCE(u.sla_forgiven_at, 0)
     WHERE u.role = 'design_artist'
     GROUP BY u.id`,
    [now - REPEAT_WINDOW_MS]);
  const watch = [];
  for (const r of rows) {
    const times = String(r.miss_times || '').split(',').map(Number).filter(Boolean).sort((a, b) => b - a);
    const misses = times.length;
    const suspended = !!(r.susp_until && r.susp_until > now);
    if (misses < 2 && !suspended) continue;
    const active = misses > REPEAT_OFFENDER_MISSES;
    watch.push({
      id: r.id, email: r.email, display_name: r.display_name,
      manual_restricted: !!r.manual_restricted,
      misses, repeat_offender: active,
      liftsAt: active ? times[REPEAT_OFFENDER_MISSES] + REPEAT_WINDOW_MS : null,
      commission_suspended: suspended,
      commission_suspended_until: suspended ? r.susp_until : null,
    });
  }
  watch.sort((a, b) => b.misses - a.misses);
  return watch;
}

module.exports = {
  DAY_MS, TERMINATION_DAY, REPEAT_WINDOW_MS, REPEAT_OFFENDER_MISSES, REPEAT_MULT,
  rateForDay, rateLabel, OWNER_PTS, REPEAT_OFFENDER_NOTICE,
  daysLate, applyPenalties, sendDueReminders, slaWatchlist,
  penaltyLedger, terminateOrder, originalCommission, designerRow,
  repeatOffenderInfo, missTimes30d, offenderWatch,
  reminderCopy, buyerDelayCopy,
};
