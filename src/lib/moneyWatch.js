// Money Watch — slice 1 (2026-10-26). Design:
// ~/workspace/your_files/money-watch-design-2026-10-26.md — read §3 (the
// money-map law), §7A(d) (the movement honesty layer) and §8 (DECIDED)
// before touching this file.
//
// WHAT THIS IS: the estate-side landing detector + the public state
// behind GET /api/money-watch. A LANDING is new money arriving in a
// watched account or ledger — an event with amount, source (or "source
// unknown" — the watch never guesses a payer into existence), account,
// timestamp, and an honest kind (revenue / transfer / refund / unknown).
// Window totals sum REVENUE-kind landings only; transfers and refunds
// appear in the history as themselves, outside the total. Settlements
// and the owner's own money are never revenue, ever.
//
// READ-ONLY EVERYWHERE: this module reads two backend tables and writes
// only its own state blob. No feed it reads can move money, and nothing
// here may ever imply movement — executing the split is Phase 4 (§7A(d))
// and does not exist until a licensed transfer rail is integrated and
// signed off. The split below is PLAN MATH ONLY: recorded, computed,
// shown — nothing moves.
//
// SOURCES — wired vs named-unwired (the design's honesty rule: a door
// that isn't wired is NAMED in the state, never faked):
//   WIRED (slice 1): the website-backend records the estate already
//     holds — paid/refunded orders (the sales record) — and the Penny
//     Ledger (migration 105, append-only; new rows past the watermark
//     are events).
//   WIRED-WHEN-CONFIGURED (Playbook #2, 2026-10-26): Business PayPal
//     mk4 — the Service Plug's PayPal playbook shipped the read lane
//     (src/lib/paypalPlug.js: OAuth2 client-credentials, balances +
//     transaction history, READ-ONLY). The lane runs only when the
//     door's own credential is seated in the server env
//     (PAYPAL_WATCH_CLIENT_ID / PAYPAL_WATCH_CLIENT_SECRET); until
//     then the door's state is "built" — plug built, awaiting
//     credential registration — and the watch says so instead of
//     pretending to see into PayPal. The first wired pass is the
//     door's own baseline (history absorbed, nothing fires), exactly
//     like the estate baseline below.
//   NAMED-UNWIRED: Plaid bank feeds (Varo business + Chime personal —
//     no Plaid read is plugged into this watcher yet), Google Play
//     payouts (the doorway lane reads the office; payout reports
//     reconcile in slice 2), and the RoboSweeper Collector's affiliate
//     balances (Tier 2 — they feed as real balances get fed; today
//     they honestly read "not reported").
//
// PATTERN: the Email Keeper's (src/lib/emailKeeper.js). The Keeper's
// data lives on the VM, so it POSTs an ingest; Money Watch's sources
// live in THIS database, so the watcher runs here and the VM-side
// trigger (~/workspace/app/moneywatch/money-watch-check.py) calls the
// service-token-guarded POST /api/money-watch/run. State is one blob in
// site_kv (the same store the Keeper uses), re-projected through the
// whitelist on the way out.
//
// EXACTLY-ONCE: per source, the state keeps a watermark (the newest
// source timestamp absorbed) + the set of source IDs seen AT that
// watermark. A landing fires the first time its source ID appears past
// the watermark and never again — re-runs, restarts and deploy swaps
// cannot re-fire it. The FIRST run on an estate is a baseline: it
// absorbs every existing record as already-seen and fires nothing, so
// history (including test rows) never flashes as fresh money. Rows are
// append-as-they-happen in both sources; a hypothetical backfilled row
// older than the watermark would be absorbed silently, by design.
//
// PII: the Penny Ledger's `account` column can hold a developer's Gmail
// (buyer-credit / referrer rows). Classification maps it to a role
// label ('a developer (referrer)') at detection time — the raw value
// never enters the watch state, so no view of this module can leak it.
const db = require('../db');
const paypalPlug = require('./paypalPlug');

const KV_KEY = 'money_watch_state';

// The doors, in board order. `state` is a fact about TODAY, checked
// against the code above it — if a door gets wired, flip it in the
// same change that wires it. The PayPal door's state is computed at
// view time (doorsView below): its lane exists (Playbook #2) but only
// runs when its credential is seated in the server env.
const DOORS = [
  { key: 'backend-sales', name: 'Website backend — sales records (orders)', state: 'wired', note: 'Paid website sales land in the backend ledger; the watcher reads them there.' },
  { key: 'penny-ledger', name: 'Penny Ledger — Profile Plug splits', state: 'wired', note: 'Every new split row in the append-only ledger (migration 105) is an event.' },
  { key: 'plaid-varo', name: 'Plaid — Varo (business overhead)', state: 'unwired', note: 'Bank-only revenue lands here (Play, CJ, eBay, AdSense, Amazon, Etsy). No bank feed is plugged into the watcher yet — named, not faked.' },
  { key: 'paypal-mk4', name: 'Business PayPal — mk4', state: 'built', note: 'PayPal — plug built, awaiting credential registration. Playbook #2 (Service Plug) shipped the read lane — balances + transaction history, read-only — and it runs the moment the owner\u2019s staged grant step seats the door\u2019s credential in the server env. Until then the watch cannot see into PayPal and says so.' },
  { key: 'play-payouts', name: 'Google Play payouts', state: 'unwired', note: 'The doorway lane reads the office today; payout reports reconcile against bank deposits in slice 2.' },
  { key: 'collector', name: 'RoboSweeper Collector — affiliate balances', state: 'unwired', note: 'Tier 2: feeds the watch as real balances are fed. Today every Collector balance honestly reads \u201cnot reported\u201d.' },
  { key: 'plaid-chime', name: 'Plaid — Chime (personal side)', state: 'unwired', personal: true, note: 'PERSONAL side — its figures, when wired, appear only in the owner\u2019s private view, never in business totals (§3).' },
];

// Unit #1's split plan — the owner's own money map (design §7A(b)).
// Read-only math: every business revenue landing is shown split out
// per this plan; nothing is moved by showing it.
const SPLIT_PLAN = {
  name: 'Unit #1 — the house money map',
  rule: '10% of every business revenue landing \u2192 Varo (overhead). The rest down the business lanes (mk4 / Varo per the money map). Personal money never enters the business split.',
  overhead_percent: 10,
  moves_money: false,
  note: 'Plan + math only. Executing the split needs the Phase 4 transfer rail, which does not exist yet — the watch watches.',
};

function money(cents) {
  const c = Number(cents) || 0;
  return (c < 0 ? '-$' : '$') + (Math.abs(c) / 100).toFixed(2);
}

function iso(ms) {
  return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null;
}

// ---- classification: source row -> landing --------------------------
// A landing: { id, at (ms), amount_cents, source, account, kind, line,
// split? }. `id` is namespaced by source so the two ID spaces can
// never collide.

function splitFor(amountCents) {
  // The §7A split math for one business revenue landing. Percentages
  // only in slice 1 (the money map's one standing split); fixed-amount
  // destinations arrive with the outside-developer setup in slice 3.
  if (!(amountCents > 0)) return [];
  const overhead = Math.round(amountCents * (SPLIT_PLAN.overhead_percent / 100));
  return [
    { to: 'Varo — overhead (10%)', amount_cents: overhead },
    { to: 'Business lanes — mk4 / Varo per the money map', amount_cents: amountCents - overhead },
  ];
}

function classifyOrder(row) {
  const at = Number(row.paid_at) || Number(row.created_at) || 0;
  const paid = Number(row.amount_paid_cents) || 0;
  const gross = Number(row.amount_cents) || 0;
  const base = {
    id: 'orders:' + row.id,
    at,
    source: 'Website sale',
    account: 'the backend ledger',
  };
  if (row.status === 'paid') {
    const amount = paid || gross;
    return {
      ...base,
      amount_cents: amount,
      kind: 'revenue',
      line: `You made ${money(amount)} — website sale \u2192 the backend ledger.`,
      split: splitFor(amount),
    };
  }
  // refunded / chargedback: money that went back out. Shown as itself,
  // never netted silently into a revenue total.
  const amount = paid || gross;
  return {
    ...base,
    amount_cents: -amount,
    kind: 'refund',
    line: `Refund — ${money(amount)} went back out on a website sale.`,
    split: [],
  };
}

const PENNY_ACCOUNT_LABELS = {
  house: 'Penny Ledger · house',
  pot: 'Penny Ledger · prize pot',
  google: 'Penny Ledger · Google (Play fee)',
};

function classifyPenny(row) {
  const at = Number(row.created_at) || 0;
  const amount = Number(row.amount_cents) || 0;
  // `account` is 'house' | 'pot' | 'google' or a developer's Gmail.
  // A Gmail becomes a role label here and goes no further.
  let account = PENNY_ACCOUNT_LABELS[row.account];
  if (!account) {
    if (row.kind === 'split_referrer') account = 'Penny Ledger · a developer (referrer)';
    else if (row.kind === 'split_buyer_credit' || row.kind === 'credit_spend') account = 'Penny Ledger · a developer (buyer credit)';
    else account = 'Penny Ledger';
  }
  const base = {
    id: 'penny:' + row.id,
    at,
    source: 'Penny Split — Profile Plug',
    account,
  };
  if (row.kind === 'split_house') {
    // The house's share of a link-plug purchase: business revenue.
    return {
      ...base,
      amount_cents: amount,
      kind: 'revenue',
      line: `You made ${money(amount)} — Penny Split (house share) \u2192 the Penny Ledger.`,
      split: splitFor(amount),
    };
  }
  if (row.kind === 'credit_spend') {
    return {
      ...base,
      amount_cents: amount, // negative in the ledger, kept negative
      kind: 'transfer',
      line: `Plug credit spent — ${money(-amount)} of buyer credit redeemed on a link.`,
      split: [],
    };
  }
  if (typeof row.kind === 'string' && row.kind.startsWith('split_')) {
    // The other slices of one $0.99 purchase (Google fee / pot /
    // referrer / buyer credit): money in motion, shown as itself,
    // never counted as fresh revenue on top of the house share.
    return {
      ...base,
      amount_cents: amount,
      kind: 'transfer',
      line: `Penny Split moved ${money(amount)} \u2192 ${account.replace('Penny Ledger · ', '')} (one slice of a link-plug purchase).`,
      split: [],
    };
  }
  return {
    ...base,
    amount_cents: amount,
    kind: 'unknown',
    line: `Penny Ledger row (${String(row.kind || 'unknown')}) — ${money(amount)}, unclassified, shown as itself.`,
    split: [],
  };
}

// PayPal rows arrive normalized from src/lib/paypalPlug.js:
// { id (transaction ID), at (ms, transaction updated time),
//   amount_cents (signed), currency, event_code, status }.
// Classification by PayPal's transaction event-code families:
//   T00xx payments — money IN from an outside payer is revenue; money
//     OUT (a payment he sent) is shown as itself, never netted;
//   T04xx withdrawals/payouts to a bank — transfers (his own money in
//     motion between his own places);
//   T11xx refunds/reversals and T12xx chargebacks — refunds: money
//     that went back out, shown as itself, negative;
//   anything else — unknown, shown as itself, never laundered.
// Non-USD movements are never converted or counted: unknown, with the
// currency named in the line. The payer's identity never enters the
// state — the source is the door, not the person (the watch never
// guesses a payer into existence, and no PII rides the board).
function classifyPaypal(row) {
  const at = Number(row.at) || 0;
  const amt = Number(row.amount_cents) || 0;
  const code = typeof row.event_code === 'string' ? row.event_code : '';
  const base = { id: 'paypal:' + row.id, at, account: 'Business PayPal — mk4' };
  if (row.currency && row.currency !== 'USD') {
    const raw = `${row.currency} ${(Math.abs(amt) / 100).toFixed(2)}`;
    return {
      ...base, amount_cents: amt, source: 'PayPal — mk4', kind: 'unknown',
      line: `PayPal movement in ${row.currency} (${raw}) — not converted, shown as itself.`,
      split: [],
    };
  }
  if (/^T04/.test(code)) {
    return {
      ...base, amount_cents: amt, source: 'PayPal payout', kind: 'transfer',
      line: `PayPal payout — ${money(Math.abs(amt))} moved from Business PayPal (mk4) to the bank.`,
      split: [],
    };
  }
  if (/^T11/.test(code) || /^T12/.test(code)) {
    return {
      ...base, amount_cents: -Math.abs(amt), source: 'PayPal refund', kind: 'refund',
      line: `PayPal refund — ${money(Math.abs(amt))} went back out of Business PayPal (mk4).`,
      split: [],
    };
  }
  if (/^T00/.test(code) && amt > 0) {
    return {
      ...base, amount_cents: amt, source: 'PayPal payment', kind: 'revenue',
      line: `You made ${money(amt)} — PayPal payment → Business PayPal (mk4).`,
      split: splitFor(amt),
    };
  }
  if (/^T00/.test(code) && amt < 0) {
    return {
      ...base, amount_cents: amt, source: 'PayPal payment sent', kind: 'unknown',
      line: `PayPal payment sent — ${money(-amt)} went out of Business PayPal (mk4), shown as itself.`,
      split: [],
    };
  }
  return {
    ...base, amount_cents: amt, source: 'PayPal — mk4', kind: 'unknown',
    line: `PayPal movement${code ? ` (${code})` : ''} — ${money(amt)} in Business PayPal (mk4), unclassified, shown as itself.`,
    split: [],
  };
}

// ---- state ----------------------------------------------------------

function emptySeen() {
  return {
    orders: { watermark: 0, ids: [] },
    penny_ledger: { watermark: 0, ids: [] },
    paypal: { watermark: 0, ids: [] },
  };
}

function emptyState() {
  return {
    version: 1, baseline_at: null, last_run_at: null,
    paypal_baseline_at: null,
    seen: emptySeen(), landings: [],
  };
}

async function kvGet(name) {
  try {
    const row = await db.get('SELECT val FROM site_kv WHERE name = ?', [name]);
    return row ? row.val : null;
  } catch { return null; }
}

async function kvSet(name, val) {
  // Raw upsert (the emailKeeper pattern): site_kv's PRIMARY KEY is
  // `name` and db.insert() would mint an `id` the table doesn't have.
  await db.query(
    `INSERT INTO site_kv (name, val, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET val = excluded.val, updated_at = excluded.updated_at`,
    [name, val, db.now()]);
}

async function getState() {
  const raw = await kvGet(KV_KEY);
  if (!raw) return emptyState();
  try {
    const s = JSON.parse(raw);
    if (!s || !Array.isArray(s.landings) || !s.seen) return emptyState();
    return {
      version: 1,
      baseline_at: typeof s.baseline_at === 'number' ? s.baseline_at : null,
      last_run_at: typeof s.last_run_at === 'number' ? s.last_run_at : null,
      paypal_baseline_at: typeof s.paypal_baseline_at === 'number' ? s.paypal_baseline_at : null,
      seen: {
        orders: sanitizeSeen(s.seen.orders),
        penny_ledger: sanitizeSeen(s.seen.penny_ledger),
        paypal: sanitizeSeen(s.seen.paypal),
      },
      landings: s.landings.filter((l) => l && typeof l.id === 'string'
        && typeof l.at === 'number' && typeof l.amount_cents === 'number'),
    };
  } catch {
    return emptyState();
  }
}

function sanitizeSeen(s) {
  if (!s || typeof s !== 'object') return { watermark: 0, ids: [] };
  return {
    watermark: typeof s.watermark === 'number' ? s.watermark : 0,
    ids: Array.isArray(s.ids) ? s.ids.filter((x) => typeof x === 'string').slice(0, 10000) : [],
  };
}

async function saveState(state) {
  await kvSet(KV_KEY, JSON.stringify(state));
}

// ---- the watcher ----------------------------------------------------

const SCAN_LIMIT = 5000;
const LANDINGS_CAP = 200;

// Diff one source's rows against its seen-watermark. `tsOf` extracts
// the source timestamp a row is ordered by. Returns the new rows and
// the advanced seen marker. Pure — the tests drive it directly.
function diffSource(rows, seen, tsOf) {
  const fresh = [];
  let watermark = seen.watermark;
  for (const row of rows) {
    const ts = tsOf(row);
    if (ts > seen.watermark || (ts === seen.watermark && !seen.ids.includes(row.id))) {
      fresh.push(row);
    }
    if (ts > watermark) watermark = ts;
  }
  const idsAt = rows.filter((r) => tsOf(r) === watermark).map((r) => r.id);
  const carry = watermark === seen.watermark ? seen.ids.filter((id) => !idsAt.includes(id)) : [];
  return { fresh, seen: { watermark, ids: [...carry, ...idsAt].slice(0, 10000) } };
}

async function scanOrders(watermark) {
  return db.all(
    `SELECT id, order_type, amount_cents, amount_paid_cents, status, paid_at, created_at
       FROM orders
      WHERE status IN ('paid', 'refunded', 'chargedback')
        AND COALESCE(paid_at, created_at) >= ?
      ORDER BY COALESCE(paid_at, created_at) ASC, id ASC
      LIMIT ${SCAN_LIMIT}`,
    [watermark]);
}

async function scanPenny(watermark) {
  return db.all(
    `SELECT id, account, kind, amount_cents, created_at
       FROM penny_ledger
      WHERE created_at >= ?
      ORDER BY created_at ASC, id ASC
      LIMIT ${SCAN_LIMIT}`,
    [watermark]);
}

// One watcher pass. First-ever pass = baseline (absorb, fire nothing).
// Returns { ran_at, baseline, new_landings } (+ paypal_error when the
// PayPal lane was configured but its read failed — the door parks with
// its error class, its watermark untouched, and the rest of the pass
// completes normally; a dead money door never takes the whole watch
// down with it).
async function runWatcher(nowMs = Date.now()) {
  const state = await getState();
  const baseline = state.baseline_at === null;

  const orderRows = await scanOrders(state.seen.orders.watermark);
  const pennyRows = await scanPenny(state.seen.penny_ledger.watermark);

  const o = diffSource(orderRows, state.seen.orders, (r) => Number(r.paid_at) || Number(r.created_at) || 0);
  const p = diffSource(pennyRows, state.seen.penny_ledger, (r) => Number(r.created_at) || 0);
  state.seen.orders = o.seen;
  state.seen.penny_ledger = p.seen;

  // The PayPal lane (Playbook #2): runs only when the door's
  // credential is seated in the env. Its first wired pass is the
  // door's own baseline — history absorbed, nothing fires — the same
  // rule the estate baseline follows, applied per door, so a door
  // wired later never flashes its past as fresh money. A failed read
  // parks the door: the seen marker is only assigned after a
  // successful scan + diff, so exactly-once survives the failure.
  let paypalFresh = [];
  let paypalError = null;
  if (paypalPlug.configured()) {
    try {
      const rows = await paypalPlug.scanTransactions(state.seen.paypal.watermark, nowMs);
      const d = diffSource(rows, state.seen.paypal, (r) => r.at);
      state.seen.paypal = d.seen;
      if (!baseline && state.paypal_baseline_at !== null) {
        paypalFresh = d.fresh.map(classifyPaypal);
      }
      if (state.paypal_baseline_at === null) state.paypal_baseline_at = nowMs;
    } catch (e) {
      paypalError = e.paypalClass || 'read_failed';
      console.error('[money-watch] paypal lane parked:', paypalError, '-', e.message);
    }
  }

  let fresh = [];
  if (!baseline) {
    fresh = [...o.fresh.map(classifyOrder), ...p.fresh.map(classifyPenny), ...paypalFresh]
      .sort((a, b) => a.at - b.at);
    state.landings = [...state.landings, ...fresh].slice(-LANDINGS_CAP);
  }
  if (baseline) state.baseline_at = nowMs;
  state.last_run_at = nowMs;
  await saveState(state);
  return {
    ran_at: iso(nowMs), baseline, new_landings: baseline ? 0 : fresh.length,
    ...(paypalError ? { paypal_error: paypalError } : {}),
  };
}

// ---- views ----------------------------------------------------------

// America/Chicago day boundaries (the owner's "today"). Computed via
// Intl so DST is the platform's problem, not hand-rolled offsets.
const CT_ZONE = 'America/Chicago';
const ctFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: CT_ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function ctParts(ms) {
  const p = {};
  for (const part of ctFmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour % 24, minute: +p.minute, second: +p.second,
  };
}

function ctOffsetMs(ms) {
  const p = ctParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Epoch ms of 00:00 CT on the CT calendar date (y, m, d).
function ctDayStart(year, month, day) {
  const noonUtc = Date.UTC(year, month - 1, day, 12);
  let start = Date.UTC(year, month - 1, day) - ctOffsetMs(noonUtc);
  // Verify + correct once (an offset change inside the day is a DST
  // transition day; the second pass lands on the true midnight).
  const p = ctParts(start);
  if (p.hour !== 0 || p.minute !== 0 || p.day !== day) {
    start = Date.UTC(year, month - 1, day) - ctOffsetMs(start);
  }
  return start;
}

function windowStarts(nowMs) {
  const p = ctParts(nowMs);
  const today = ctDayStart(p.year, p.month, p.day);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0=Sun
  const monday = new Date(Date.UTC(p.year, p.month - 1, p.day - ((dow + 6) % 7)));
  const week = ctDayStart(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
  const month = ctDayStart(p.year, p.month, 1);
  return { last_hour: nowMs - 3600 * 1000, today, this_week: week, this_month: month };
}

function computeWindows(landings, nowMs) {
  const starts = windowStarts(nowMs);
  const out = {};
  for (const [name, start] of Object.entries(starts)) {
    const inWindow = landings.filter((l) => l.kind === 'revenue' && l.at >= start && l.at <= nowMs);
    out[name] = {
      revenue_cents: inWindow.reduce((s, l) => s + l.amount_cents, 0),
      revenue: money(inWindow.reduce((s, l) => s + l.amount_cents, 0)),
      landings: inWindow.length,
    };
  }
  return out;
}

function publicLanding(l) {
  // The whitelist, applied on the way out as well as in: a landing
  // carries exactly these fields, however the stored blob was written.
  return {
    id: l.id,
    at: iso(l.at),
    amount_cents: l.amount_cents,
    amount: money(l.amount_cents),
    source: typeof l.source === 'string' ? l.source : 'source unknown',
    account: typeof l.account === 'string' ? l.account : 'the backend ledger',
    kind: ['revenue', 'transfer', 'refund', 'unknown'].includes(l.kind) ? l.kind : 'unknown',
    line: typeof l.line === 'string' ? l.line : '',
    split: Array.isArray(l.split)
      ? l.split.filter((s) => s && typeof s.to === 'string' && typeof s.amount_cents === 'number')
        .map((s) => ({ to: s.to, amount_cents: s.amount_cents, amount: money(s.amount_cents) }))
      : [],
  };
}

// The door board as it stands TODAY: every door's recorded state,
// except PayPal's, which is a function of the env seat — the lane is
// built (Playbook #2), so unconfigured reads "built" with its
// awaiting-registration note, and configured reads "wired".
function doorsView() {
  return DOORS.map((d) => {
    if (d.key !== 'paypal-mk4') return { key: d.key, name: d.name, state: d.state, note: d.note };
    if (paypalPlug.configured()) {
      return {
        key: d.key, name: d.name, state: 'wired',
        note: 'PayPal — plug live (Playbook #2): the watch reads mk4 balances + transaction history (read-only) on every pass; new PayPal money lands here as it arrives.',
      };
    }
    return { key: d.key, name: d.name, state: d.state, note: d.note };
  });
}

function publicView(state, nowMs = Date.now()) {
  const landings = [...state.landings].sort((a, b) => b.at - a.at).map(publicLanding);
  const newest = landings[0];
  return {
    headline: newest ? newest.line : 'Watching.',
    generated_at: iso(state.last_run_at),
    baseline_at: iso(state.baseline_at),
    doors: doorsView(),
    split_plan: SPLIT_PLAN,
    windows: computeWindows(state.landings, nowMs),
    landings: landings.slice(0, 50),
  };
}

// The owner's private view (service-token only): the public report
// PLUS the personal side (§8 item 3 — YES, private view only) and the
// watcher internals. The personal side's only wired figure would come
// from Plaid-Chime; that door is unwired in slice 1, so the section
// exists and says so — no personal money is mixed into the business
// totals above, in either view, ever.
function fullView(state, nowMs = Date.now()) {
  return {
    ...publicView(state, nowMs),
    personal_side: {
      wired: false,
      note: 'Private view only. The personal-side door (Plaid — Chime) is not wired yet; when it is, personal landings show HERE and nowhere else — never in the business totals.',
      landings: [],
    },
    watcher: {
      last_run_at: iso(state.last_run_at),
      baseline_at: iso(state.baseline_at),
      seen: {
        orders: { watermark: state.seen.orders.watermark, ids_at_watermark: state.seen.orders.ids.length },
        penny_ledger: { watermark: state.seen.penny_ledger.watermark, ids_at_watermark: state.seen.penny_ledger.ids.length },
        paypal: { watermark: state.seen.paypal.watermark, ids_at_watermark: state.seen.paypal.ids.length },
      },
      paypal: {
        configured: paypalPlug.configured(),
        baseline_at: iso(state.paypal_baseline_at),
      },
      landings_held: state.landings.length,
    },
  };
}

module.exports = {
  DOORS, SPLIT_PLAN,
  classifyOrder, classifyPenny, classifyPaypal, diffSource, doorsView,
  windowStarts, computeWindows,
  getState, saveState, runWatcher,
  publicView, fullView,
};
