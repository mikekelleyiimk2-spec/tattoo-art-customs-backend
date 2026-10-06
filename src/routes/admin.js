// Admin dashboard: sales log, payout balances + runs, members,
// upload/bio/message review queue, referral verification queue,
// order management (confirm manual payments, attach custom files).
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { resolveStoredPath } = require('../lib/storage');
const { requireLogin, requireRole, requireHeadAdmin, isAdminRole, isHeadAdmin } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { recordSaleCommissions, verifyOrderCommissions } = require('../lib/commissions');
const { onOrderPaid } = require('../lib/printful');
const { routeCustomOrder } = require('../lib/customFulfillment');
const { onCustomPieceSold } = require('../lib/replacements');
const { fulfillPremadeOrder } = require('../lib/fulfillment');
const { colorizationQueue, attachColorVersion, notifyDesignLive } = require('../lib/colorization');
const { recordTask: recordAdminTask } = require('../lib/adminTaskPay');
const { verifyShop } = require('../shop/verification');

const router = express.Router();

// Stop impersonating — must be registered BEFORE the admin guard below,
// because while impersonating a non-admin account req.user is that account
// and would fail requireRole('admin').
router.post('/stop-impersonating', requireLogin, async (req, res) => {
  if (req.session.impersonatorId) {
    const adminId = req.session.impersonatorId;
    delete req.session.impersonatorId;
    req.session.userId = adminId;
    req.session.flash = 'Back to your admin account.';
  }
  res.redirect('/admin/members');
});

router.use(requireLogin, requireRole('admin'));

// Start impersonating a user (head admin only): browse the site exactly as
// that account. The original admin id is kept in the session so we can
// switch back. Cannot impersonate another head_admin or yourself.
router.get('/members/:id/impersonate', requireHeadAdmin, async (req, res) => {
  const target = await db.get('SELECT id, email, role FROM users WHERE id = ?', [req.params.id]);
  if (!target || target.id === req.user.id || target.role === 'head_admin') {
    req.session.flash = 'You can\'t switch to that account.';
    return res.redirect('/admin/members');
  }
  req.session.impersonatorId = req.user.id;
  req.session.userId = target.id;
  try {
    await db.insert('review_queue', {
      item_type: 'note', item_id: target.id,
      reason: `Head admin ${req.user.email} started impersonating ${target.email}`,
      status: 'closed', created_at: db.now(), reviewed_at: db.now(),
    });
  } catch (e) { console.error('impersonation audit log failed:', e.message); }
  req.session.flash = `Now viewing as ${target.email}.`;
  res.redirect('/account');
});

// Per-task admin pay (owner rule 2026-09-29): every paid admin action below
// records task pay for the acting admin out of the site's overhead. A
// bookkeeping failure must never break the admin action itself.
async function payAdmin(req, taskType, refType, refId) {
  try {
    await recordAdminTask({ adminUserId: req.user.id, taskType, refType, refId });
  } catch (e) {
    console.error(`admin task pay failed (${taskType}/${refType}/${refId}):`, e.message);
  }
}

router.get('/', async (req, res) => {
  const stats = {
    users: (await db.get('SELECT COUNT(*) AS n FROM users')).n,
    designs: (await db.get('SELECT COUNT(*) AS n FROM designs')).n,
    pendingDesigns: (await db.get("SELECT COUNT(*) AS n FROM designs WHERE status = 'pending'")).n,
    orders: (await db.get('SELECT COUNT(*) AS n FROM orders')).n,
    revenue: (await db.get("SELECT COALESCE(SUM(amount_paid_cents),0) AS t FROM orders WHERE status = 'paid'")).t,
    openReviews: (await db.get("SELECT COUNT(*) AS n FROM review_queue WHERE status = 'open'")).n,
    payableOut: (await db.get("SELECT COALESCE(SUM(amount_cents),0) AS t FROM commission_ledger WHERE status = 'payable'")).t,
  };
  // Designer deadline watch: 2-3 missed deadlines in 30 days = "at risk",
  // 4+ = repeat offender with doubled late-penalty rates. users.sla_suspended
  // is a manual-admin-only flag — automatic enforcement never touches it.
  const { offenderWatch } = require('../lib/slaEnforcer');
  const designerWatch = await offenderWatch({ now: Date.now() });
  const terminatedOrders = await db.all(
    `SELECT o.id, o.replacement_status, u.email AS buyer_email
     FROM orders o JOIN users u ON u.id = o.buyer_id
     WHERE o.designer_contract_terminated = 1 AND o.custom_status NOT IN ('delivered')
     ORDER BY o.delivery_due ASC`);
  // Head-admin test-account switcher: the owner's own test accounts, so the
  // admin landing page can jump straight into viewing the site as the
  // tattoo shop, designer, or customer account. Looked up by email so the
  // links never go stale if user ids change.
  const TEST_ACCOUNT_EMAILS = [
    'tattooartcustoms@gmail.com',   // tattoo_shop (TAC Test Shop)
    'mikekelleyii.mk4@gmail.com',   // design_artist (MK Test Designer)
    'mikekelleyii.mk@gmail.com',    // customer (MK Test Customer)
  ];
  let testAccounts = [];
  if (req.user && req.user.role === 'head_admin') {
    const rows = await db.all(
      'SELECT id, email, display_name, role FROM users WHERE email IN (?, ?, ?)',
      TEST_ACCOUNT_EMAILS
    );
    const roleOrder = { tattoo_shop: 0, design_artist: 1, customer: 2 };
    testAccounts = rows
      .filter(u => u.role !== 'head_admin')
      .sort((a, b) => (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9));
  }
  res.render('admin/dashboard', {
    title: 'Admin — Tattoo Art Customs', stats, designerWatch, terminatedOrders,
    testAccounts,
  });
});

// Manual designer restriction (admin action only — nothing automatic sets this).
router.post('/designers/:id/restrict', formLimiter, checkHoneypot, async (req, res) => {
  const user = await db.get(
    `SELECT u.id FROM users u LEFT JOIN shop_profiles sp ON sp.user_id = u.id
     WHERE u.id = ? AND (u.role = 'design_artist' OR u.role = 'tattoo_shop')`,
    [req.params.id]);
  if (user) await db.update('users', user.id, { sla_suspended: 1 });
  if (user) await payAdmin(req, 'designer_restrict', 'user', user.id);
  req.session.flash = 'Designer marked as manually restricted (marker for your review — orders still route normally).';
  res.redirect('/admin');
});

router.post('/designers/:id/unsuspend', formLimiter, checkHoneypot, async (req, res) => {
  const user = await db.get(
    `SELECT u.id FROM users u LEFT JOIN shop_profiles sp ON sp.user_id = u.id
     WHERE u.id = ? AND (u.role = 'design_artist' OR u.role = 'tattoo_shop')`,
    [req.params.id]);
  if (user) await db.update('users', user.id, { sla_suspended: 0 });
  if (user) await payAdmin(req, 'designer_unsuspend', 'user', user.id);
  req.session.flash = 'Manual restriction lifted.';
  res.redirect('/admin');
});

// Forgive / reset a designer's missed-deadline count: misses at or before now
// stop counting toward the trailing-30-day repeat-offender window.
router.post('/designers/:id/forgive', formLimiter, checkHoneypot, async (req, res) => {
  const user = await db.get(
    `SELECT u.id FROM users u LEFT JOIN shop_profiles sp ON sp.user_id = u.id
     WHERE u.id = ? AND (u.role = 'design_artist' OR u.role = 'tattoo_shop')`,
    [req.params.id]);
  if (user) await db.update('users', user.id, { sla_forgiven_at: Date.now() });
  if (user) await payAdmin(req, 'designer_forgive', 'user', user.id);
  req.session.flash = 'Missed-deadline count reset — late penalties return to normal rates.';
  res.redirect('/admin');
});

// Lift a Tier-2 commission suspension early (admin action only).
router.post('/designers/:id/lift-suspension', formLimiter, checkHoneypot, async (req, res) => {
  const user = await db.get(
    `SELECT u.id FROM users u LEFT JOIN shop_profiles sp ON sp.user_id = u.id
     WHERE u.id = ? AND (u.role = 'design_artist' OR u.role = 'tattoo_shop')`,
    [req.params.id]);
  if (user) await db.update('users', user.id, { commission_suspended_until: null });
  if (user) await payAdmin(req, 'designer_lift', 'user', user.id);
  req.session.flash = 'Commission suspension lifted early — the designer earns commissions on new sales again.';
  res.redirect('/admin');
});

// --- Sales log ---
router.get('/orders', async (req, res) => {
  const orders = await db.all(
    `SELECT o.*, u.email AS buyer_email, d.title AS design_title FROM orders o
     JOIN users u ON u.id = o.buyer_id LEFT JOIN designs d ON d.id = o.design_id
     ORDER BY o.created_at DESC LIMIT 100`);
  res.render('admin/orders', { title: 'Orders — Admin', orders });
});

// Confirm a manual (CashApp/Venmo) payment.
router.post('/orders/:id/confirm-manual', formLimiter, checkHoneypot, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order || order.status !== 'pending' || order.payment_method === 'paypal') {
    req.session.flash = 'Only pending manual-payment orders can be confirmed.';
    return res.redirect('/admin/orders');
  }
  const due = order.order_type === 'custom' ? order.deposit_cents : order.amount_cents;
  // The buyer was asked to send base + processing fee (see the manual-payment page).
  await db.update('orders', order.id, { status: 'paid', amount_paid_cents: due + (order.fee_cents || 0), paid_at: db.now() });
  const fresh = await db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
  await recordSaleCommissions(fresh);
  // Design-contest prize escrow paid manually: open the contest for entries.
  if (fresh.order_type === 'contest') {
    const contest = await db.get('SELECT id FROM contests WHERE order_id = ?', [fresh.id]);
    if (contest) {
      await require('../lib/contests').openContest(contest.id, {
        paidCents: (fresh.amount_paid_cents || 0),
        paymentMethod: fresh.payment_method || 'manual',
      });
    }
  }
  const fulfil = await onOrderPaid(fresh);
  await routeCustomOrder(fresh);
  await onCustomPieceSold(fresh); // sold custom pieces delist + queue a replacement
  await fulfillPremadeOrder(fresh); // premades deliver instantly: token + receipt email
  try { await require('../lib/saleWatch').watchOrderPaid(fresh); } catch (e) { console.error('sale watch failed:', e.message); }
  await payAdmin(req, 'order_confirm_manual', 'order', order.id);
  req.session.flash = 'Manual payment confirmed — buyer download unlocked, commissions recorded.' +
    (fulfil.submitted ? ' Print auto-submitted to Printful.' : '');
  res.redirect('/admin/orders');
});

// Verify a referred sale (releases the shop's 20% to payable).
router.post('/orders/:id/verify-referral', formLimiter, checkHoneypot, async (req, res) => {
  const n = await verifyOrderCommissions(req.params.id);
  if (n) await payAdmin(req, 'order_verify_referral', 'order', req.params.id);
  req.session.flash = n ? `Sale verified — ${n} commission share(s) released.` : 'Nothing pending for this order.';
  res.redirect('/admin/orders');
});

// Attach finished custom-design files to an order.
const customStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.uploadDir, 'designs');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 5) || '.jpg';
    cb(null, `custom-${req.params.id}-${Date.now()}-${file.fieldname}${ext}`);
  },
});
const uploadCustom = multer({
  storage: customStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, or WebP images are allowed.'));
  },
}).fields([{ name: 'color', maxCount: 1 }, { name: 'linework', maxCount: 1 }]);

router.post('/orders/:id/attach', formLimiter, (req, res, next) => {
  uploadCustom(req, res, (err) => {
    if (err) { req.session.flash = err.message; return res.redirect('/admin/orders'); }
    next();
  });
}, checkHoneypot, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order) return res.redirect('/admin/orders');
  const data = {};
  if (req.files?.color) data.custom_color_path = path.relative(config.uploadDir, req.files.color[0].path);
  if (req.files?.linework) data.custom_linework_path = path.relative(config.uploadDir, req.files.linework[0].path);
  if (Object.keys(data).length) {
    await db.update('orders', order.id, data);
    req.session.flash = 'Custom design files attached — the buyer can now download them.';
  }
  res.redirect('/admin/orders');
});

// --- Custom 48h fulfillment queue ---
const { FULFILLMENT_STATUSES, draftsDir, parseDrafts } = require('../lib/customFulfillment');

router.get('/custom-orders', async (req, res) => {
  const filter = String(req.query.status || 'open');
  let where = "o.order_type = 'custom' AND o.status = 'paid'";
  const params = [];
  if (filter === 'open') where += " AND o.custom_status NOT IN ('delivered')";
  else if (FULFILLMENT_STATUSES.includes(filter)) { where += ' AND o.custom_status = ?'; params.push(filter); }
  const orders = await db.all(
    `SELECT o.*, u.email AS buyer_email, u.display_name AS buyer_name,
            a.display_name AS artist_name
     FROM orders o JOIN users u ON u.id = o.buyer_id
     LEFT JOIN users a ON a.id = o.requested_artist_id
     WHERE ${where} ORDER BY (o.rush_fee_cents > 0) DESC, o.delivery_due ASC`, params);
  const counts = {};
  for (const s of FULFILLMENT_STATUSES) {
    const r = await db.get(
      `SELECT COUNT(*) AS n FROM orders WHERE order_type = 'custom' AND status = 'paid' AND custom_status = ?`, [s]);
    counts[s] = r.n;
  }
  res.render('admin/custom-orders', {
    title: 'Custom orders — Admin', orders, counts, filter, now: Date.now(),
  });
});

router.get('/custom-orders/:id', async (req, res) => {
  const order = await db.get(
    `SELECT o.*, u.email AS buyer_email, u.display_name AS buyer_name,
            a.display_name AS artist_name, a.email AS artist_email
     FROM orders o JOIN users u ON u.id = o.buyer_id
     LEFT JOIN users a ON a.id = o.requested_artist_id
     WHERE o.id = ? AND o.order_type = 'custom'`, [req.params.id]);
  if (!order) return res.status(404).render('error', { title: 'Not found', message: 'Custom order not found.' });
  const artists = await db.all(
    "SELECT id, display_name, COALESCE(sla_suspended, 0) AS manual_restricted FROM users WHERE role = 'design_artist' ORDER BY display_name");
  const { penaltyLedger } = require('../lib/slaEnforcer');
  const penalties = await penaltyLedger(order.id);
  const penaltyTotals = penalties.reduce((s, p) => ({
    deduction: s.deduction + p.deduction_cents,
    owner: s.owner + p.owner_cents,
    credit: s.credit + p.credit_cents,
  }), { deduction: 0, owner: 0, credit: 0 });
  const designerLedger = order.requested_artist_id ? await db.all(
    `SELECT * FROM commission_ledger WHERE order_id = ? AND recipient_type = 'artist' AND recipient_id = ?
     ORDER BY created_at DESC`,
    [order.id, order.requested_artist_id]) : [];
  res.render('admin/custom-order-detail', {
    title: `Custom order ${order.id.slice(0, 8)} — Admin`,
    order, artists, drafts: parseDrafts(order), now: Date.now(),
    penalties, penaltyTotals, designerLedger,
  });
});

router.post('/custom-orders/:id/approve', formLimiter, checkHoneypot, async (req, res) => {
  const order = await db.get("SELECT * FROM orders WHERE id = ? AND order_type = 'custom'", [req.params.id]);
  if (!order) return res.redirect('/admin/custom-orders');
  await db.update('orders', order.id, { custom_status: 'approved' });
  await payAdmin(req, 'custom_approve', 'custom_order', order.id);
  req.session.flash = 'Drafts approved — attach the final files from the sales log to deliver.';
  res.redirect(`/admin/custom-orders/${order.id}`);
});

// --- Site-wide gift cards (owner rule 2026-09-30) ---
// Admin: review pending manual payments, confirm them (activates the card:
// code issued + emailed), and track physical-mail shipments.
router.get('/site-gift-cards', async (req, res) => {
  const filter = String(req.query.filter || 'all');
  let where = '1 = 1';
  if (filter === 'unshipped') where = 'g.ship_pending = 1 AND g.shipped_at IS NULL AND g.status = \'active\'';
  else if (filter === 'pending') where = 'g.status = \'pending\'';
  const cards = await db.all(
    `SELECT g.*, u.email AS purchaser_email, u.display_name AS purchaser_name
     FROM site_gift_cards g JOIN users u ON u.id = g.purchaser_user_id
     WHERE ${where} ORDER BY g.created_at DESC LIMIT 200`);
  res.render('admin/site-gift-cards', {
    title: 'Site Gift Cards — Admin', cards, filter,
  });
});

// Confirm a manual (CashApp/Venmo) payment: activates the card — the
// unguessable code is issued and emailed only now that payment is verified.
router.post('/site-gift-cards/:id/confirm', formLimiter, checkHoneypot, async (req, res) => {
  const { activateSiteGiftCardManual } = require('../lib/siteGiftCards');
  try {
    const card = await activateSiteGiftCardManual(req.params.id);
    req.session.flash = `Gift card confirmed — code ${card.code} issued and emailed.`;
  } catch (e) {
    req.session.flash = 'Could not confirm: ' + e.message;
  }
  res.redirect('/admin/site-gift-cards?filter=pending');
});

// Mark a physical card as mailed.
router.post('/site-gift-cards/:id/ship', formLimiter, checkHoneypot, async (req, res) => {
  const { markSiteGiftCardShipped } = require('../lib/siteGiftCards');
  await markSiteGiftCardShipped(req.params.id);
  req.session.flash = 'Gift card marked as shipped.';
  res.redirect('/admin/site-gift-cards?filter=unshipped');
});

router.post('/custom-orders/:id/request-changes', formLimiter, checkHoneypot, async (req, res) => {
  const order = await db.get("SELECT * FROM orders WHERE id = ? AND order_type = 'custom'", [req.params.id]);
  if (!order) return res.redirect('/admin/custom-orders');
  const note = String(req.body.note || '').trim().slice(0, 2000);
  const stamped = `[${new Date().toISOString()}] Revision requested: ${note || '(no note)'}\n`;
  await db.update('orders', order.id, {
    custom_status: 'in_revision', admin_notes: (order.admin_notes || '') + stamped,
  });
  await payAdmin(req, 'custom_request_changes', 'custom_order', order.id);
  req.session.flash = 'Sent back for revision.';
  res.redirect(`/admin/custom-orders/${order.id}`);
});

router.post('/custom-orders/:id/reassign', formLimiter, checkHoneypot, async (req, res) => {
  const order = await db.get("SELECT * FROM orders WHERE id = ? AND order_type = 'custom'", [req.params.id]);
  if (!order) return res.redirect('/admin/custom-orders');
  const artistId = String(req.body.requested_artist_id || '').trim();
  const artist = artistId
    ? await db.get(
      `SELECT id, email, display_name FROM users
       WHERE id = ? AND role = 'design_artist'`, [artistId])
    : null;
  if (artistId && !artist) {
    req.session.flash = 'That artist was not found.';
    return res.redirect(`/admin/custom-orders/${order.id}`);
  }
  await db.update('orders', order.id, {
    requested_artist_id: artist ? artist.id : null,
    custom_status: artist ? 'routed_to_artist' : 'needs_drafts',
  });
  await payAdmin(req, 'custom_reassign', 'custom_order', order.id);
  if (artist) {
    const { recordCustomDesignerCommission } = require('../lib/commissions');
    await recordCustomDesignerCommission(order, artist.id);
    const { notifyArtist } = require('../lib/customFulfillment');
    await notifyArtist({ ...order, requested_artist_id: artist.id }, artist);
    req.session.flash = `Reassigned to ${artist.display_name || artist.email}.`;
  } else {
    req.session.flash = 'Unassigned — order returned to the draft pipeline.';
  }
  res.redirect(`/admin/custom-orders/${order.id}`);
});

// --- Day-7 replacement options (purchaser chooses after order termination) ---
router.post('/custom-orders/:id/replacement', formLimiter, checkHoneypot, async (req, res) => {
  const order = await db.get("SELECT * FROM orders WHERE id = ? AND order_type = 'custom'", [req.params.id]);
  if (!order) return res.redirect('/admin/custom-orders');
  const action = String(req.body.action || '');
  const { addCredit } = require('../lib/credits');
  const { recordCustomDesignerCommission } = require('../lib/commissions');
  const { notifyArtist } = require('../lib/customFulfillment');

  if (action === 'new_designer') {
    const artistId = String(req.body.requested_artist_id || '').trim();
    const artist = await db.get(
      `SELECT id, email, display_name FROM users
       WHERE id = ? AND role = 'design_artist'`, [artistId]);
    if (!artist) {
      req.session.flash = 'Pick a designer from the list.';
      return res.redirect(`/admin/custom-orders/${order.id}`);
    }
    await db.update('orders', order.id, {
      requested_artist_id: artist.id, custom_status: 'routed_to_artist',
      replacement_status: 'new_designer', designer_contract_terminated: 0,
      late_penalty_days: 0, delivery_due: Date.now() + 48 * 3600 * 1000,
    });
    await recordCustomDesignerCommission(order, artist.id);
    await notifyArtist({ ...order, requested_artist_id: artist.id }, artist);
    req.session.flash = `New designer assigned (${artist.display_name || artist.email}) — fresh 48-hour deadline.`;
  } else if (action === 'owner_makes') {
    await db.update('orders', order.id, {
      requested_artist_id: null, custom_status: 'needs_drafts',
      replacement_status: 'owner_makes', designer_contract_terminated: 0,
      late_penalty_days: 0, delivery_due: Date.now() + 48 * 3600 * 1000,
    });
    req.session.flash = 'You are making this design — it is back in the draft pipeline with a fresh 48-hour deadline.';
  } else if (action === 'credit') {
    const cents = Math.max(0, parseInt(req.body.credit_cents, 10) || order.amount_paid_cents || 0);
    if (cents > 0) {
      await addCredit({
        userId: order.buyer_id, amountCents: cents, kind: 'replacement_credit', refId: order.id,
        note: `Replacement credit — custom order ${order.id.slice(0, 8)} (order terminated)`,
      });
    }
    await db.update('orders', order.id, { replacement_status: 'credit' });
    req.session.flash = `Website credit issued: $${(cents / 100).toFixed(2)}.`;
  } else if (action === 'predesigns') {
    await db.update('orders', order.id, { replacement_status: 'predesigns' });
    req.session.flash = 'Recorded: equivalent value in pre-designs + edits. Fulfill from the catalog, then mark delivered.';
  } else {
    req.session.flash = 'Unknown replacement action.';
  }
  if (['new_designer', 'owner_makes', 'credit', 'predesigns'].includes(action)) {
    await payAdmin(req, 'replacement_close', 'custom_order', order.id);
  }
  res.redirect(`/admin/custom-orders/${order.id}`);
});

router.post('/custom-orders/:id/deliver', formLimiter, checkHoneypot, async (req, res) => {
  const order = await db.get("SELECT * FROM orders WHERE id = ? AND order_type = 'custom'", [req.params.id]);
  if (!order) return res.redirect('/admin/custom-orders');
  await db.update('orders', order.id, { custom_status: 'delivered' });
  await payAdmin(req, 'custom_deliver', 'custom_order', order.id);
  req.session.flash = 'Marked delivered. (Attach final files from the sales log if you have not already.)';
  res.redirect(`/admin/custom-orders/${order.id}`);
});

// Draft images: admin-only, never mounted as public static.
router.get('/custom-orders/:id/draft/:file', async (req, res) => {
  const order = await db.get("SELECT id FROM orders WHERE id = ? AND order_type = 'custom'", [req.params.id]);
  if (!order) return res.status(404).send('Not found');
  const file = path.basename(String(req.params.file));
  const full = path.join(draftsDir(order.id), file);
  if (!full.startsWith(draftsDir(order.id))) return res.status(403).send('Forbidden');
  if (!fs.existsSync(full)) return res.status(404).send('Not found');
  res.sendFile(full);
});

// --- Review queue (flagged designs, bios, messages, shop profiles) ---
router.get('/reviews', async (req, res) => {
  const items = await db.all("SELECT * FROM review_queue WHERE status = 'open' ORDER BY created_at DESC");
  res.render('admin/reviews', { title: 'Review queue — Admin', items });
});

router.post('/reviews/:id/approve', formLimiter, checkHoneypot, async (req, res) => {
  const item = await db.get('SELECT * FROM review_queue WHERE id = ?', [req.params.id]);
  if (!item) return res.redirect('/admin/reviews');
  const result = await applyReviewDecision(item, 'approve');
  if (result === 'blocked-no-watermark') {
    req.session.flash = 'Blocked: upload the watermarked linework version before approving this design.';
  } else {
    await db.update('review_queue', item.id, { status: 'approved', reviewed_at: db.now(), decided_by: req.user.id });
    await payAdmin(req, 'review_approve', 'review', item.id);
  }
  res.redirect('/admin/reviews');
});

router.post('/reviews/:id/reject', formLimiter, checkHoneypot, async (req, res) => {
  const item = await db.get('SELECT * FROM review_queue WHERE id = ?', [req.params.id]);
  if (!item) return res.redirect('/admin/reviews');
  await applyReviewDecision(item, 'reject');
  await db.update('review_queue', item.id, { status: 'rejected', reviewed_at: db.now(), decided_by: req.user.id });
  await payAdmin(req, 'review_reject', 'review', item.id);
  res.redirect('/admin/reviews');
});

async function applyReviewDecision(item, decision) {
  if (item.item_type === 'design') {
    if (decision === 'approve') {
      const design = await db.get('SELECT linework_wm_path FROM designs WHERE id = ?', [item.item_id]);
      if (!design || !design.linework_wm_path) return 'blocked-no-watermark';
    }
    await db.update('designs', item.item_id, { status: decision === 'approve' ? 'approved' : 'rejected' });
    if (decision === 'approve') {
      const { completeOnApproval } = require('../lib/replacements');
      await completeOnApproval(item.item_id); // remake of a sold custom piece → close the request
    }
  } else if (item.item_type === 'bio') {
    await db.updateWhere('artist_profiles', { bio_status: decision === 'approve' ? 'ok' : 'blocked' }, 'user_id', item.item_id);
  } else if (item.item_type === 'message') {
    if (decision === 'approve') await db.update('messages', item.item_id, { screened: 0 });
    else await db.query('DELETE FROM messages WHERE id = ?', [item.item_id]);
  } else if (item.item_type === 'shop') {
    await db.updateWhere('shop_profiles', { profile_status: decision === 'approve' ? 'ok' : 'blocked' }, 'user_id', item.item_id);
  }
}

// Approve a pending design directly from the designs list.
// A design CANNOT go live until its watermarked linework exists — the
// public gallery must never show clean color or clean linework.
router.post('/designs/:id/approve', formLimiter, checkHoneypot, async (req, res) => {
  const design = await db.get('SELECT linework_wm_path, listing_type, status FROM designs WHERE id = ?', [req.params.id]);
  if (!design) return res.redirect('/admin/designs');
  if (!design.linework_wm_path) {
    req.session.flash = 'Blocked: upload the watermarked linework version before approving — the public gallery only ever shows watermarked linework.';
    return res.redirect('/admin/designs');
  }
  // Linework-only pieces are approvable: they post with the watermarked
  // linework and the site color version follows via the colorization queue.
  await db.update('designs', req.params.id, { status: 'approved', approved_by: req.user.id });
  await payAdmin(req, 'design_approve', 'design', req.params.id);
  { const { completeOnApproval } = require('../lib/replacements');
    await completeOnApproval(req.params.id); } // remake of a sold custom piece → close the request
  // The piece is now live: notify the designer (informational only —
  // no designer approval gate exists for site-created color). The notice
  // names the admin who approved it.
  try { await notifyDesignLive(req.params.id, req.user.display_name || req.user.email); } catch (e) {
    console.error('design-live notification failed:', e.message);
  }
  req.session.flash = design.listing_type === 'custom'
    ? 'Design approved — it is now live in the artist\u2019s portfolio (portfolio-only; not in the main gallery).'
    : 'Design approved — it is now live in the gallery.';
  res.redirect('/admin/designs');
});
router.post('/designs/:id/reject', formLimiter, checkHoneypot, async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 1000);
  if (!reason) {
    req.session.flash = 'Give a reason — the artist must be told why within 2 hours of upload.';
    return res.redirect('/admin/designs');
  }
  const design = await db.get('SELECT id, title, artist_id FROM designs WHERE id = ?', [req.params.id]);
  await db.update('designs', req.params.id, { status: 'rejected', reject_reason: reason });
  await payAdmin(req, 'design_reject', 'design', req.params.id);
  // The artist gets the reason by on-site notification + email, naming the
  // admin who decided.
  if (design && design.artist_id) {
    const { notifyUser } = require('../lib/notify');
    const { sendMail } = require('../lib/mail');
    const decidedBy = req.user.display_name || req.user.email || 'an administrator';
    const title = `Your piece was not approved: "${design.title || 'untitled'}"`;
    const body = `Thanks for uploading "${design.title || 'untitled'}". It was not approved for the gallery/portfolio.\n\nReason: ${reason}\n\nDecided by: ${decidedBy}\n\nYou may submit ONE appeal to the site owner for a final decision.`;
    await notifyUser(design.artist_id, { kind: 'design_rejected', title, body, link: '/artist/portfolio' });
    try {
      const artist = await db.get('SELECT email FROM users WHERE id = ?', [design.artist_id]);
      if (artist && artist.email) await sendMail({ to: artist.email, subject: title, text: body });
    } catch (e) { console.error('reject notify email failed:', e.message); }
  }
  req.session.flash = 'Design rejected — the artist has been sent the reason.';
  res.redirect('/admin/designs');
});
// Racist/hateful material goes on hold: only a human admin may approve or
// reject it afterwards — it is never auto-approved. All admins are notified.
router.post('/designs/:id/hold', formLimiter, checkHoneypot, async (req, res) => {
  const design = await db.get('SELECT id, title FROM designs WHERE id = ?', [req.params.id]);
  if (!design) return res.redirect('/admin/designs');
  await db.update('designs', req.params.id, { status: 'on_hold' });
  await payAdmin(req, 'design_hold', 'design', req.params.id);
  const { notifyAdmins } = require('../lib/notify');
  const config = require('../config');
  await notifyAdmins({
    kind: 'design_on_hold',
    title: `On hold — admin decision needed: "${design.title || 'untitled'}"`,
    body: `A piece was placed on hold (possible racist/hateful content) and needs a personal admin decision to approve or reject. It will NOT be auto-approved.`,
    link: '/admin/designs',
    emailSubject: `[Tattoo Art Customs] ON HOLD — decision needed: "${design.title || 'untitled'}"`,
    emailText: `A piece was placed on hold and needs a personal admin decision (approve or reject).\n\nReview it: ${config.baseUrl}/admin/designs\n\nOn-hold pieces are never auto-approved.`,
  });
  req.session.flash = 'Design placed on hold — all admins have been notified. Only a personal admin decision can approve or reject it.';
  res.redirect('/admin/designs');
});

// --- Appeals: one per rejected design, decided ONLY by the site owner
// (head_admin). The owner's decision is final.
router.get('/appeals', async (req, res) => {
  const appeals = await db.all(
    `SELECT a.*, d.title AS design_title, d.status AS design_status, d.linework_wm_path,
            u.display_name AS artist_name, u.email AS artist_email
     FROM design_appeals a
     JOIN designs d ON d.id = a.design_id
     LEFT JOIN users u ON u.id = a.artist_id
     ORDER BY CASE WHEN a.status = 'open' THEN 0 ELSE 1 END, a.created_at DESC`).catch(() => []);
  res.render('admin/appeals', {
    title: 'Design appeals — Admin', appeals,
    isOwner: isHeadAdmin(req.user),
  });
});

router.post('/appeals/:id/approve', requireHeadAdmin, formLimiter, checkHoneypot, async (req, res) => {
  const appeal = await db.get('SELECT * FROM design_appeals WHERE id = ?', [req.params.id]).catch(() => null);
  if (!appeal || appeal.status !== 'open') return res.redirect('/admin/appeals');
  const design = await db.get('SELECT linework_wm_path FROM designs WHERE id = ?', [appeal.design_id]);
  if (!design || !design.linework_wm_path) {
    req.session.flash = 'Blocked: the piece has no watermarked linework — it cannot go live.';
    return res.redirect('/admin/appeals');
  }
  await db.update('designs', appeal.design_id, { status: 'approved', approved_by: req.user.id, reject_reason: '' });
  await db.update('design_appeals', appeal.id, { status: 'approved', decided_by: req.user.id, decided_at: db.now() });
  const { notifyUser } = require('../lib/notify');
  const { sendMail } = require('../lib/mail');
  const ownerName = req.user.display_name || req.user.email || 'the site owner';
  const title = `Appeal decided — your piece is live`;
  const body = `The site owner (${ownerName}) reviewed your appeal and approved the piece. It is now live in your portfolio/gallery.\n\nThe owner's decision is final.`;
  await notifyUser(appeal.artist_id, { kind: 'appeal_decided', title, body, link: '/artist/portfolio' });
  try {
    const { completeOnApproval } = require('../lib/replacements');
    await completeOnApproval(appeal.design_id);
  } catch (e) { /* non-remake */ }
  try { await notifyDesignLive(appeal.design_id, ownerName + ' (appeal)'); } catch (e) { console.error('appeal live notify failed:', e.message); }
  const artist = await db.get('SELECT email FROM users WHERE id = ?', [appeal.artist_id]).catch(() => null);
  if (artist && artist.email) {
    try { await sendMail({ to: artist.email, subject: title, text: body }); } catch (e) { console.error('appeal email failed:', e.message); }
  }
  req.session.flash = 'Appeal approved — the piece is live and the artist has been notified.';
  await payAdmin(req, 'appeal_decide', 'appeal', appeal.id);
  res.redirect('/admin/appeals');
});

router.post('/appeals/:id/uphold', requireHeadAdmin, formLimiter, checkHoneypot, async (req, res) => {
  const appeal = await db.get('SELECT * FROM design_appeals WHERE id = ?', [req.params.id]).catch(() => null);
  if (!appeal || appeal.status !== 'open') return res.redirect('/admin/appeals');
  await db.update('design_appeals', appeal.id, { status: 'upheld', decided_by: req.user.id, decided_at: db.now() });
  const { notifyUser } = require('../lib/notify');
  const { sendMail } = require('../lib/mail');
  const ownerName = req.user.display_name || req.user.email || 'the site owner';
  const title = `Appeal decided — rejection stands`;
  const body = `The site owner (${ownerName}) reviewed your appeal and upheld the rejection. The piece will not be listed.\n\nThe owner's decision is final — no further appeals are available for this piece.`;
  await notifyUser(appeal.artist_id, { kind: 'appeal_decided', title, body, link: '/artist/portfolio' });
  const artist = await db.get('SELECT email FROM users WHERE id = ?', [appeal.artist_id]).catch(() => null);
  if (artist && artist.email) {
    try { await sendMail({ to: artist.email, subject: title, text: body }); } catch (e) { console.error('appeal email failed:', e.message); }
  }
  req.session.flash = 'Rejection upheld — the artist has been notified that the decision is final.';
  await payAdmin(req, 'appeal_decide', 'appeal', appeal.id);
  res.redirect('/admin/appeals');
});
// Permanent delete (moderation): removes the piece and its asset files.
// Blocked when the piece has sales — those must stay for order history.
router.post('/designs/:id/delete', formLimiter, checkHoneypot, async (req, res) => {
  const design = await db.get('SELECT * FROM designs WHERE id = ?', [req.params.id]);
  if (!design) return res.redirect('/admin/designs');
  const paid = await db.get("SELECT id FROM orders WHERE design_id = ? AND status = 'paid' LIMIT 1", [design.id]);
  if (paid || (design.sale_count || 0) > 0) {
    req.session.flash = 'Blocked: that piece has sales and cannot be deleted.';
    return res.redirect('/admin/designs');
  }
  for (const p of [design.color_path, design.linework_path, design.linework_wm_path, design.custom_watermark_path]) {
    const abs = p ? resolveStoredPath(p) : null;
    if (abs) { try { fs.unlinkSync(abs); } catch { /* already gone */ } }
  }
  await db.query('DELETE FROM designs WHERE id = ?', [design.id]);
  req.session.flash = 'Piece deleted.';
  res.redirect('/admin/designs');
});

// Members-only toggle: marks a design exclusive to active members (early
// sale pricing, members-only gallery visibility and checkout).
router.post('/designs/:id/members-only', formLimiter, checkHoneypot, async (req, res) => {
  const v = req.body.members_only === '1' ? 1 : 0;
  await db.update('designs', req.params.id, { members_only: v });
  req.session.flash = v ? 'Design is now members-only.' : 'Design is now public.';
  res.redirect('/admin/designs');
});
// Upload the watermarked linework for a design (public gallery version).
// The artist's clean color + clean linework stay private; only this file
// is ever served publicly.
const wmStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.uploadDir, 'designs', 'linework-wm');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 5) || '.jpg';
    cb(null, `${req.params.id}-wm${ext}`);
  },
});
const uploadWm = multer({
  storage: wmStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, or WebP images are allowed.'));
  },
}).single('watermark');

router.post('/designs/:id/watermark', formLimiter, (req, res, next) => {
  uploadWm(req, res, (err) => {
    if (err) { req.session.flash = err.message; return res.redirect('/admin/designs'); }
    next();
  });
}, checkHoneypot, async (req, res) => {
  if (!req.file) { req.session.flash = 'Choose a watermarked linework image first.'; return res.redirect('/admin/designs'); }
  await db.update('designs', req.params.id, {
    linework_wm_path: path.relative(config.uploadDir, req.file.path),
  });
  req.session.flash = 'Watermarked linework saved — the design can now be approved.';
  res.redirect('/admin/designs');
});
router.get('/designs', async (req, res) => {
  const designs = await db.all(
    `SELECT d.*, u.email AS artist_email FROM designs d LEFT JOIN users u ON u.id = d.artist_id
     ORDER BY d.created_at DESC LIMIT 100`);
  res.render('admin/designs', { title: 'Designs — Admin', designs });
});

// --- Colorization queue: linework-only uploads waiting on the site-created
// color version. The assistant creates the color in a work session; the admin
// attaches the finished file here (attaching IS the administrator approval).
// The site-created color is a purchase deliverable only — never listed
// publicly or added to the designer's portfolio.
router.get('/colorization', async (req, res) => {
  const queue = await colorizationQueue();
  res.render('admin/colorization', { title: 'Colorization queue — Admin', queue });
});
const colorStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.uploadDir, 'designs', 'color');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 5) || '.jpg';
    cb(null, `${req.params.id}-sitecolor${ext}`);
  },
});
const uploadColor = multer({
  storage: colorStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, or WebP images are allowed.'));
  },
}).single('color');

// Admin-only private preview of the attached site-created color version.
// Never public — this is a purchase deliverable.
router.get('/colorization/:id/preview', async (req, res) => {
  const d = await db.get('SELECT color_path FROM designs WHERE id = ?', [req.params.id]);
  if (!d || !d.color_path) return res.status(404).send('Not found.');
  const colorAbs = resolveStoredPath(d.color_path);
  if (!colorAbs) return res.status(404).send('Not found.');
  res.sendFile(colorAbs);
});

router.post('/colorization/:id/attach', formLimiter, (req, res, next) => {
  uploadColor(req, res, (err) => {
    if (err) { req.session.flash = err.message; return res.redirect('/admin/colorization'); }
    next();
  });
}, checkHoneypot, async (req, res) => {
  if (!req.file) { req.session.flash = 'Choose the finished color image first.'; return res.redirect('/admin/colorization'); }
  try {
    await attachColorVersion(req.params.id, req.file.path);
    await payAdmin(req, 'colorization_attach', 'colorization', req.params.id);
    req.session.flash = 'Color version attached — it is now the purchase deliverable for this piece. The piece keeps its current approval status.';
  } catch (e) {
    req.session.flash = 'Attach failed: ' + e.message;
  }
  res.redirect('/admin/colorization');
});

// --- Members ---
router.get('/members', async (req, res) => {
  const users = await db.all(
    `SELECT u.*, p.name AS plan_name FROM users u
     LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active'
     LEFT JOIN plans p ON p.id = s.plan_id
     ORDER BY u.created_at DESC LIMIT 200`);
  res.render('admin/members', { title: 'Members — Admin', users, isHead: isHeadAdmin(req.user) });
});

// Cancel a member's membership (off-site sales rule enforcement).
router.post('/members/:id/cancel-membership', formLimiter, checkHoneypot, async (req, res) => {
  const reason = String(req.body.reason || 'Terms violation');
  await db.query("UPDATE subscriptions SET status = 'canceled', canceled_at = ? WHERE user_id = ? AND status = 'active'",
    [db.now(), req.params.id]);
  const user = await db.get('SELECT role FROM users WHERE id = ?', [req.params.id]);
  if (user && !isAdminRole(user.role)) await db.update('users', req.params.id, { role: 'customer' });
  await db.insert('review_queue', {
    item_type: 'note', item_id: req.params.id, reason: `Membership canceled: ${reason}`,
    status: 'closed', created_at: db.now(), reviewed_at: db.now(),
  });
  req.session.flash = 'Membership canceled — no refunds per the Terms.';
  await payAdmin(req, 'member_cancel', 'user', req.params.id);
  res.redirect('/admin/members');
});

// Verify a tattoo shop (allows the limited shop profile fields).
router.post('/members/:id/verify-shop', formLimiter, checkHoneypot, async (req, res) => {
  await verifyShop(req.params.id);
  await payAdmin(req, 'shop_verify', 'user', req.params.id);
  req.session.flash = 'Shop verified.';
  res.redirect('/admin/members');
});

// Complimentary membership grant (head-admin only): gives a non-admin user
// an active subscription row without PayPal or site credit — used for demo /
// review accounts (e.g. the Google Play review account must have full access
// to every premium feature on every update submission). Idempotent:
// re-granting extends the existing active row instead of stacking.
router.post('/members/:id/grant-comp', requireHeadAdmin, formLimiter, checkHoneypot, async (req, res) => {
  const slug = String(req.body.plan || '');
  const lifetime = req.body.lifetime === '1';
  const months = parseInt(req.body.months, 10);
  console.log('[grant-comp] start', { slug, months, lifetime, memberId: req.params.id });
  const plan = await db.get('SELECT * FROM plans WHERE slug = ? AND active = 1', [slug]);
  console.log('[grant-comp] plan lookup done', { found: !!plan });
  if (!plan || !['customer', 'customer_annual', 'design_artist', 'tattoo_shop'].includes(slug)
      || (!lifetime && (!Number.isInteger(months) || months < 1 || months > 36))) {
    req.session.flash = lifetime ? 'Choose a valid plan.' : 'Choose a valid plan and a term of 1–36 months.';
    return res.redirect('/admin/members');
  }
  const user = await db.get('SELECT id, role FROM users WHERE id = ?', [req.params.id]);
  console.log('[grant-comp] user lookup done', { found: !!user });
  if (!user) return res.redirect('/admin/members');
  if (isAdminRole(user.role)) {
    req.session.flash = 'Complimentary grants are for non-admin accounts only — admins already have full access.';
    return res.status(400).render('error', {
      title: 'Cannot grant',
      message: 'Complimentary grants are for non-admin accounts only — admins already have full access.',
    });
  }
  // Monthly plans grant months × 30 days; annual plans grant months/12 × 365 days.
  const termMs = plan.interval === 'year' ? 365 * 86400000 : 30 * 86400000;
  const terms = plan.interval === 'year' ? months / 12 : months;
  const nowMs = Date.now();
  const existing = await db.get(
    `SELECT * FROM subscriptions WHERE user_id = ? AND plan_id = ? AND status = 'active'
     AND (current_period_end IS NULL OR current_period_end > ?)`, [user.id, plan.id, nowMs]);
  console.log('[grant-comp] existing sub check done', { found: !!existing });
  if (existing) {
    if (lifetime) {
      await db.update('subscriptions', existing.id, { current_period_end: null });
    } else {
      const from = Math.max(Number(existing.current_period_end) || nowMs, nowMs);
      await db.update('subscriptions', existing.id, { current_period_end: from + terms * termMs });
    }
  } else {
    await db.insert('subscriptions', {
      user_id: user.id, plan_id: plan.id, status: 'active',
      paypal_subscription_id: '', current_period_end: lifetime ? null : nowMs + terms * termMs,
      paid_with_credit: 0, created_at: db.now(),
    });
  }
  // Artist/shop plans also carry the matching role (idempotent, skips admins).
  const { grantPlanRole } = require('../lib/planRoles');
  console.log('[grant-comp] before grantPlanRole');
  await grantPlanRole(user.id, plan.slug);
  console.log('[grant-comp] after grantPlanRole, before payAdmin');
  await payAdmin(req, 'member_comp_grant', 'user', user.id);
  console.log('[grant-comp] after payAdmin, redirecting');
  req.session.flash = lifetime
    ? `Complimentary ${plan.name} granted for life.`
    : `Complimentary ${plan.name} granted for ${months} month${months === 1 ? '' : 's'}.`;
  res.redirect('/admin/members');
});

// --- Tester bug reports: triage list + open/close ---
router.get('/bugs', async (req, res) => {
  const bugs = await db.all('SELECT * FROM bug_reports ORDER BY created_at DESC LIMIT 200');
  res.render('admin/bugs', {
    title: 'Bug Reports — Admin', bugs,
  });
});
router.post('/bugs/:id/status', formLimiter, checkHoneypot, async (req, res) => {
  const status = req.body.status === 'closed' ? 'closed' : 'open';
  await db.update('bug_reports', req.params.id, { status });
  await payAdmin(req, 'bug_triage', 'bug', req.params.id);
  req.session.flash = `Bug report marked ${status}.`;
  res.redirect('/admin/bugs');
});

// --- Founding program: counters, raffle window, draw ---
router.get('/founding', async (req, res) => {
  const founding = require('../lib/founding');
  const status = await founding.getFoundingStatus();
  const winners = await db.all(
    `SELECT r.prize_won, r.drawn_at, u.display_name, u.email
     FROM raffle_entries r JOIN users u ON u.id = r.user_id
     WHERE r.prize_won IS NOT NULL ORDER BY r.drawn_at DESC`);
  const foundingArtists = await db.all(
    `SELECT display_name, email, founding_artist_ends_at FROM users
     WHERE is_founding_artist = 1 ORDER BY founding_artist_ends_at DESC LIMIT 50`);
  const foundingShops = await db.all(
    `SELECT display_name, email, founding_shop_ends_at FROM users
     WHERE is_founding_shop = 1 ORDER BY founding_shop_ends_at DESC LIMIT 100`);
  res.render('admin/founding', {
    title: 'Founding Program — Admin',
    ...status, winners, foundingArtists, foundingShops,
    money: require('../lib/pricing').money,
  });
});

// Draw the opening raffle (one draw ever). Winners are notified on-site
// and by email, and announced publicly.
router.post('/raffle/draw', formLimiter, checkHoneypot, async (req, res) => {
  try {
    const result = await require('../lib/founding').drawRaffle();
    const counts = {};
    for (const w of result.winners) counts[w.prize] = (counts[w.prize] || 0) + 1;
    req.session.flash = `Raffle drawn: ${result.winners.length} winners ` +
      `(${(counts.grand || 0)} grand, ${(counts.runnerup || 0)} runners-up). Winners notified on-site and by email.`;
  } catch (e) {
    req.session.flash = 'Draw failed: ' + e.message;
  }
  res.redirect('/admin/founding');
});

// --- Tap-to-pay standalone billing ---
router.get('/tap', async (req, res) => {
  const { TIERS } = require('../lib/tapBilling');
  const subs = await db.all(
    `SELECT t.*, u.display_name, u.email
     FROM shop_tap_subscriptions t LEFT JOIN users u ON u.id = t.shop_user_id
     ORDER BY t.created_at DESC LIMIT 200`);
  let mrrCents = 0, activeCount = 0, compedCount = 0;
  for (const s of subs) {
    if (Number(s.comped)) { compedCount++; continue; }
    if (s.status === 'active') {
      activeCount++;
      mrrCents += (TIERS[s.tier] || { priceCents: 0 }).priceCents;
    }
  }
  res.render('admin/tap', { title: 'Tap-to-Pay Billing — Admin', subs, mrrCents, activeCount, compedCount });
});

// --- Payouts ---
router.get('/payouts', async (req, res) => {
  const balances = await db.all(
    `SELECT recipient_type, recipient_id, COALESCE(SUM(amount_cents),0) AS total
     FROM commission_ledger WHERE status = 'payable'
     GROUP BY recipient_type, recipient_id`);
  // Attach display names + default payout destination.
  const { getDefaultDestination } = require('../lib/cashout');
  for (const b of balances) {
    const u = await db.get('SELECT email, display_name FROM users WHERE id = ?', [b.recipient_id]);
    b.email = u?.email || '—'; b.name = u?.display_name || '—';
    const dest = await getDefaultDestination(b.recipient_id);
    b.destination = dest ? dest.summary : '(none set)';
  }
  const runs = await db.all('SELECT * FROM payouts ORDER BY created_at DESC LIMIT 25');
  const cashouts = await db.all(
    `SELECT c.*, u.email AS user_email, u.display_name AS user_name
     FROM cashout_requests c LEFT JOIN users u ON u.id = c.user_id
     WHERE c.status IN ('pending','processing') ORDER BY c.created_at DESC LIMIT 50`);
  for (const c of cashouts) {
    try { c.dest = JSON.parse(c.dest_snapshot || '{}'); } catch { c.dest = {}; }
  }
  const cashoutHistory = await db.all(
    `SELECT c.*, u.email AS user_email FROM cashout_requests c LEFT JOIN users u ON u.id = c.user_id
     WHERE c.status IN ('completed','failed','canceled') ORDER BY c.created_at DESC LIMIT 25`);

  // --- Finance: where the site's clear money sits ---
  // PayPal sales + top-ups land directly in the PayPal Business account;
  // PayPal Payouts leave from the same account; what remains is the site's.
  const sum = async (sql, params = []) => (await db.get(sql, params)).t || 0;
  const finance = {
    paypalSales: await sum(`SELECT COALESCE(SUM(amount_paid_cents),0) AS t FROM orders WHERE status = 'paid' AND payment_method = 'paypal'`),
    topups: await sum(`SELECT COALESCE(SUM(amount_cents),0) AS t FROM credit_topups WHERE status = 'completed'`),
    manualSales: await sum(`SELECT COALESCE(SUM(amount_paid_cents),0) AS t FROM orders WHERE status = 'paid' AND payment_method IN ('cashapp','venmo','manual')`),
    creditSales: await sum(`SELECT COALESCE(SUM(amount_paid_cents),0) AS t FROM orders WHERE status = 'paid' AND payment_method = 'credit'`),
    penalties: await sum(`SELECT COALESCE(SUM(penalty_cents),0) AS t FROM cashout_requests WHERE status IN ('completed','pending','processing')`),
    siteSplits: await sum(`SELECT COALESCE(SUM(amount_cents),0) AS t FROM commission_ledger WHERE recipient_type = 'site' AND status = 'paid'`),
    paypalBatchOut: await sum(`SELECT COALESCE(SUM(amount_cents),0) AS t FROM payouts WHERE status = 'completed'`),
  };
  const completedCashouts = await db.all(`SELECT net_cents, dest_snapshot FROM cashout_requests WHERE status = 'completed'`);
  let paypalCashoutOut = 0, wiseOut = 0, manualOut = 0;
  for (const c of completedCashouts) {
    let t = '';
    try { t = JSON.parse(c.dest_snapshot || '{}').dest_type || ''; } catch { /* ignore */ }
    if (t === 'paypal') paypalCashoutOut += c.net_cents;
    else if (t === 'bank') wiseOut += c.net_cents;
    else manualOut += c.net_cents;
  }
  finance.paypalOut = finance.paypalBatchOut + paypalCashoutOut;
  finance.wiseOut = wiseOut;
  finance.manualOut = manualOut;
  finance.retainedInPaypal = (finance.paypalSales + finance.topups) - finance.paypalOut;

  // Admin task pay (owner rule 2026-09-29): per-task pay out of the site
  // overhead, capped at 25% of cumulative overhead. Task pay accrues into
  // each admin's normal payable balance and goes out with the Monday run.
  const adminTaskPay = require('../lib/adminTaskPay');
  const adminEarnings = await adminTaskPay.adminEarnings();
  const adminTaskMeta = {
    rateCard: adminTaskPay.RATE_CARD,
    capPct: adminTaskPay.ADMIN_TASK_PAY_OVERHEAD_CAP_PCT,
    overheadCents: await adminTaskPay.overheadCents(),
    grantedCents: await adminTaskPay.grantedCents(),
  };

  res.render('admin/payouts', { title: 'Payouts — Admin', balances, runs, cashouts, cashoutHistory, finance, adminEarnings, adminTaskMeta });
});

// --- Manual cashout processing ---
// The admin sends the money via the destination's app (Cash App, Venmo,
// Zelle, bank transfer, etc.) then marks it sent here.
router.post('/cashouts/:id/complete', formLimiter, checkHoneypot, async (req, res) => {
  const { completeCashout } = require('../lib/cashout');
  const c = await db.get("SELECT * FROM cashout_requests WHERE id = ? AND status IN ('pending','processing')", [req.params.id]);
  if (!c) { req.session.flash = 'Cashout request not found or already handled.'; return res.redirect('/admin/payouts'); }
  await completeCashout(c.id, 'Sent manually by admin.');
  await payAdmin(req, 'cashout_complete', 'cashout', c.id);
  req.session.flash = `Cashout of $${(c.net_cents / 100).toFixed(2)} marked sent.`;
  res.redirect('/admin/payouts');
});

router.post('/cashouts/:id/fail', formLimiter, checkHoneypot, async (req, res) => {
  const { revertCashout } = require('../lib/cashout');
  const c = await db.get("SELECT id FROM cashout_requests WHERE id = ? AND status IN ('pending','processing')", [req.params.id]);
  if (!c) { req.session.flash = 'Cashout request not found or already handled.'; return res.redirect('/admin/payouts'); }
  await revertCashout(c.id);
  req.session.flash = 'Cashout marked failed — balance restored to payable.';
  res.redirect('/admin/payouts');
});

// Manually trigger the weekly payout run (same code the Monday
// scheduler runs). Useful for testing or off-schedule payouts.
router.post('/payouts/auto', formLimiter, checkHoneypot, async (req, res) => {
  const { runWeeklyPayouts } = require('../lib/autopayout');
  try {
    const summary = await runWeeklyPayouts();
    req.session.flash = summary.failed
      ? `Payout run failed: ${summary.error} — shares reverted to payable.`
      : `Payout run done: ${summary.paid.length} paid automatically, ${summary.queued.length} queued for manual send, ${summary.skipped.length} skipped. Work the queue on /admin/payouts.`;
  } catch (e) {
    req.session.flash = 'Automatic payouts crashed: ' + e.message;
  }
  res.redirect('/admin/payouts');
});

router.post('/payouts/:id/complete', formLimiter, checkHoneypot, async (req, res) => {
  const payout = await db.get('SELECT * FROM payouts WHERE id = ?', [req.params.id]);
  if (!payout || payout.status !== 'queued') {
    req.session.flash = 'Only queued payouts can be marked completed.';
    return res.redirect('/admin/payouts');
  }
  await db.update('payouts', payout.id, { status: 'completed', completed_at: db.now() });
  await db.query("UPDATE commission_ledger SET status = 'paid', paid_at = ? WHERE payout_id = ? AND status = 'queued'",
    [db.now(), payout.id]);
  await payAdmin(req, 'payout_complete', 'payout', payout.id);
  req.session.flash = 'Payout marked completed — shares are now paid.';
  res.redirect('/admin/payouts');
});

// --- Ad space management ---
const { SLOTS: AD_SLOTS, recordAdRevenue, adRevenueTotals } = require('../lib/ads');

router.get('/ads', async (req, res) => {
  const ads = await db.all('SELECT * FROM ads ORDER BY created_at DESC');
  const rev = await adRevenueTotals();
  res.render('admin/ads', {
    title: 'Ad space — Admin', ads, slots: AD_SLOTS,
    isHead: isHeadAdmin(req.user), adPayouts: rev.payouts,
    adGrossCents: rev.grossCents, adSiteCents: rev.siteCents,
  });
});

// Tier-3 admin pay (owner rule 2026-09-30): manually record an ad-revenue
// payout (e.g. AdSense pays the owner's bank directly — the site never sees
// the money, so it is reconciled here). Head-admin only. 50% sweeps to the
// site overhead pool via recordAdRevenue; the other 50% is the owner's.
router.post('/ads/record', requireHeadAdmin, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const dollars = parseFloat(String(req.body.amount || '').replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(dollars) || dollars <= 0) throw new Error('Enter the payout amount in dollars.');
    const amountCents = Math.round(dollars * 100);
    if (amountCents > 100000000) throw new Error('That amount is implausibly large — check the decimal point.');
    const source = String(req.body.source || '').trim().toLowerCase().replace(/[^a-z0-9:_-]/g, '').slice(0, 60);
    if (!source) throw new Error('Name the source (e.g. adsense).');
    const r = await recordAdRevenue({ amountCents, source: `manual:${source}` });
    await payAdmin(req, 'ad_revenue_record', 'ad_revenue', `${source}:${amountCents}`);
    req.session.flash = `Recorded ${res.locals.money(amountCents)} ad revenue (${source}): ${res.locals.money(r.site_cents)} to site overhead, ${res.locals.money(r.owner_cents)} owner.`;
  } catch (e) {
    req.session.flash = 'Could not record the payout: ' + e.message;
  }
  res.redirect('/admin/ads');
});

router.post('/ads/:id/activate', formLimiter, checkHoneypot, async (req, res) => {
  const ad = await db.get('SELECT * FROM ads WHERE id = ?', [req.params.id]);
  if (!ad) { req.session.flash = 'Ad not found.'; return res.redirect('/admin/ads'); }
  const now = db.now();
  const months = Math.min(12, Math.max(1, parseInt(ad.months, 10) || 1));
  await db.update('ads', ad.id, {
    active: 1,
    starts_at: now,
    ends_at: now + months * 30 * 24 * 3600 * 1000,
  });
  await payAdmin(req, 'ad_activate', 'ad', ad.id);
  req.session.flash = `Ad "${ad.title}" is now live for ${months} month(s).`;
  res.redirect('/admin/ads');
});

router.post('/ads/:id/deactivate', formLimiter, checkHoneypot, async (req, res) => {
  await db.update('ads', req.params.id, { active: 0 });
  await payAdmin(req, 'ad_deactivate', 'ad', req.params.id);
  req.session.flash = 'Ad paused.';
  res.redirect('/admin/ads');
});

router.post('/ads/:id/delete', formLimiter, checkHoneypot, async (req, res) => {
  const ad = await db.get('SELECT * FROM ads WHERE id = ?', [req.params.id]);
  if (ad && ad.image_path) {
    const file = ad.image_path.startsWith('/img/ads/')
      ? resolveStoredPath(path.join('ads', path.basename(ad.image_path)))
      : resolveStoredPath(ad.image_path);
    if (file) fs.unlink(file, () => {});
  }
  await db.query('DELETE FROM ads WHERE id = ?', [req.params.id]);
  req.session.flash = 'Ad deleted.';
  res.redirect('/admin/ads');
});

// --- Print order fulfillment queue ---
const { PRODUCTS: PRINT_PRODUCTS } = require('../lib/print');

router.get('/prints', async (req, res) => {
  const prints = await db.all(`
    SELECT po.*, o.status AS pay_status, o.amount_paid_cents,
           d.title AS design_title, c.name AS combo_name
    FROM print_orders po
    JOIN orders o ON o.id = po.order_id
    LEFT JOIN designs d ON d.id = po.design_id
    LEFT JOIN combos c ON c.id = po.combo_id
    ORDER BY po.created_at DESC`);
  res.render('admin/prints', { title: 'Print queue — Admin', prints, products: PRINT_PRODUCTS });
});

router.post('/prints/:id/fulfill', formLimiter, checkHoneypot, async (req, res) => {
  const po = await db.get('SELECT * FROM print_orders WHERE id = ?', [req.params.id]);
  if (!po) { req.session.flash = 'Print order not found.'; return res.redirect('/admin/prints'); }
  await db.update('print_orders', po.id, { status: 'fulfilled', fulfilled_at: db.now() });
  await payAdmin(req, 'print_fulfill', 'print', po.id);
  req.session.flash = 'Print order marked fulfilled.';
  res.redirect('/admin/prints');
});

// Admin-only download of the full-resolution file to print.
router.get('/prints/:id/file', async (req, res) => {
  const po = await db.get('SELECT * FROM print_orders WHERE id = ?', [req.params.id]);
  if (!po) return res.status(404).render('error', { title: 'Not found', message: 'Print order not found.' });
  let rel = null;
  if (po.design_id) {
    const d = await db.get('SELECT color_path, linework_path FROM designs WHERE id = ?', [po.design_id]);
    if (d) rel = po.style === 'linework' ? d.linework_path : d.color_path;
  } else if (po.combo_id) {
    const c = await db.get('SELECT output_path FROM combos WHERE id = ?', [po.combo_id]);
    if (c) rel = c.output_path;
  }
  const abs = rel ? resolveStoredPath(rel) : null;
  if (!abs) {
    return res.status(404).render('error', { title: 'Not found', message: 'Print file is missing.' });
  }
  res.download(abs);
});

// --- Design contests (bounty board) ---
// Admins can pick a winner on any open/judging contest (e.g. when the
// 7-day window expired without the customer picking).
router.get('/contests', async (req, res) => {
  const contests = await db.all(`
    SELECT c.*, u.display_name AS customer_name,
           (SELECT COUNT(*) FROM contest_entries e WHERE e.contest_id = c.id) AS entry_count
    FROM contests c LEFT JOIN users u ON u.id = c.customer_id
    ORDER BY c.created_at DESC`);
  res.render('admin/contests', {
    title: 'Design contests — Admin', contests,
    money: require('../lib/pricing').money,
  });
});

router.get('/contests/:id', async (req, res) => {
  const c = await db.get(
    `SELECT c.*, u.display_name AS customer_name FROM contests c
     LEFT JOIN users u ON u.id = c.customer_id WHERE c.id = ?`, [req.params.id]);
  if (!c) { req.session.flash = 'Contest not found.'; return res.redirect('/admin/contests'); }
  const entries = await db.all(
    `SELECT e.*, u.display_name AS designer_name FROM contest_entries e
     LEFT JOIN users u ON u.id = e.designer_id WHERE e.contest_id = ? ORDER BY e.created_at ASC`,
    [c.id]);
  res.render('admin/contest-detail', {
    title: `Contest — ${c.title} — Admin`, c, entries,
    money: require('../lib/pricing').money,
  });
});

router.post('/contests/:id/pick/:entryId', formLimiter, checkHoneypot, async (req, res) => {
  try {
    const { winnerShare } = await require('../lib/contests').pickWinner({
      contestId: req.params.id, entryId: req.params.entryId,
      pickerId: req.user.id, pickerIsAdmin: true,
    });
    await payAdmin(req, 'contest_judge', 'contest', req.params.id);
    req.session.flash = `Winner picked — ${require('../lib/pricing').money(winnerShare)} to the winning designer.`;
  } catch (e) {
    req.session.flash = e.message || 'Could not pick a winner.';
  }
  res.redirect(`/admin/contests/${req.params.id}`);
});

// --- Admin user management ---
// Only the HEAD ADMIN can manage admins. The head admin role is protected:
// a normal admin cannot be demoted by anyone but a head admin, a head admin
// cannot be demoted/removed by a normal admin, and the site always keeps at
// least one head admin.
router.get('/admins', requireHeadAdmin, async (req, res) => {
  const admins = await db.all(
    "SELECT id, email, display_name, role, created_at FROM users WHERE role IN ('admin', 'head_admin') ORDER BY role, created_at");
  res.render('admin/admins', {
    title: 'Admins — Admin', admins,
    isHeadAdmin: isHeadAdmin(req.user),
  });
});

router.post('/admins/add', requireHeadAdmin, formLimiter, checkHoneypot, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await db.get('SELECT id, role FROM users WHERE email = ?', [email]);
  if (!user) { req.session.flash = 'No account with that email yet — they need to sign up first.'; }
  else if (isAdminRole(user.role)) { req.session.flash = 'That account is already an admin.'; }
  else { await db.update('users', user.id, { role: 'admin' }); req.session.flash = `${email} is now an admin.`; }
  res.redirect('/admin/admins');
});

router.post('/admins/remove', requireHeadAdmin, formLimiter, checkHoneypot, async (req, res) => {
  const user = await db.get('SELECT id, role FROM users WHERE id = ?', [req.body.id]);
  if (!user) { req.session.flash = 'Account not found.'; }
  else if (user.role === 'head_admin') {
    // Only a head admin reaches this route; a head admin may only be
    // demoted while at least one other head admin remains.
    const count = await db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'head_admin'");
    if (user.id === req.user.id) {
      req.session.flash = 'You cannot remove your own head-admin access here.';
    } else if ((count.c || 0) <= 1) {
      req.session.flash = 'Blocked: the site must keep at least one head admin.';
    } else {
      await db.update('users', user.id, { role: 'admin' });
      req.session.flash = 'Head admin demoted to admin.';
    }
  }
  else if (user.id === req.user.id) { req.session.flash = 'You cannot remove your own admin access.'; }
  else { await db.update('users', user.id, { role: 'customer' }); req.session.flash = 'Admin access removed.'; }
  res.redirect('/admin/admins');
});

module.exports = router;
