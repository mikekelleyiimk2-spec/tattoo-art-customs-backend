// Brambleforce website sale door (owner orders 2026-10-30: the
// completed game sells on our own doors FIRST — this website — at full
// price, every in-app purchase available; Google's door joins when
// Google catches up).
//
//   GET  /brambleforce                          — landing / storefront
//   GET  /brambleforce/buy/:productId           — buy page (game + 13 IAPs)
//   POST /brambleforce/buy/:productId/buy       — order + PayPal checkout
//   GET  /brambleforce/buy/:productId/approve/:orderId — PayPal return
//   GET  /brambleforce/buy/:productId/success/:orderId — durable purchase page
//   POST /api/brambleforce/redeem               — the game's REDEEM CODE call
//
// Checkout mirrors the fleet paid-sideload pattern (routes/buyApp.js):
// guests buy with just a delivery email ('' buyer sentinel + HMAC
// checkout token), members with their login. The game order carries
// order_type `sideload:<package>` so the gated app-updates route serves
// the APK; IAP orders carry `brambleforce:<product>` and mint a
// single-use unlock code at capture (lib/brambleforce).
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const pricing = require('../lib/pricing');
const paypal = require('../lib/paypal');
const updateTokens = require('../lib/updateTokens');
const guestCheckout = require('../lib/guestCheckout');
const bf = require('../lib/brambleforce');
const seatVerify = require('../lib/seatVerify');
const rolodex = require('../lib/rolodex');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');

const guestScope = (productId) => `brambleforce:${productId}`;

// ---- checkout idempotency (buy-button hang recurrence, 2026-10-31) ----
// The buy page renders a per-render checkout key (`ck`, hidden field).
// The first POST with a key records a pending marker in site_kv BEFORE
// creating anything, and the finished PayPal approve URL when creation
// succeeds. A twin POST with the same key — the stall watchdog restoring
// the form at 60s while the original request is still in flight, or a
// buyer re-tap on a flaky connection — waits for / replays the SAME
// checkout instead of minting a second order + second PayPal order.
// Without a key (old cached pages, tests) the flow is unchanged.
const CK_RE = /^[a-z0-9_-]{8,64}$/i;
async function ckGet(key) {
  try {
    const row = await db.get('SELECT val FROM site_kv WHERE name = ?', [`bfck:${key}`]);
    return row ? JSON.parse(row.val) : null;
  } catch (e) { return null; }
}
async function ckSet(key, obj) {
  try {
    await db.query(
      `INSERT INTO site_kv (name, val, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET val = excluded.val, updated_at = excluded.updated_at`,
      [`bfck:${key}`, JSON.stringify(obj), db.now()]);
  } catch (e) { /* best-effort: a lost marker only loses dedupe */ }
}
async function ckDel(key) {
  try { await db.query('DELETE FROM site_kv WHERE name = ?', [`bfck:${key}`]); } catch (e) { /* best-effort */ }
}

function partners() {
  // Penny Sweeper affiliate door: placements pulled LIVE from the
  // Affiliate Rolodex for this surface (whole entries — link + code +
  // disclosure travel together). Renders nothing until a program is
  // honestly placed on the BRAMBLEFORCE surface.
  try { return rolodex.queryLive({ surface: 'BRAMBLEFORCE' }); } catch (e) { return []; }
}

function resolveProduct(req, res, next) {
  const p = bf.product(req.params.productId);
  if (!p) {
    return res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  }
  req.bfProduct = p;
  req.bfProductId = req.params.productId;
  return next();
}

// Purchase gate (rotation system, owner order 2026-10-31): applied to
// the buy page + the buy POST ONLY — never to approve/success, so a
// buyer who paid inside a window keeps their durable purchase page
// after it closes. A disabled product (seeded future stock) is dark:
// same 404 as an unknown id. An out-of-window product refuses
// gracefully and says why; redemption is untouched by any of this —
// an unlock code already issued redeems forever.
function requirePurchasable(req, res, next) {
  const p = req.bfProduct;
  if (p.disabled) {
    return res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  }
  const state = bf.windowState(p);
  if (state === 'open') return next();
  if (state === 'after') {
    return res.status(410).render('error', {
      title: 'This drop has ended',
      message: `${p.name} was part of a limited drop that has ended — it is no longer on sale. If you already bought it, it is still yours: your unlock code redeems in the game forever. Ownership never expires.`,
    });
  }
  return res.status(404).render('error', {
    title: 'Not on sale yet',
    message: `${p.name} goes on sale ${bf.dayLabel(p.availableFrom)}. It is not purchasable yet.`,
  });
}

// Shared gate for approve + success: guest orders prove ownership with
// the HMAC checkout token (?gt=); member orders need the buyer's own
// login. Returns the order, or null after responding.
async function loadBfOrder(req, res, { paidOnly }) {
  const order = await db.get(
    `SELECT * FROM orders WHERE id = ? AND order_type = ?${paidOnly ? " AND status = 'paid'" : ''}`,
    [req.params.orderId, bf.orderType(req.bfProductId)]
  );
  if (!order) {
    res.status(paidOnly ? 403 : 404).render('error', {
      title: paidOnly ? 'Not available' : 'Not found',
      message: paidOnly ? 'This purchase page is not available.' : 'Order not found.',
    });
    return null;
  }
  if (guestCheckout.isGuestOrder(order)) {
    if (guestCheckout.verifyGuestToken(req.query.gt, guestScope(req.bfProductId)) !== String(order.id)) {
      res.status(403).render('error', {
        title: 'Invalid checkout link',
        message: 'This guest checkout link is not valid. If you completed payment and cannot reach your purchase page, contact us through the contact page with your PayPal receipt and we will sort you out.',
      });
      return null;
    }
    return order;
  }
  if (!req.user) {
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return null;
  }
  if (order.buyer_id !== req.user.id) {
    res.status(paidOnly ? 403 : 404).render('error', {
      title: paidOnly ? 'Not available' : 'Not found',
      message: paidOnly ? 'This purchase page is not available.' : 'Order not found.',
    });
    return null;
  }
  return order;
}

function successPath(req, order) {
  const base = `/brambleforce/buy/${req.bfProductId}/success/${order.id}`;
  return guestCheckout.isGuestOrder(order)
    ? `${base}?gt=${encodeURIComponent(guestCheckout.guestToken(order.id, guestScope(req.bfProductId)))}`
    : base;
}

async function buyerEmail(order) {
  if (guestCheckout.isGuestOrder(order)) return order.guest_email;
  const u = await db.get('SELECT email FROM users WHERE id = ?', [order.buyer_id]);
  return u ? u.email : null;
}

function pageRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    // Rotation (2026-10-31): the permanent grid carries only what is
    // purchasable today and not part of a drop; a live drop renders in
    // its own section (see the view), a recently ended one shows
    // retired there. With no drop in either state, dropInfo is null
    // and the page is exactly the launch storefront.
    const drop = bf.dropInfo();
    const inDrop = new Set(drop && drop.mode === 'active' ? drop.productIds : []);
    const permanentIds = bf.purchasableIds().filter((id) => !inDrop.has(id));
    res.render('site/brambleforce', {
      layout: 'layout-brambleforce',
      title: 'Brambleforce — Run-and-Gun Through a Killer Garden',
      metaDescription: 'Brambleforce for Android — $6.99, 11 missions, 4 fighters, 11 bosses, zero ads. Buy direct and sideload the APK today.',
      products: bf.PRODUCTS,
      productIds: permanentIds,
      drop,
      partners: partners(),
      disclosureStandard: rolodex.disclosureStandard(),
      user: req.user || null,
    });
  });

  // Founding Figure interest page (owner approved 2026-11-03, $0
  // route): the first Brambleforce figure (Tor, 6" statue) is NOT in
  // production — no sculpt exists, no price is set, nothing here is
  // for sale. The page is an honest interest list: joining means one
  // email if and when the figure opens. Signups land in
  // founding_figure_signups (migration 125) — the same per-list table
  // pattern as the app-launch notify list (043).
  router.get('/founding-figure', (req, res) => {
    res.render('site/brambleforce-founding-figure', {
      layout: 'layout-brambleforce',
      title: 'The Founding Figure — the first Brambleforce statue (interest list)',
      metaDescription: 'The first Brambleforce figure would be Tor "Hammer" Halvorsen as a 6-inch statue. It is not in production yet — join the interest list and we will email you if it opens. No price, no pre-order.',
      products: bf.PRODUCTS,
      partners: partners(),
      disclosureStandard: rolodex.disclosureStandard(),
      user: req.user || null,
    });
  });

  router.post('/founding-figure', formLimiter, checkHoneypot, async (req, res) => {
    const email = guestCheckout.parseGuestEmail(req.body && req.body.email);
    if (!email) {
      req.session.flash = 'Enter a valid email address and we will put you on the Founding Figure list.';
      return res.redirect('/brambleforce/founding-figure#figure-list');
    }
    try {
      const existing = await db.get('SELECT id FROM founding_figure_signups WHERE email = ?', [email]);
      if (!existing) {
        await db.insert('founding_figure_signups', { email, created_at: db.now(), notified_at: null });
      }
      // Read the row back before claiming success: the flash may only
      // promise a list spot that storage actually confirms.
      const row = await db.get('SELECT id FROM founding_figure_signups WHERE email = ?', [email]);
      if (!row) throw new Error('signup read-back failed');
      req.session.flash = existing
        ? 'That email is already on the Founding Figure list — you are in. We will email you if the figure opens.'
        : 'You are on the Founding Figure list. If the Tor statue opens, this email gets the word first.';
    } catch (e) {
      console.error('founding-figure signup failed:', e.message);
      req.session.flash = 'Something went wrong saving that — please try again in a moment.';
    }
    return res.redirect('/brambleforce/founding-figure#figure-list');
  });

  router.get('/buy/:productId', resolveProduct, requirePurchasable, (req, res) => {
    // Never let a browser pin a stale copy of a buy page: the checkout
    // key, watchdog and form all ship with this document, and a cached
    // pre-fix page on a buyer's phone must not outlive its fix.
    res.set('Cache-Control', 'no-store');
    const p = req.bfProduct;
    res.render('site/brambleforce-buy', {
      layout: 'layout-brambleforce',
      title: `Get ${p.name} — Brambleforce`,
      metaDescription: `${p.name} — $${(p.priceCents / 100).toFixed(2)}. ${p.blurb}`,
      product: p,
      productId: req.bfProductId,
      price: p.priceCents,
      checkoutKey: crypto.randomBytes(12).toString('hex'),
      partners: partners(),
      disclosureStandard: rolodex.disclosureStandard(),
      user: req.user || null,
    });
  });

  router.post('/buy/:productId/buy', resolveProduct, requirePurchasable, formLimiter, checkHoneypot, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const t0 = Date.now();
    const p = req.bfProduct;
    const productId = req.bfProductId;
    const guest = !req.user;
    // Handoff page, not a bare 302: the success response is a small
    // page that navigates itself to PayPal and carries a manual
    // "Continue to PayPal" button. A form POST's 302 is subject to CSP
    // form-action in Chrome/Safari (the 2026-10-31 hang — see the
    // formAction note in src/index.js), and a buyer must never be
    // stranded on "Working…" with no visible way forward. The CSP fix
    // makes the old 302 legal again; this page makes the flow robust
    // even where a client swallows a redirect (embedded browsers,
    // custom tabs), and its button IS the fallback.
    const handoff = (approveUrl) => res.render('site/brambleforce-handoff', {
      layout: 'layout-brambleforce',
      title: `Taking you to PayPal — ${p.name}`,
      product: p,
      productId,
      price: p.priceCents,
      approveUrl,
      user: req.user || null,
    });
    let guestEmail = null;
    if (guest) {
      guestEmail = guestCheckout.parseGuestEmail(req.body.guest_email);
      if (!guestEmail) {
        req.session.flash = 'Enter the email address your purchase should be delivered to.';
        return res.redirect(`/brambleforce/buy/${productId}`);
      }
    }
    // Idempotent checkout: replay / wait on a twin submission carrying
    // the same per-render checkout key (see ckGet above).
    const ck = typeof (req.body && req.body.ck) === 'string' && CK_RE.test(req.body.ck) ? req.body.ck : null;
    if (ck) {
      const rec = await ckGet(ck);
      const age = rec ? Date.now() - (rec.ts || 0) : Infinity;
      if (rec && rec.approve && age < 30 * 60 * 1000) {
        console.log(`[bf-buy] ${productId} idempotent replay order=${rec.orderId} key=${ck}`);
        return handoff(rec.approve);
      }
      if (rec && rec.pending && age < 45000) {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 400));
          const again = await ckGet(ck);
          if (again && again.approve) return handoff(again.approve);
          if (!again) break; // creator failed and cleared the marker
        }
        const final = await ckGet(ck);
        if (final && final.approve) return handoff(final.approve);
        // Creator is stale/dead — take over below.
      }
      await ckSet(ck, { pending: true, ts: Date.now() });
    }
    const price = p.priceCents;
    const fee = pricing.processingFeeCents(price);
    const orderId = await db.insert('orders', {
      buyer_id: guest ? '' : req.user.id, order_type: bf.orderType(productId),
      amount_cents: price, fee_cents: fee, status: 'pending', payment_method: 'paypal',
      guest_email: guestEmail,
      created_at: db.now(),
    });
    const tDb = Date.now();
    try {
      const pp = await paypal.createCheckoutOrder({
        amountCents: price + fee,
        description: p.kind === 'game' ? p.name : `Brambleforce — ${p.name}`,
        returnUrl: guest
          ? `${config.baseUrl}/brambleforce/buy/${productId}/approve/${orderId}?gt=${guestCheckout.guestToken(orderId, guestScope(productId))}`
          : `${config.baseUrl}/brambleforce/buy/${productId}/approve/${orderId}`,
        cancelUrl: `${config.baseUrl}/brambleforce/buy/${productId}`,
      });
      await db.update('orders', orderId, { paypal_order_id: pp.id });
      const approve = pp.links.find((l) => l.rel === 'approve');
      if (ck) await ckSet(ck, { orderId, approve: approve.href, ts: Date.now() });
      // Segment timings: the next "hang" report should be diagnosable
      // from Render logs alone (db leg vs PayPal leg vs total).
      console.log(`[bf-buy] ${productId} order=${orderId} db=${tDb - t0}ms paypal=${Date.now() - tDb}ms total=${Date.now() - t0}ms ${guest ? 'guest' : 'member'}`);
      handoff(approve.href);
    } catch (e) {
      if (ck) await ckDel(ck);
      console.error(`brambleforce ${productId} PayPal order create failed after ${Date.now() - t0}ms:`, e.message);
      req.session.flash = 'PayPal checkout is unavailable right now — try again later.';
      res.redirect(`/brambleforce/buy/${productId}`);
    }
  });

  router.get('/buy/:productId/approve/:orderId', resolveProduct, async (req, res) => {
    const p = req.bfProduct;
    const productId = req.bfProductId;
    const order = await loadBfOrder(req, res, { paidOnly: false });
    if (!order) return;
    if (order.status === 'paid') return res.redirect(successPath(req, order));
    try {
      const captureFn = paypal.captureOrder || paypal.captureCheckoutOrder;
      const capture = await captureFn(order.paypal_order_id);
      const expectedTotal = order.amount_cents + order.fee_cents;
      const captured = Math.round(parseFloat(capture.purchase_units[0].payments.captures[0].amount.value) * 100);
      if (captured !== expectedTotal) {
        // Fulfillment verifies the captured amount against the order
        // at the moment of capture — a mismatch is refused AND
        // recorded in the verify watch (cadence pass 2026-11-01).
        await seatVerify.logEvent({
          kind: 'fulfillment_mismatch',
          detail: `${productId}: captured ${captured} != expected ${expectedTotal} (order ${order.id})`,
          userId: order.buyer_id || null, req,
        });
        throw new Error('Amount mismatch');
      }
      await db.update('orders', order.id, { status: 'paid', paid_at: db.now() });
      const email = await buyerEmail(order);
      const successUrl = `${config.baseUrl}${successPath(req, order)}`;
      if (p.kind === 'game') {
        // Result logged loudly inside sendGameEmail; the redirect +
        // flash below promise only the download page itself, never
        // the email, so nothing here depends on whether it sent.
        await bf.sendGameEmail({ to: email, successUrl, orderId: order.id });
        if (guestCheckout.isGuestOrder(order)) {
          // Guest bridge (owner ruling 2026-10-26, contract section 10):
          // sideload buyers stay guests until the app is live on the
          // store — record the pending tie. Best-effort.
          await guestCheckout.bridgeGuestPurchase(order, bf.PACKAGE);
        }
        req.session.flash = 'Payment complete — your Brambleforce download is ready.';
        return res.redirect(successPath(req, order));
      }
      // IAP: mint the single-use unlock code and render the success
      // page WITH the code in this response (hash-only at rest in the
      // DB, as designed). Two delivery truths are carried honestly:
      //   - codeEmailed is the ACTUAL sendCodeEmail result — the page
      //     may only call the email a durable copy when it truly sent
      //     (2026-10-31: a buyer was told his code was emailed while
      //     the server's mail door was unconfigured and nothing sent).
      //   - the raw code is ALSO kept in the buyer's server-side
      //     session (session-only, never persisted, never logged) so
      //     the success page keeps showing it across refreshes and
      //     the paid-branch redirect below — a reload of this approve
      //     URL used to eat the only showing and strand the buyer on
      //     the code-less durable page, which is exactly what the
      //     owner hit on 2026-10-31.
      const issued = await bf.issueCodeForOrder(order, productId);
      let codeEmailed = false;
      if (issued.code) {
        try {
          if (req.session) {
            req.session.bfCodes = req.session.bfCodes || {};
            req.session.bfCodes[order.id] = issued.code;
          }
        } catch (e) { /* the one-time render below still carries the code */ }
        const mailResult = await bf.sendCodeEmail({ to: email, productId, code: issued.code, successUrl, orderId: order.id });
        codeEmailed = !!(mailResult && mailResult.sent);
      }
      return res.render('site/brambleforce-success', {
        layout: 'layout-brambleforce',
        title: `Unlock code — ${p.name}`,
        product: p,
        productId,
        code: issued.code || null,
        codeEmailed: issued.code ? codeEmailed : false,
        order,
        user: req.user || null,
      });
    } catch (e) {
      console.error(`brambleforce ${productId} PayPal capture failed:`, e.message);
      req.session.flash = 'Payment could not be completed — try again.';
      return res.redirect(`/brambleforce/buy/${productId}`);
    }
  });

  // Durable purchase page. Game: re-mints the gated APK token on every
  // visit (the APK bytes are never on a public URL). IAP: the raw code
  // is hash-only at rest in the DB and cannot be re-shown from there —
  // BUT the buyer who just paid carries a session copy (stored at
  // issuance, server-side session only): while that session lives and
  // the code is still unspent, this page shows the code again, so a
  // refresh, a back-button trip, or the approve route's paid-branch
  // redirect can never eat the buyer's only showing. Once the code is
  // redeemed the session copy is dropped. With no session copy, the
  // page is honest about the email (it may or may not have arrived)
  // and gives the support path. Access stays gated by loadBfOrder
  // (guest HMAC token or the buyer's own login) either way.
  router.get('/buy/:productId/success/:orderId', resolveProduct, async (req, res) => {
    const p = req.bfProduct;
    const order = await loadBfOrder(req, res, { paidOnly: true });
    if (!order) return;
    const isGame = p.kind === 'game';
    const token = isGame ? updateTokens.issue(order.id, bf.PACKAGE) : null;
    let sessionCode = null;
    if (!isGame && req.session && req.session.bfCodes && req.session.bfCodes[order.id]) {
      const row = await db.get('SELECT spent FROM brambleforce_codes WHERE order_id = ?', [order.id]);
      if (row && !Number(row.spent)) {
        sessionCode = req.session.bfCodes[order.id];
      } else {
        // Redeemed (or the row is gone): the session copy dies with it.
        try { delete req.session.bfCodes[order.id]; } catch (e) { /* best-effort */ }
      }
    }
    res.render('site/brambleforce-success', {
      layout: 'layout-brambleforce',
      title: isGame ? 'Download Brambleforce' : `Your purchase — ${p.name}`,
      product: p,
      productId: req.bfProductId,
      code: sessionCode,
      // null = "showing the session copy; whether the email arrived is
      // not something this later page-load can claim" — the view has a
      // distinct neutral wording for it.
      codeEmailed: sessionCode ? null : false,
      downloadUrl: isGame ? `/api/apps/${bf.PACKAGE}/apk?t=${token}` : null,
      token,
      order,
      user: req.user || null,
    });
  });

  return router;
}

// ---- redeem API (mounted under /api) ----------------------------------
// The game page runs on a file:///android_asset origin and POSTs JSON
// cross-origin, so this ONE endpoint carries its own scoped CORS
// headers (the site at large has none). Codes are single-use with a
// large guessing space; the limiter caps attempts per IP regardless.
const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10000 : 60,
  standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'rate_limited' }),
});

function redeemCors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
}

// ---- support reissue (service-token only) ------------------------------
// POST /api/brambleforce/support-reissue { orderId }
// For a PAID IAP order whose unlock code never reached the buyer (the
// 2026-10-31 CRT purchase: payment captured, code email never sent, the
// one-time page never seen; the original code is hash-only at rest and
// unrecoverable by design). Revokes the lost code and mints a fresh one
// (lib reissueCodeForOrder), returns the raw code ONCE to the token
// holder — house ops — and also fires the site's own code email as a
// second delivery leg. Auth is the house Muse service-token convention
// (same as /api/muse/*): the route 404s when MUSE_SERVICE_TOKEN is
// unset, 401s on a bad bearer. Never reachable by buyers.
function supportAuthorized(req) {
  const expected = process.env.MUSE_SERVICE_TOKEN || '';
  if (!expected) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = Buffer.from(m[1], 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Seat binding at redemption (Chorvix verification layer, migration
// 122): the shipped game redeems with a bare { code } and that
// contract does not change — possession of the single-use code is
// the proof, and the response for a proof-less call stays exactly
// {product} | {error}. A caller that ALSO presents a seat proof
// (x-api-token, a session token via Authorization/x-session-token,
// or body seat_token/session_token) gets the unlock BOUND to that
// seat in seat_entitlements, so the seat owns it on every platform
// from then on (lib/seatVerify entitlementsFor reads the binding).
// Every outcome lands in the integrity watch: bound, unbound,
// rejected (forged / replayed codes are recorded behavior), and a
// presented-but-invalid seat proof is recorded as such and binds
// nothing. Binding is best-effort: it can never fail a redemption
// the code itself earned.
async function bindRedeemSeat(req, code, result) {
  const body = req.body || {};
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const sessionToken = (bearer && bearer[1].trim())
    || String(req.get('x-session-token') || body.session_token || body.seat_token || '').trim()
    || null;
  const apiToken = String(req.get('x-api-token') || body.api_token || '').slice(0, 128) || null;
  const presented = !!(sessionToken || apiToken);
  let bound = false;
  let trap = null;
  try {
    if (presented) {
      const proof = await seatVerify.resolveSeatProof({ apiToken, sessionToken, req });
      if (proof && proof.user) {
        if (result.product) {
          const codeRow = await db.get(
            'SELECT * FROM brambleforce_codes WHERE code_hash = ?', [bf.hashCode(code)]);
          if (codeRow) {
            await seatVerify.bindCodeRedemption(proof.user, codeRow, result.product, result.grants);
            bound = true;
            await seatVerify.logEvent({
              user: proof.user, kind: 'redeem_bound', detail: result.product, req,
            });
          }
        } else {
          await seatVerify.logEvent({
            user: proof.user, kind: 'redeem_rejected', detail: result.error || 'unknown', req,
          });
          // THIEF TRAP (owner design 2026-11-01 20:40): a REPLAYED
          // unlock presented by a proven seat springs the trap on
          // the spot — no ban, the game turns on them. A forged
          // (unknown) code is a strike; repeated strikes spring it
          // too (lib/seatVerify strikeOrTrap). A proof-less replay
          // identifies no seat — it is recorded above, and there is
          // nobody to trap.
          if (result.error === 'spent') {
            await seatVerify.setTrap(proof.user, 'replayed_unlock', 'redeem_rejected', 'spent', { req });
          } else if (result.error === 'unknown') {
            await seatVerify.strikeOrTrap(proof.user, 'redeem_rejected', 'unknown', { req });
          }
        }
        trap = await seatVerify.trapStateFor(proof.user.id);
      } else {
        await seatVerify.logEvent({
          kind: 'redeem_seat_proof_invalid',
          detail: (proof && proof.reason) || 'unknown_proof', req,
        });
        if (result.error) {
          await seatVerify.logEvent({ kind: 'redeem_rejected', detail: result.error, req });
        } else {
          await seatVerify.logEvent({ kind: 'redeem_unbound', detail: result.product, req });
        }
      }
    } else if (result.error) {
      await seatVerify.logEvent({ kind: 'redeem_rejected', detail: result.error, req });
    } else {
      await seatVerify.logEvent({ kind: 'redeem_unbound', detail: result.product, req });
    }
  } catch (e) {
    console.error('brambleforce redeem seat binding failed:', e.message);
  }
  return { presented, bound, trap };
}

function apiRouter() {
  const router = express.Router();
  router.use('/brambleforce/redeem', redeemCors, redeemLimiter);
  router.post('/brambleforce/redeem', async (req, res) => {
    const code = req.body && typeof req.body.code === 'string' ? req.body.code : '';
    const result = await bf.redeemCode(code);
    const { presented, bound, trap } = await bindRedeemSeat(req, code, result);
    // Proof-less calls keep the exact legacy response; a caller that
    // presented a seat proof additionally learns whether it bound —
    // and its thief-trap state (migration 124), so a trapped seat
    // hears it on the redeem door too.
    return res.status(200).json(presented ? { ...result, bound, trap } : result);
  });
  router.use('/brambleforce/support-reissue', redeemLimiter);
  router.post('/brambleforce/support-reissue', async (req, res) => {
    if (!process.env.MUSE_SERVICE_TOKEN) return res.status(404).json({ ok: false });
    if (!supportAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const orderId = req.body && typeof req.body.orderId === 'string' ? req.body.orderId : '';
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order || !String(order.order_type || '').startsWith('brambleforce:')) {
      return res.status(404).json({ ok: false, error: 'order not found' });
    }
    const productId = String(order.order_type).slice('brambleforce:'.length);
    const p = bf.product(productId);
    if (!p) return res.status(404).json({ ok: false, error: 'order not found' });
    if (p.kind !== 'iap') {
      return res.status(400).json({ ok: false, error: 'not a code product' });
    }
    if (order.status !== 'paid') {
      return res.status(409).json({ ok: false, error: 'order is not paid' });
    }
    const issued = await bf.reissueCodeForOrder(order, productId);
    const email = await buyerEmail(order);
    let siteEmail = { sent: false, error: 'no_recipient' };
    if (email) {
      const base = `${bf.baseUrl()}/brambleforce/buy/${productId}/success/${order.id}`;
      const successUrl = guestCheckout.isGuestOrder(order)
        ? `${base}?gt=${encodeURIComponent(guestCheckout.guestToken(order.id, guestScope(productId)))}`
        : base;
      siteEmail = await bf.sendCodeEmail({
        to: email,
        productId,
        code: issued.code,
        successUrl,
        orderId: order.id,
      });
    }
    return res.status(200).json({
      ok: true, orderId: order.id, product: productId, code: issued.code,
      revoked: issued.revoked, buyerEmail: email, siteEmail,
    });
  });

  // ---- Founding Figure list ops (service-token only) -------------------
  // POST /api/brambleforce/founding-figure-ops { action: 'list' } |
  // { action: 'remove', email } — house-ops read/remove for the interest
  // list (migration 125), same auth convention as support-reissue above:
  // 404 while MUSE_SERVICE_TOKEN is unset, 401 on a bad bearer. The
  // public page only accepts signups; reading or pruning the list is an
  // ops door, never a public one.
  router.use('/brambleforce/founding-figure-ops', redeemLimiter);
  router.post('/brambleforce/founding-figure-ops', async (req, res) => {
    if (!process.env.MUSE_SERVICE_TOKEN) return res.status(404).json({ ok: false });
    if (!supportAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const action = req.body && typeof req.body.action === 'string' ? req.body.action : '';
    if (action === 'list') {
      const rows = await db.all('SELECT email, created_at FROM founding_figure_signups ORDER BY created_at ASC');
      return res.status(200).json({ ok: true, count: rows.length, signups: rows });
    }
    if (action === 'remove') {
      const email = guestCheckout.parseGuestEmail(req.body && req.body.email);
      if (!email) return res.status(400).json({ ok: false, error: 'email required' });
      await db.query('DELETE FROM founding_figure_signups WHERE email = ?', [email]);
      const row = await db.get('SELECT id FROM founding_figure_signups WHERE email = ?', [email]);
      return res.status(200).json({ ok: true, removed: !row, email });
    }
    return res.status(400).json({ ok: false, error: 'unknown action' });
  });
  return router;
}

module.exports = { pageRouter, apiRouter };
