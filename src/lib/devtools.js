// Developer Tools for other developers — Bundle B (owner approved all
// 12 month-end brainstorm ideas, Oct 28 2026; builds 2, 9, 10):
//
//   /fill-my-list   Tester Hub Fill-My-List as a standalone service
//   /rolodex-demo   Affiliate Rolodex public demo (no signup)
//   /money-watch    Money Watch for developers — spec + offer + interest
//
// ONE config place for this bundle's prices, same discipline as
// lib/thebigone.js: settled numbers live here exactly once and every
// route/view reads them from this module.
//
// SETTLED PRICES (never re-priced here):
// - Fill-My-List: $24.99 per app per fill until FULL (owner strike
//   2026-10-26; the fill machine's own PRICE_CENTS in lib/fillCycle.js
//   is the same 2499 — the two must never disagree).
// - Affiliate Rolodex $4.99 · Social Link Rolodex $4.99 · Master
//   Rolodex $7.99 (owner-settled three tiers, never combined).
// - Money Watch: $4.99 one-time (owner-approved 2026-10-26, Batch #1;
//   the settled note in the codex records that the outside-developer
//   watch rides the same figure — no separate watch price).
//
// HONEST PAYMENT STATES (the standing rule — never fake a checkout):
// - A Fill order is REAL machinery today: POST /api/testers/fill/order
//   records it 'awaiting_payment' in the Hub's fill cycle. The web
//   payment rail for it is being set up; the desk confirms payment by
//   hand (Business PayPal mk4 + entitlement grant) — the page says so.
// - Money Watch for developers is NOT on sale yet: the offer page
//   collects interest through the register (an orders row, below).
//   No payment is taken or implied.
const db = require('../db');
const pricing = require('./pricing');
const fillCycle = require('./fillCycle');

// Business PayPal (mk4) tip jar — the house jar, same link the shared
// tip-jar partial carries.
const TIP_JAR_URL = 'https://www.paypal.com/ncp/payment/WA9DS6J8ERSHW';

const FILL = {
  baseCents: 2499, // $24.99 — settled; mirrors fillCycle.PRICE_CENTS
  target: fillCycle.TARGET, // 12 confirmed opt-ins = FULL
  waveSize: fillCycle.WAVE_SIZE,
};
function fillRegisterCents() {
  return pricing.withFeeCents(FILL.baseCents);
}

const ROLODEX_TIERS = {
  affiliate: { key: 'affiliate', name: 'Affiliate Rolodex', baseCents: 499 },
  social: { key: 'social', name: 'Social Link Rolodex', baseCents: 499 },
  master: { key: 'master', name: 'Master Rolodex — All My Links', baseCents: 799 },
};

const MONEY_WATCH = {
  priceCents: 499, // $4.99 one-time — settled
  // The developer offer's source doors. States are the product's
  // settled shape (spec: your_files/money-watch-for-developers-spec-
  // 2026-10-28.md): a source that is not plugged reads "not reported",
  // never faked — the same honesty rule unit #1 runs under.
  sourceDoors: [
    {
      name: 'Your sales backend — store records',
      state: 'watching',
      note: 'Orders landing in your own backend ledger. The first source the house watch ever ran on, and the pattern every other plug follows.',
    },
    {
      name: 'Business PayPal',
      state: 'built — plug seats at signup',
      note: 'A read-only OAuth lane (balances + transaction history). Your credential, seated server-side by you; the watch never holds custody of anything.',
    },
    {
      name: 'Google Play payouts',
      state: 'named — in the spec',
      note: 'Payout reports reconciled against bank deposits, so a store payout and the bank landing are one event, not two.',
    },
    {
      name: 'Bank feeds (Plaid-class)',
      state: 'named — in the spec',
      note: 'Bank-only revenue (stores, networks, marketplaces) lands here. Until the feed is plugged, this door honestly reads "not reported".',
    },
    {
      name: 'Affiliate balances',
      state: 'named — in the spec',
      note: 'Collector-fed affiliate balances join the watch as they are fed — real balances only, no estimates dressed as landings.',
    },
  ],
};

// The live pool count for the Fill page — a real number from the Hub's
// own table, or null when it cannot be read (the page then shows the
// founding-state line instead of a number; never an invented one).
async function poolCount() {
  try {
    const row = await db.get(
      "SELECT COUNT(*) AS n FROM tester_signups WHERE status = 'active'");
    return row ? Number(row.n) || 0 : null;
  } catch (e) {
    return null;
  }
}

// Money Watch developer interest — the register path (mirrors The Big
// One's classifieds pattern): an orders row the desk reads, plus the
// admin notification. No payment is taken; amount_cents records the
// settled price the interest is registered against.
async function recordMoneyWatchInterest({ name, email, sources, userId }) {
  const orderId = await db.insert('orders', {
    buyer_id: userId || '',
    order_type: 'money_watch_dev_interest',
    amount_cents: MONEY_WATCH.priceCents,
    fee_cents: 0,
    status: 'pending_review',
    payment_method: 'interest_list',
    guest_email: email,
    guest_note: JSON.stringify({ name: name || '', sources: sources || '' }),
    created_at: db.now(),
  });
  try {
    await require('./notify').notifyAdmins({
      kind: 'contact',
      title: `Money Watch (developers) interest: ${email}`,
      body: `${name || 'A developer'} <${email}> joined the Money Watch interest list. Wants watched: ${sources || '(not specified)'} (order ${orderId})`,
      link: '/money-watch',
    });
  } catch (e) { console.error('money watch interest notify failed:', e.message); }
  return orderId;
}

module.exports = {
  TIP_JAR_URL,
  FILL, fillRegisterCents,
  ROLODEX_TIERS,
  MONEY_WATCH,
  poolCount,
  recordMoneyWatchInterest,
};
