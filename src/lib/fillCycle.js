// FillMyList "Fill My Tester List" (owner design + price, 2026-10-26; renamed from Tester Hub 2026-10-28).
//
// The developer crowd's paid door. TWO-CROWD MODEL: testers never pay
// (their side is free + ad-supported); a developer pays ONE charge —
// $24.99, one app, one charge, every time (settled under the X Rule)
// — and the app enters the FILL CYCLE:
//
//   waves:   the pool roster is routed to the app in slices (waves);
//            each wave's members see the app in their Hub feed.
//   the tap: every tester opts in THEMSELVES on Google's own page.
//            The Hub never fakes, proxies, or implies that tap.
//   watch:   testers confirm in-app after Google's page accepts them;
//            confirmations are counted live. A confirmation is the
//            tester's attestation; the standing "You're a tester"
//            screenshot remains the proof a developer can ask for.
//   cycle:   when a wave is exhausted (everyone routed in it has
//            confirmed, or 48h pass) and the count is short of FULL,
//            the next wave goes out. Repeat until FULL.
//   FULL:    TARGET (12) confirmed opt-ins. If a confirmed tester
//            drops during the app's 14-day closed-test run, top-up
//            waves are FREE until the run ends — "full stays full" is
//            part of what the $24.99 bought. A new app, or a brand-new
//            run after this one closes, is a new charge.
//
// PAYMENT RAIL — the honest state: an order starts 'awaiting_payment'
// and an unpaid app NEVER enters the cycle. The order flips to
// 'filling' only via grantFillEntitlement(), the managed entitlement
// grant (service-token only) — the exact pattern the Profile Plug
// runs on today (src/lib/profilePlug.js) until Play Billing receipt
// verification lands on the console train. A grant made without a
// real Play receipt is recorded simulated=1, never dressed as a sale.
//
// The light-board events written here are REAL cycle events only.
// Developer display names come from the public Hub profile
// (tester_hub_developers.display_name); tester personal data is
// never written to the events table.
const db = require('../db');
const { normalizeGmail, isGmail } = require('./testerPool');

const PRICE_CENTS = 2499;
const TARGET = 12;
const WAVE_SIZE = 15;
const WAVE_STALL_MS = 48 * 60 * 60 * 1000;
const RUN_MS = 14 * 24 * 60 * 60 * 1000;

async function appRow(packageId) {
  return db.get(
    "SELECT * FROM tester_hub_apps WHERE package = ? AND status = 'active'",
    [String(packageId || '').trim().toLowerCase()]);
}

async function openOrderFor(packageId) {
  return db.get(
    `SELECT * FROM tester_fill_orders WHERE package = ?
       AND status IN ('awaiting_payment', 'filling', 'full')
     ORDER BY created_at DESC LIMIT 1`,
    [String(packageId || '').trim().toLowerCase()]);
}

async function confirmedCount(orderId) {
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM tester_fill_confirmations WHERE fill_order_id = ?',
    [orderId]);
  return (row && row.n) || 0;
}

async function developerName(gmail) {
  const p = await db.get(
    'SELECT display_name FROM tester_hub_developers WHERE gmail = ?', [gmail]);
  return (p && p.display_name) || null;
}

async function writeEvent(kind, order, extra = {}) {
  await db.insert('tester_fill_events', {
    kind,
    package: order.package,
    app_name: extra.app_name || order.app_name || '',
    developer_name: extra.developer_name ?? order.developer_name ?? null,
    confirmed_count: extra.confirmed_count ?? null,
    target: order.target,
    wave: extra.wave ?? order.wave,
    elapsed_ms: extra.elapsed_ms ?? null,
    created_at: db.now(),
  });
}

// Route the next wave: the next WAVE_SIZE active pool members (roster
// order) who have not been routed to this order and have not already
// confirmed. Returns how many were routed (0 = pool exhausted).
async function routeWave(order) {
  if (!order.app_name) {
    const app = await appRow(order.package);
    order.app_name = app ? app.app_name : '';
    order.developer_name = await developerName(order.developer_gmail);
  }
  const roster = await db.all(
    "SELECT email FROM tester_signups WHERE status = 'active' ORDER BY created_at ASC");
  const routed = new Set((await db.all(
    'SELECT tester_gmail FROM tester_fill_wave_members WHERE fill_order_id = ?',
    [order.id])).map((r) => r.tester_gmail));
  const confirmed = new Set((await db.all(
    'SELECT tester_gmail FROM tester_fill_confirmations WHERE fill_order_id = ?',
    [order.id])).map((r) => r.tester_gmail));
  const next = roster.map((r) => r.email)
    .filter((e) => !routed.has(e) && !confirmed.has(e))
    .slice(0, WAVE_SIZE);
  const waveNo = Number(order.wave) + 1;
  const now = db.now();
  for (const email of next) {
    await db.insert('tester_fill_wave_members', {
      fill_order_id: order.id, wave: waveNo, tester_gmail: email, routed_at: now,
    });
  }
  if (next.length) {
    await db.update('tester_fill_orders', order.id, { wave: waveNo, updated_at: now });
    order.wave = waveNo;
    await writeEvent('wave_out', order, { wave: waveNo });
  }
  return next.length;
}

// Lazy cycle advance, run on reads and writes: close a run whose
// 14 days ended; top a FULL order back up if its count fell inside
// the run; push the next wave when the current one is exhausted or
// stalled. Idempotent — safe to call on every request.
async function advance(order) {
  if (!order || (order.status !== 'filling' && order.status !== 'full')) return order;
  const now = db.now();
  if (order.run_ends_at && now > Number(order.run_ends_at)) {
    await db.update('tester_fill_orders', order.id, { status: 'closed', updated_at: now });
    order.status = 'closed';
    return order;
  }
  const count = await confirmedCount(order.id);
  if (order.status === 'full' && count < Number(order.target)) {
    // A confirmed tester dropped inside the run: free top-up.
    await db.update('tester_fill_orders', order.id, { status: 'filling', full_at: null, updated_at: now });
    order.status = 'filling';
    await writeEvent('topup', order, { confirmed_count: count });
    await routeWave(order);
    return order;
  }
  if (order.status === 'filling' && count < Number(order.target)) {
    const members = await db.all(
      'SELECT tester_gmail, routed_at FROM tester_fill_wave_members WHERE fill_order_id = ? AND wave = ?',
      [order.id, order.wave]);
    if (!members.length) { await routeWave(order); return order; }
    const confirmed = new Set((await db.all(
      'SELECT tester_gmail FROM tester_fill_confirmations WHERE fill_order_id = ?',
      [order.id])).map((r) => r.tester_gmail));
    const allConfirmed = members.every((m) => confirmed.has(m.tester_gmail));
    const stalled = now - Math.max(...members.map((m) => Number(m.routed_at))) > WAVE_STALL_MS;
    if (allConfirmed || stalled) await routeWave(order);
  }
  return order;
}

// Create a fill order for a developer's app. The order is born
// 'awaiting_payment': it holds the app's place and its price, and it
// can do NOTHING else until the entitlement grant lands.
async function createFillOrder({ package: pkg, developer_gmail }) {
  const app = await appRow(pkg);
  if (!app) return { ok: false, error: 'add the app to FillMyList first, then start its fill' };
  const devGmail = normalizeGmail(developer_gmail);
  if (!isGmail(devGmail)) return { ok: false, error: 'a developer Gmail is required' };
  if (!app.developer_gmail || app.developer_gmail !== devGmail) {
    return { ok: false, error: 'that Gmail is not the developer on this app’s Hub listing' };
  }
  const existing = await openOrderFor(app.package);
  if (existing) {
    return { ok: true, created: false, order: await publicOrder(existing) };
  }
  const now = db.now();
  const id = await db.insert('tester_fill_orders', {
    app_id: app.id, package: app.package, developer_gmail: devGmail,
    price_cents: PRICE_CENTS, status: 'awaiting_payment', wave: 0,
    target: TARGET, purchase_ref: null, simulated: 0,
    run_started_at: null, run_ends_at: null, full_at: null,
    created_at: now, updated_at: now,
  });
  const order = await db.get('SELECT * FROM tester_fill_orders WHERE id = ?', [id]);
  return { ok: true, created: true, order: await publicOrder(order) };
}

// THE ENTITLEMENT GATE (service-token route only). This is the single
// door from 'awaiting_payment' to 'filling': wave 1 routes the moment
// it opens. Mirrors profilePlug.grantEntitlement's managed pattern.
async function grantFillEntitlement({ package: pkg, purchase_ref, simulated }) {
  const order = await openOrderFor(pkg);
  if (!order) return { ok: false, error: 'no open fill order for that package' };
  if (order.status !== 'awaiting_payment') {
    return { ok: false, error: `order is ${order.status} — the entitlement is already granted` };
  }
  const app = await appRow(order.package);
  const now = db.now();
  await db.update('tester_fill_orders', order.id, {
    status: 'filling',
    purchase_ref: String(purchase_ref || '').slice(0, 120) || null,
    simulated: simulated ? 1 : 0,
    run_started_at: now, run_ends_at: now + RUN_MS, updated_at: now,
  });
  const fresh = await db.get('SELECT * FROM tester_fill_orders WHERE id = ?', [order.id]);
  fresh.app_name = app ? app.app_name : '';
  fresh.developer_name = await developerName(order.developer_gmail);
  await writeEvent('fill_started', fresh, {});
  await routeWave(fresh);
  return { ok: true, order: await publicOrder(fresh) };
}

// A tester confirms their opt-in (after Google's page accepted them).
// Pool members only; the order must be cycling; idempotent per tester.
async function confirmOptIn({ package: pkg, gmail }) {
  const email = normalizeGmail(gmail);
  if (!isGmail(email)) return { ok: false, error: 'a Gmail address is required' };
  const member = await db.get(
    "SELECT id FROM tester_signups WHERE email = ? AND status = 'active'", [email]);
  if (!member) return { ok: false, error: 'join the pool first — confirmations count for pool members' };
  const order = await openOrderFor(pkg);
  if (!order) return { ok: false, error: 'no fill is running for that app' };
  await advance(order);
  if (order.status !== 'filling') {
    return { ok: false, error: order.status === 'full' ? 'that list is already FULL' : 'that fill is not running' };
  }
  const dupe = await db.get(
    'SELECT id FROM tester_fill_confirmations WHERE fill_order_id = ? AND tester_gmail = ?',
    [order.id, email]);
  if (dupe) {
    return { ok: true, confirmed: true, already_confirmed: true, count: await confirmedCount(order.id), target: Number(order.target) };
  }
  await db.insert('tester_fill_confirmations', {
    fill_order_id: order.id, package: order.package, tester_gmail: email, confirmed_at: db.now(),
  });
  const count = await confirmedCount(order.id);
  const app = await appRow(order.package);
  order.app_name = app ? app.app_name : '';
  order.developer_name = await developerName(order.developer_gmail);
  await writeEvent('tester_confirmed', order, { confirmed_count: count });
  if (count >= Number(order.target)) {
    const now = db.now();
    await db.update('tester_fill_orders', order.id, { status: 'full', full_at: now, updated_at: now });
    await writeEvent('full', order, {
      confirmed_count: count,
      elapsed_ms: order.run_started_at ? now - Number(order.run_started_at) : null,
    });
    return { ok: true, confirmed: true, count, target: Number(order.target), full: true };
  }
  await advance(order);
  return { ok: true, confirmed: true, count, target: Number(order.target), full: false };
}

// A confirmed tester leaves the app's test (or reports they were
// removed): their confirmation is deleted; inside the run the cycle
// tops back up for free (see advance()).
async function dropOut({ package: pkg, gmail }) {
  const email = normalizeGmail(gmail);
  if (!isGmail(email)) return { ok: false, error: 'a Gmail address is required' };
  const order = await openOrderFor(pkg);
  if (!order) return { ok: false, error: 'no fill is running for that app' };
  const row = await db.get(
    'SELECT id FROM tester_fill_confirmations WHERE fill_order_id = ? AND tester_gmail = ?',
    [order.id, email]);
  if (!row) return { ok: false, error: 'no confirmation on record for that Gmail' };
  await db.query('DELETE FROM tester_fill_confirmations WHERE id = ?', [row.id]);
  await advance(order);
  return { ok: true, dropped: true, count: await confirmedCount(order.id), target: Number(order.target) };
}

async function publicOrder(order) {
  if (!order) return null;
  const count = await confirmedCount(order.id);
  return {
    package: order.package,
    status: order.status,
    price_cents: Number(order.price_cents),
    confirmed: count,
    target: Number(order.target),
    wave: Number(order.wave),
    run_started_at: order.run_started_at ? Number(order.run_started_at) : null,
    run_ends_at: order.run_ends_at ? Number(order.run_ends_at) : null,
    full_at: order.full_at ? Number(order.full_at) : null,
    simulated: Number(order.simulated) === 1,
  };
}

async function fillStatus({ package: pkg, developer_gmail }) {
  const order = await openOrderFor(pkg);
  if (!order) return { ok: false, error: 'no fill order for that app yet' };
  const devGmail = normalizeGmail(developer_gmail);
  if (devGmail && order.developer_gmail !== devGmail) {
    return { ok: false, error: 'that Gmail is not the developer on this fill' };
  }
  await advance(order);
  const fresh = await db.get('SELECT * FROM tester_fill_orders WHERE id = ?', [order.id]);
  return { ok: true, order: await publicOrder(fresh) };
}

// Fill decoration for one app row in the public feed: present only
// while an order is cycling or full (an unpaid order never shows).
async function fillForApp(packageId) {
  const order = await openOrderFor(packageId);
  if (!order || order.status === 'awaiting_payment') return null;
  await advance(order);
  const fresh = await db.get('SELECT * FROM tester_fill_orders WHERE id = ?', [order.id]);
  if (!fresh || fresh.status === 'closed' || fresh.status === 'awaiting_payment') return null;
  const pub = await publicOrder(fresh);
  return { status: pub.status, confirmed: pub.confirmed, target: pub.target, wave: pub.wave };
}

// The dopamine light board. Real events only; when nothing has
// happened yet the board says so (the founding state) instead of
// inventing lights. Tester flavor derives ONLY from live cycle facts
// (apps filling + their true counts, apps added today).
async function lightBoard(limit = 12) {
  const events = await db.all(
    'SELECT * FROM tester_fill_events ORDER BY created_at DESC LIMIT ?',
    [Math.min(Number(limit) || 12, 50)]);
  const developer = events.map((e) => ({
    kind: e.kind,
    app_name: e.app_name,
    developer_name: e.developer_name || null,
    confirmed_count: e.confirmed_count != null ? Number(e.confirmed_count) : null,
    target: e.target != null ? Number(e.target) : null,
    wave: e.wave != null ? Number(e.wave) : null,
    elapsed_ms: e.elapsed_ms != null ? Number(e.elapsed_ms) : null,
    at: Number(e.created_at),
  }));
  const filling = await db.all(
    `SELECT o.package, o.target, a.app_name FROM tester_fill_orders o
       LEFT JOIN tester_hub_apps a ON a.id = o.app_id
      WHERE o.status = 'filling' ORDER BY o.run_started_at ASC`);
  const tester = [];
  for (const f of filling) {
    const order = await db.get('SELECT * FROM tester_fill_orders WHERE package = ? AND status = \'filling\'', [f.package]);
    tester.push({
      app_name: f.app_name || f.package,
      confirmed: await confirmedCount(order.id),
      target: Number(f.target),
    });
  }
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const newToday = await db.get(
    'SELECT COUNT(*) AS n FROM tester_hub_apps WHERE created_at >= ? AND status = \'active\'',
    [dayStart.getTime()]);
  return {
    ok: true,
    founding: developer.length === 0 && tester.length === 0,
    developer,
    tester,
    new_apps_today: (newToday && newToday.n) || 0,
  };
}

module.exports = {
  PRICE_CENTS, TARGET, WAVE_SIZE, RUN_MS,
  createFillOrder, grantFillEntitlement, confirmOptIn, dropOut,
  fillStatus, fillForApp, lightBoard,
};
