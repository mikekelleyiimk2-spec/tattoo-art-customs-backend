// Design contests / bounty board (owner rule 2026-09-30).
//
// A customer posts a brief + prize (minimum $30). The prize is paid UP
// FRONT via a normal order (order_type='contest') and held in escrow — it
// is never booked as a sale commission, so no owner debt is created.
// Designers submit image entries; the customer picks a winner within 7
// days. The winner gets the prize minus a 12% platform cut (booked as
// commission_ledger rows); non-winning entries remain the designer's full
// property and can be listed as premades later. If the deadline passes
// with no entries, the prize returns to the customer as site credit. If
// the deadline passes WITH entries and no winner, the contest moves to
// 'judging' so the customer or an admin can still pick.
const db = require('../db');
const pricing = require('./pricing');
const { screenText } = require('./screening');
const { addCredit } = require('./credits');
const { recipientEligible } = require('./commissions');
const { notifyUser, notifyAdmins } = require('./notify');

const CONTEST_MIN_PRIZE_CENTS = 3000;
const CONTEST_WINDOW_MS = 7 * 24 * 3600 * 1000;
const CONTEST_PLATFORM_CUT = 0.12; // 12% site overhead; winner gets 88%
const CONTEST_PRIZE_SUGGESTIONS = [3000, 5000, 7500, 10000, 15000];

function contestQuote(prizeCents) {
  const fee = pricing.processingFeeCents(prizeCents);
  return { prizeCents, feeCents: fee, totalCents: prizeCents + fee };
}

function validateBrief({ title, description, style, sizePlacement, prizeCents }) {
  const t = String(title || '').trim();
  const d = String(description || '').trim();
  if (t.length < 5) throw new Error('Give your contest a title (5+ characters).');
  if (d.length < 20) throw new Error('Describe what you want (20+ characters) so designers know what to draw.');
  const prize = Math.round(Number(prizeCents) || 0);
  if (prize < CONTEST_MIN_PRIZE_CENTS) {
    throw new Error(`The minimum prize is ${pricing.money(CONTEST_MIN_PRIZE_CENTS)}.`);
  }
  if (prize > 100000) throw new Error('Prizes are capped at $1,000 per contest — contact us for bigger bounties.');
  for (const [label, text] of [['title', t], ['description', d], ['size/placement', String(sizePlacement || '')]]) {
    const s = screenText(text);
    if (!s.ok) throw new Error(`Contest ${label} was blocked: ${s.reason || 'remove contact info or off-site payment mentions.'}`);
  }
  return {
    title: t.slice(0, 120),
    description: d.slice(0, 4000),
    style: String(style || '').slice(0, 40),
    sizePlacement: String(sizePlacement || '').slice(0, 200),
    prizeCents: prize,
  };
}

// Create the pending contest + its prize-escrow order (still unpaid).
async function createPendingContest({ customerId, title, description, style, sizePlacement, prizeCents }) {
  const v = validateBrief({ title, description, style, sizePlacement, prizeCents });
  const { feeCents } = contestQuote(v.prizeCents);
  const contestId = db.newId();
  await db.insert('contests', {
    id: contestId, customer_id: customerId, title: v.title, description: v.description,
    style: v.style, size_placement: v.sizePlacement, prize_cents: v.prizeCents,
    fee_cents: feeCents, status: 'pending_payment', created_at: db.now(),
  });
  const orderId = await db.insert('orders', {
    buyer_id: customerId, design_id: null, order_type: 'contest',
    amount_cents: v.prizeCents, fee_cents: feeCents, status: 'pending',
    payment_method: 'paypal', created_at: db.now(),
  });
  await db.update('contests', contestId, { order_id: orderId });
  return { contestId, orderId, quote: contestQuote(v.prizeCents) };
}

// Mark the escrow paid and open the contest for entries.
async function openContest(contestId, { paidCents, paymentMethod = 'paypal', paypalOrderId = '' } = {}) {
  const c = await db.get('SELECT * FROM contests WHERE id = ?', [contestId]);
  if (!c || c.status !== 'pending_payment') throw new Error('Contest is not awaiting payment.');
  const now = db.now();
  await db.update('contests', contestId, {
    status: 'open', ends_at: now + CONTEST_WINDOW_MS,
    total_paid_cents: paidCents || 0, payment_method: paymentMethod,
    paypal_order_id: paypalOrderId,
  });
  const order = await db.get(
    `SELECT id FROM orders WHERE buyer_id = ? AND order_type = 'contest' AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [c.customer_id]
  );
  if (order) {
    await db.update('orders', order.id, {
      status: 'paid', amount_paid_cents: paidCents || 0, paid_at: now,
      paypal_order_id: paypalOrderId, payment_method: paymentMethod,
    });
  }
  await notifyAdmins({
    kind: 'contest_open', title: `New contest: "${c.title}" (${pricing.money(c.prize_cents)} prize)`,
    body: `A customer posted a design contest with a ${pricing.money(c.prize_cents)} prize.`,
    link: `/contests/${contestId}`,
  });
  return db.get('SELECT * FROM contests WHERE id = ?', [contestId]);
}

async function contestEntries(contestId) {
  return db.all('SELECT * FROM contest_entries WHERE contest_id = ? ORDER BY created_at ASC', [contestId]);
}

async function enterContest({ contestId, designerId, imagePath, note = '' }) {
  const c = await db.get('SELECT * FROM contests WHERE id = ?', [contestId]);
  if (!c || c.status !== 'open') throw new Error('This contest is not accepting entries.');
  if (c.customer_id === designerId) throw new Error('You cannot enter your own contest.');
  const n = String(note || '').slice(0, 500);
  const s = screenText(n);
  if (!s.ok) throw new Error('Entry note was blocked: ' + (s.reason || 'remove contact info.'));
  const id = await db.insert('contest_entries', {
    id: db.newId(), contest_id: contestId, designer_id: designerId,
    image_path: imagePath, note: n, created_at: db.now(),
  });
  await notifyUser(c.customer_id, {
    kind: 'contest_entry', title: `New entry on your contest "${c.title}"`,
    body: 'A designer submitted an entry — take a look.',
    link: `/contests/${contestId}`,
  });
  return id;
}

// Pick the winner (customer or admin). Books the 88/12 split as
// commission_ledger rows against the prize-escrow order. Idempotent.
async function pickWinner({ contestId, entryId, pickerId, pickerIsAdmin = false }) {
  const c = await db.get('SELECT * FROM contests WHERE id = ?', [contestId]);
  if (!c) throw new Error('Contest not found.');
  if (!['open', 'judging'].includes(c.status)) throw new Error('This contest is already decided.');
  if (c.customer_id !== pickerId && !pickerIsAdmin) throw new Error('Only the contest holder (or an admin) can pick the winner.');
  const entry = await db.get('SELECT * FROM contest_entries WHERE id = ? AND contest_id = ?', [entryId, contestId]);
  if (!entry) throw new Error('Entry not found.');
  const order = await db.get(
    `SELECT id FROM orders WHERE buyer_id = ? AND order_type = 'contest' AND status = 'paid' ORDER BY created_at DESC LIMIT 1`,
    [c.customer_id]
  );
  const orderId = order ? order.id : `contest:${c.id}`;
  const existing = await db.get(
    `SELECT id FROM commission_ledger WHERE order_id = ? AND commission_type IN ('contest_prize', 'contest_fee') LIMIT 1`,
    [orderId]
  );
  const t = db.now();
  const siteCut = Math.round(c.prize_cents * CONTEST_PLATFORM_CUT);
  const winnerShare = c.prize_cents - siteCut;
  if (!existing) {
    const eligible = await recipientEligible(entry.designer_id, 'design_artist').catch(() => false);
    await db.insert('commission_ledger', {
      order_id: orderId, recipient_type: 'artist', recipient_id: entry.designer_id,
      amount_cents: winnerShare, status: eligible ? 'payable' : 'site_kept',
      commission_type: 'contest_prize', created_at: t,
    });
    await db.insert('commission_ledger', {
      order_id: orderId, recipient_type: 'site', recipient_id: null,
      amount_cents: siteCut, status: 'site_kept',
      commission_type: 'contest_fee', created_at: t,
    });
  }
  await db.update('contests', contestId, {
    status: 'awarded', winner_entry_id: entry.id, winner_user_id: entry.designer_id, awarded_at: t,
  });
  await notifyUser(entry.designer_id, {
    kind: 'contest_won', title: `You won the contest "${c.title}"!`,
    body: `Your entry won — ${pricing.money(winnerShare)} is on its way to your payouts.`,
    link: `/contests/${contestId}`,
  });
  await notifyUser(c.customer_id, {
    kind: 'contest_awarded', title: `Winner picked for "${c.title}"`,
    body: 'The winning design is ready — check the contest page.',
    link: `/contests/${contestId}`,
  });
  return { winnerShare, siteCut };
}

// Expire past-deadline open contests. No entries -> prize refunded to the
// customer as site credit. Entries but no winner -> 'judging' so the
// customer or an admin can still pick. Idempotent.
async function expireContests(now = Date.now()) {
  const due = await db.all(
    `SELECT * FROM contests WHERE status = 'open' AND ends_at IS NOT NULL AND ends_at <= ?`,
    [now]
  );
  const report = { expired: 0, refunded: 0, judging: 0 };
  for (const c of due) {
    const entries = await contestEntries(c.id);
    if (!entries.length) {
      await addCredit({
        userId: c.customer_id, amountCents: c.prize_cents,
        kind: 'contest_refund', refId: c.id,
        note: `Contest "${c.title}" expired with no entries — prize refunded as site credit.`,
      });
      await db.update('contests', c.id, { status: 'refunded' });
      await notifyUser(c.customer_id, {
        kind: 'contest_refunded', title: `Contest "${c.title}" expired — prize refunded`,
        body: `${pricing.money(c.prize_cents)} was added to your site credit (no entries were submitted).`,
        link: `/contests/${c.id}`,
      });
      report.refunded++;
    } else {
      await db.update('contests', c.id, { status: 'judging' });
      await notifyUser(c.customer_id, {
        kind: 'contest_judging', title: `Time to pick a winner for "${c.title}"`,
        body: `The 7-day window closed with ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} — pick your winner now, or an admin will.`,
        link: `/contests/${c.id}`,
      });
      await notifyAdmins({
        kind: 'contest_judging', title: `Contest needs judging: "${c.title}"`,
        body: `${entries.length} entries, no winner picked yet.`,
        link: `/admin/contests`,
      });
      report.judging++;
    }
    report.expired++;
  }
  return report;
}

function timeLeftMs(contest, now = Date.now()) {
  if (!contest.ends_at) return null;
  return Math.max(0, contest.ends_at - now);
}

module.exports = {
  CONTEST_MIN_PRIZE_CENTS, CONTEST_WINDOW_MS, CONTEST_PLATFORM_CUT,
  CONTEST_PRIZE_SUGGESTIONS, contestQuote, validateBrief,
  createPendingContest, openContest, contestEntries, enterContest,
  pickWinner, expireContests, timeLeftMs,
};
