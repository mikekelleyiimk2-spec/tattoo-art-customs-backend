// Admin dashboard: sales log, payout balances + runs, members,
// upload/bio/message review queue, referral verification queue,
// order management (confirm manual payments, attach custom files).
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { requireLogin, requireRole } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { recordSaleCommissions, verifyOrderCommissions } = require('../lib/commissions');
const { onOrderPaid } = require('../lib/printful');

const router = express.Router();
router.use(requireLogin, requireRole('admin'));

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
  res.render('admin/dashboard', { title: 'Admin — Tattoo Art Customs', stats, metaDescription: '' });
});

// --- Sales log ---
router.get('/orders', async (req, res) => {
  const orders = await db.all(
    `SELECT o.*, u.email AS buyer_email, d.title AS design_title FROM orders o
     JOIN users u ON u.id = o.buyer_id LEFT JOIN designs d ON d.id = o.design_id
     ORDER BY o.created_at DESC LIMIT 100`);
  res.render('admin/orders', { title: 'Orders — Admin', orders, metaDescription: '' });
});

// Confirm a manual (CashApp/Venmo) payment.
router.post('/orders/:id/confirm-manual', formLimiter, checkHoneypot, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order || order.status !== 'pending' || order.payment_method === 'paypal') {
    req.session.flash = 'Only pending manual-payment orders can be confirmed.';
    return res.redirect('/admin/orders');
  }
  const due = order.order_type === 'custom' ? order.deposit_cents : order.amount_cents;
  await db.update('orders', order.id, { status: 'paid', amount_paid_cents: due, paid_at: db.now() });
  const fresh = await db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
  await recordSaleCommissions(fresh);
  const fulfil = await onOrderPaid(fresh);
  req.session.flash = 'Manual payment confirmed — buyer download unlocked, commissions recorded.' +
    (fulfil.submitted ? ' Print auto-submitted to Printful.' : '');
  res.redirect('/admin/orders');
});

// Verify a referred sale (releases the shop's 20% to payable).
router.post('/orders/:id/verify-referral', formLimiter, checkHoneypot, async (req, res) => {
  const n = await verifyOrderCommissions(req.params.id);
  req.session.flash = n ? `Sale verified — ${n} commission share(s) released.` : 'Nothing pending for this order.';
  res.redirect('/admin/orders');
});

// Attach finished custom-design files to an order.
const customStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.assetDir, 'uploads', 'designs');
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
  if (req.files?.color) data.custom_color_path = path.relative(config.assetDir, req.files.color[0].path);
  if (req.files?.linework) data.custom_linework_path = path.relative(config.assetDir, req.files.linework[0].path);
  if (Object.keys(data).length) {
    await db.update('orders', order.id, data);
    req.session.flash = 'Custom design files attached — the buyer can now download them.';
  }
  res.redirect('/admin/orders');
});

// --- Review queue (flagged designs, bios, messages, shop profiles) ---
router.get('/reviews', async (req, res) => {
  const items = await db.all("SELECT * FROM review_queue WHERE status = 'open' ORDER BY created_at DESC");
  res.render('admin/reviews', { title: 'Review queue — Admin', items, metaDescription: '' });
});

router.post('/reviews/:id/approve', formLimiter, checkHoneypot, async (req, res) => {
  const item = await db.get('SELECT * FROM review_queue WHERE id = ?', [req.params.id]);
  if (!item) return res.redirect('/admin/reviews');
  const result = await applyReviewDecision(item, 'approve');
  if (result === 'blocked-no-watermark') {
    req.session.flash = 'Blocked: upload the watermarked linework version before approving this design.';
  } else {
    await db.update('review_queue', item.id, { status: 'approved', reviewed_at: db.now() });
  }
  res.redirect('/admin/reviews');
});

router.post('/reviews/:id/reject', formLimiter, checkHoneypot, async (req, res) => {
  const item = await db.get('SELECT * FROM review_queue WHERE id = ?', [req.params.id]);
  if (!item) return res.redirect('/admin/reviews');
  await applyReviewDecision(item, 'reject');
  await db.update('review_queue', item.id, { status: 'rejected', reviewed_at: db.now() });
  res.redirect('/admin/reviews');
});

async function applyReviewDecision(item, decision) {
  if (item.item_type === 'design') {
    if (decision === 'approve') {
      const design = await db.get('SELECT linework_wm_path FROM designs WHERE id = ?', [item.item_id]);
      if (!design || !design.linework_wm_path) return 'blocked-no-watermark';
    }
    await db.update('designs', item.item_id, { status: decision === 'approve' ? 'approved' : 'rejected' });
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
  const design = await db.get('SELECT linework_wm_path FROM designs WHERE id = ?', [req.params.id]);
  if (!design) return res.redirect('/admin/designs');
  if (!design.linework_wm_path) {
    req.session.flash = 'Blocked: upload the watermarked linework version before approving — the public gallery only ever shows watermarked linework.';
    return res.redirect('/admin/designs');
  }
  await db.update('designs', req.params.id, { status: 'approved' });
  req.session.flash = 'Design approved — it is now live in the gallery.';
  res.redirect('/admin/designs');
});
router.post('/designs/:id/reject', formLimiter, checkHoneypot, async (req, res) => {
  await db.update('designs', req.params.id, { status: 'rejected' });
  res.redirect('/admin/designs');
});
// Upload the watermarked linework for a design (public gallery version).
// The artist's clean color + clean linework stay private; only this file
// is ever served publicly.
const wmStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.assetDir, 'designs', 'linework-wm');
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
    linework_wm_path: path.relative(config.assetDir, req.file.path),
  });
  req.session.flash = 'Watermarked linework saved — the design can now be approved.';
  res.redirect('/admin/designs');
});
router.get('/designs', async (req, res) => {
  const designs = await db.all(
    `SELECT d.*, u.email AS artist_email FROM designs d LEFT JOIN users u ON u.id = d.artist_id
     ORDER BY d.created_at DESC LIMIT 100`);
  res.render('admin/designs', { title: 'Designs — Admin', designs, metaDescription: '' });
});

// --- Members ---
router.get('/members', async (req, res) => {
  const users = await db.all(
    `SELECT u.*, p.name AS plan_name FROM users u
     LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active'
     LEFT JOIN plans p ON p.id = s.plan_id
     ORDER BY u.created_at DESC LIMIT 200`);
  res.render('admin/members', { title: 'Members — Admin', users, metaDescription: '' });
});

// Cancel a member's membership (off-site sales rule enforcement).
router.post('/members/:id/cancel-membership', formLimiter, checkHoneypot, async (req, res) => {
  const reason = String(req.body.reason || 'Terms violation');
  await db.query("UPDATE subscriptions SET status = 'canceled', canceled_at = ? WHERE user_id = ? AND status = 'active'",
    [db.now(), req.params.id]);
  const user = await db.get('SELECT role FROM users WHERE id = ?', [req.params.id]);
  if (user && user.role !== 'admin') await db.update('users', req.params.id, { role: 'customer' });
  await db.insert('review_queue', {
    item_type: 'note', item_id: req.params.id, reason: `Membership canceled: ${reason}`,
    status: 'closed', created_at: db.now(), reviewed_at: db.now(),
  });
  req.session.flash = 'Membership canceled — no refunds per the Terms.';
  res.redirect('/admin/members');
});

// Verify a tattoo shop (allows the limited shop profile fields).
router.post('/members/:id/verify-shop', formLimiter, checkHoneypot, async (req, res) => {
  await db.updateWhere('shop_profiles', { verified: 1 }, 'user_id', req.params.id);
  req.session.flash = 'Shop verified.';
  res.redirect('/admin/members');
});

// --- Payouts ---
router.get('/payouts', async (req, res) => {
  const balances = await db.all(
    `SELECT recipient_type, recipient_id, COALESCE(SUM(amount_cents),0) AS total
     FROM commission_ledger WHERE status = 'payable'
     GROUP BY recipient_type, recipient_id`);
  // Attach display names + payout emails.
  for (const b of balances) {
    const u = await db.get('SELECT email, display_name FROM users WHERE id = ?', [b.recipient_id]);
    b.email = u?.email || '—'; b.name = u?.display_name || '—';
    const prof = b.recipient_type === 'artist'
      ? await db.get('SELECT payout_paypal_email FROM artist_profiles WHERE user_id = ?', [b.recipient_id])
      : await db.get('SELECT payout_paypal_email FROM shop_profiles WHERE user_id = ?', [b.recipient_id]);
    b.paypal_email = prof?.payout_paypal_email || '';
  }
  const runs = await db.all('SELECT * FROM payouts ORDER BY created_at DESC LIMIT 25');
  res.render('admin/payouts', { title: 'Payouts — Admin', balances, runs, metaDescription: '' });
});

// Queue a payout run for one recipient. Ledger shares move payable -> queued
// and are linked to the payout; they become 'paid' only when the admin
// confirms the PayPal payout completed.
router.post('/payouts/run', formLimiter, checkHoneypot, async (req, res) => {
  const { recipient_type, recipient_id, paypal_email } = req.body;
  if (!['artist', 'shop'].includes(recipient_type) || !recipient_id || !paypal_email) {
    req.session.flash = 'Missing payout details.';
    return res.redirect('/admin/payouts');
  }
  const rows = await db.all(
    "SELECT id, amount_cents FROM commission_ledger WHERE recipient_type = ? AND recipient_id = ? AND status = 'payable'",
    [recipient_type, recipient_id]);
  const total = rows.reduce((s, r) => s + r.amount_cents, 0);
  if (!total) { req.session.flash = 'No payable balance for this recipient.'; return res.redirect('/admin/payouts'); }
  const payoutId = await db.insert('payouts', {
    recipient_type, recipient_id, amount_cents: total, paypal_email,
    status: 'queued', created_at: db.now(),
  });
  for (const r of rows) {
    await db.update('commission_ledger', r.id, { status: 'queued', payout_id: payoutId });
  }
  req.session.flash = `Payout of $${(total / 100).toFixed(2)} queued to ${paypal_email}. Send it via PayPal, then mark it completed. (Payout #${payoutId.slice(0, 8)})`;
  res.redirect('/admin/payouts');
});

// Manually trigger the weekly automated payout run (same code the Monday
// scheduler runs). Useful for testing or off-schedule payouts.
router.post('/payouts/auto', formLimiter, checkHoneypot, async (req, res) => {
  const { runWeeklyPayouts } = require('../lib/autopayout');
  try {
    const summary = await runWeeklyPayouts();
    req.session.flash = summary.failed
      ? `Automatic payouts failed: ${summary.error} — shares reverted to payable.`
      : `Automatic payouts done: ${summary.paid.length} recipient(s) paid, ${summary.skipped.length} skipped.`;
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
  req.session.flash = 'Payout marked completed — shares are now paid.';
  res.redirect('/admin/payouts');
});

// --- Ad space management ---
const { SLOTS: AD_SLOTS } = require('../lib/ads');

router.get('/ads', async (req, res) => {
  const ads = await db.all('SELECT * FROM ads ORDER BY created_at DESC');
  res.render('admin/ads', { title: 'Ad space — Admin', ads, slots: AD_SLOTS, metaDescription: '' });
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
  req.session.flash = `Ad "${ad.title}" is now live for ${months} month(s).`;
  res.redirect('/admin/ads');
});

router.post('/ads/:id/deactivate', formLimiter, checkHoneypot, async (req, res) => {
  await db.update('ads', req.params.id, { active: 0 });
  req.session.flash = 'Ad paused.';
  res.redirect('/admin/ads');
});

router.post('/ads/:id/delete', formLimiter, checkHoneypot, async (req, res) => {
  const ad = await db.get('SELECT * FROM ads WHERE id = ?', [req.params.id]);
  if (ad && ad.image_path) {
    const file = path.join(config.assetDir, 'uploads', 'ads', path.basename(ad.image_path));
    fs.unlink(file, () => {});
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
  res.render('admin/prints', { title: 'Print queue — Admin', prints, products: PRINT_PRODUCTS, metaDescription: '' });
});

router.post('/prints/:id/fulfill', formLimiter, checkHoneypot, async (req, res) => {
  const po = await db.get('SELECT * FROM print_orders WHERE id = ?', [req.params.id]);
  if (!po) { req.session.flash = 'Print order not found.'; return res.redirect('/admin/prints'); }
  await db.update('print_orders', po.id, { status: 'fulfilled', fulfilled_at: db.now() });
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
  const abs = rel ? path.join(config.assetDir, rel) : null;
  if (!abs || !fs.existsSync(abs)) {
    return res.status(404).render('error', { title: 'Not found', message: 'Print file is missing.' });
  }
  res.download(abs);
});

// --- Admin user management ---
router.get('/admins', async (req, res) => {
  const admins = await db.all("SELECT id, email, display_name, created_at FROM users WHERE role = 'admin' ORDER BY created_at");
  res.render('admin/admins', { title: 'Admins — Admin', admins, metaDescription: '' });
});

router.post('/admins/add', formLimiter, checkHoneypot, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await db.get('SELECT id, role FROM users WHERE email = ?', [email]);
  if (!user) { req.session.flash = 'No account with that email yet — they need to sign up first.'; }
  else if (user.role === 'admin') { req.session.flash = 'That account is already an admin.'; }
  else { await db.update('users', user.id, { role: 'admin' }); req.session.flash = `${email} is now an admin.`; }
  res.redirect('/admin/admins');
});

router.post('/admins/remove', formLimiter, checkHoneypot, async (req, res) => {
  const user = await db.get('SELECT id FROM users WHERE id = ?', [req.body.id]);
  if (!user) { req.session.flash = 'Account not found.'; }
  else if (user.id === req.user.id) { req.session.flash = 'You cannot remove your own admin access.'; }
  else { await db.update('users', user.id, { role: 'customer' }); req.session.flash = 'Admin access removed.'; }
  res.redirect('/admin/admins');
});

module.exports = router;
