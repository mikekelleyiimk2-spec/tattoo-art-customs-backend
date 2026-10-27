// Pending ties — the sideload half of the guest bridge (migration
// 113, owner ruling 2026-10-26 19:21 + refinement 19:23, contract
// §10). A guest DESIGN purchase bridges on buy (seatClaims
// .startPurchaseClaim). A guest PAID-APP purchase does NOT: while
// an app is sideload-only its buyers stay guests like everyone
// else, and the purchase records a pending tie here instead —
// buyer email x app x order, durable until the app goes live on
// the store.
//
// Go-live is a flag flip, not a build: POST
// /api/onemind/pending-ties/fire (Muse service token) with
// { app_key } calls firePendingTies, which (a) marks the app live
// in app_store_live, (b) fires ONE bridge claim per buyer with
// pending ties for that app (dedupe lives in startPurchaseClaim —
// a buyer with five orders gets one email), and (c) marks those
// ties fired. After the flip, bridgeAppPurchase claims on buy for
// that app, exactly like the design lane.
//
// app_key is the checkout flow's app identifier: the buy-app
// package name (e.g. com.usefulappz.odometer), 'tac_android_pro',
// or 'ios_app'. Nothing in here ever throws into a checkout path —
// payment is already captured when the bridge runs.
const db = require('../db');
const seatClaims = require('./seatClaims');

// Record one purchase's pending tie. Idempotent per order (the
// order_id unique index is the backstop; a repeat call returns the
// existing row's state instead of erroring).
async function recordPendingTie({ email, appKey, orderId }) {
  const normalized = String(email || '').trim().toLowerCase().slice(0, 160);
  const existing = await db.get(
    'SELECT * FROM guest_pending_ties WHERE order_id = ?', [String(orderId)]);
  if (existing) return { ok: true, created: false, tie: existing };
  try {
    const id = await db.insert('guest_pending_ties', {
      email: normalized, app_key: String(appKey), order_id: String(orderId),
      status: 'pending', claim_id: null, fired_at: null,
    });
    return { ok: true, created: true, tie: { id, email: normalized, app_key: String(appKey), order_id: String(orderId), status: 'pending' } };
  } catch (e) {
    const row = await db.get(
      'SELECT * FROM guest_pending_ties WHERE order_id = ?', [String(orderId)]);
    if (row) return { ok: true, created: false, tie: row };
    throw e;
  }
}

async function isAppLive(appKey) {
  const row = await db.get(
    'SELECT live FROM app_store_live WHERE app_key = ?', [String(appKey)]);
  return !!row && Number(row.live) === 1;
}

async function markAppLive(appKey) {
  const now = db.now();
  await db.upsert('app_store_live', 'app_key', {
    app_key: String(appKey), live: 1, live_at: now, updated_at: now,
  });
  return { app_key: String(appKey), live: true, live_at: now };
}

// The go-live trigger. Marks the app live, then fires one bridge
// claim per distinct buyer holding pending ties for the app and
// stamps those ties fired (with the claim that carries them — a
// fresh one, or the pending/recent claim startPurchaseClaim
// deduped onto, which does the same job when tapped).
async function firePendingTies(appKey) {
  const key = String(appKey || '');
  await markAppLive(key);
  const buyers = await db.all(
    "SELECT DISTINCT email FROM guest_pending_ties WHERE app_key = ? AND status = 'pending'",
    [key]);
  let claimsMailed = 0;
  let tiesFired = 0;
  for (const b of buyers) {
    const res = await seatClaims.startPurchaseClaim(b.email);
    if (res.mailed) claimsMailed++;
    const claimId = res.claim_id || null;
    const rows = await db.all(
      "SELECT id FROM guest_pending_ties WHERE app_key = ? AND email = ? AND status = 'pending'",
      [key, b.email]);
    for (const r of rows) {
      await db.update('guest_pending_ties', r.id, {
        status: 'fired', claim_id: claimId, fired_at: db.now(),
      });
      tiesFired++;
    }
  }
  return { app_key: key, live: true, buyers: buyers.length, claims_mailed: claimsMailed, ties_fired: tiesFired };
}

// The bridge entry point the paid-app checkout routes call after a
// guest purchase completes: live app -> claim now (design-lane
// behavior); sideload-only app -> pending tie, no email.
async function bridgeAppPurchase(order, appKey) {
  const email = String((order && order.guest_email) || '').trim().toLowerCase();
  if (!email || !appKey) return { ok: false, error: 'missing_email_or_app' };
  if (await isAppLive(appKey)) {
    const res = await seatClaims.startPurchaseClaim(email);
    return { ok: res.ok, mode: 'claim', ...res };
  }
  const res = await recordPendingTie({ email, appKey, orderId: order.id });
  return { ok: res.ok !== false, mode: 'pending_tie', created: res.created };
}

// The book view for the service lane: per-app pending/fired counts
// plus the live flags. Aggregates only — no buyer emails leave.
async function pendingTieBook() {
  const rows = await db.all(
    `SELECT app_key, status, COUNT(*) AS ties, COUNT(DISTINCT email) AS buyers
     FROM guest_pending_ties GROUP BY app_key, status ORDER BY app_key, status`);
  const liveRows = await db.all('SELECT app_key, live, live_at FROM app_store_live ORDER BY app_key');
  const live = {};
  for (const r of liveRows) {
    live[r.app_key] = { live: Number(r.live) === 1, live_at: r.live_at == null ? null : Number(r.live_at) };
  }
  return { apps: rows.map((r) => ({
    app_key: r.app_key, status: r.status,
    ties: Number(r.ties || 0), buyers: Number(r.buyers || 0),
  })), live };
}

module.exports = { recordPendingTie, isAppLive, markAppLive, firePendingTies, bridgeAppPurchase, pendingTieBook };
