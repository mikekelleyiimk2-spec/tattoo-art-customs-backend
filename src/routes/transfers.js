// Art transfers: "send to my shop" (Phase 1) + shop "send to client" (Phase 2).
// Every transfer traces to a PAID order — enforced in lib/transfers.
const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { createTransfer, transferFiles } = require('../lib/transfers');
const { resolveStoredPath } = require('../lib/storage');

const router = express.Router();

// Verified shops with an active tattoo_shop subscription (pick list for the send form).
async function verifiedShops() {
  return db.all(
    `SELECT u.id, u.display_name, sp.business_name, sp.location
     FROM users u
     JOIN shop_profiles sp ON sp.user_id = u.id
     JOIN subscriptions s ON s.user_id = u.id
     JOIN plans p ON p.id = s.plan_id
     WHERE u.role = 'tattoo_shop' AND sp.verified = 1
       AND p.slug = 'tattoo_shop' AND s.status = 'active'
     ORDER BY COALESCE(sp.business_name, u.display_name)`
  );
}

// Send form for one of the customer's paid premade orders.
router.get('/send/:orderId', requireLogin, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', [req.params.orderId, req.user.id]);
  if (!order || order.status !== 'paid' || order.order_type !== 'premade' || !order.design_id) {
    req.session.flash = 'Only paid premade design orders can be sent to a shop.';
    return res.redirect('/account');
  }
  const design = await db.get('SELECT title FROM designs WHERE id = ?', [order.design_id]);
  const shops = await verifiedShops();
  const sent = await db.all(
    'SELECT * FROM art_transfers WHERE order_id = ? ORDER BY created_at DESC', [order.id]);
  res.render('transfers/send', {
    title: 'Send art to your shop — Tattoo Art Customs',
    order, design, shops, sent,
  });
});

// Create the transfer + email the shop.
router.post('/send/:orderId', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', [req.params.orderId, req.user.id]);
  if (!order || order.status !== 'paid' || order.order_type !== 'premade' || !order.design_id) {
    req.session.flash = 'Only paid premade design orders can be sent to a shop.';
    return res.redirect('/account');
  }
  try {
    let toShopUserId = null;
    let toEmail = String(req.body.shop_email || '').trim();
    const shopId = String(req.body.shop_user_id || '').trim();
    if (shopId) {
      const shop = await db.get(
        `SELECT u.id, u.email FROM users u JOIN shop_profiles sp ON sp.user_id = u.id
         WHERE u.id = ? AND u.role = 'tattoo_shop' AND sp.verified = 1`, [shopId]);
      if (!shop) throw new Error('Please choose a verified shop from the list.');
      toShopUserId = shop.id;
      toEmail = shop.email;
    }
    const { viewUrl } = await createTransfer({
      orderId: order.id, fromUserId: req.user.id,
      toShopUserId, toEmail, kind: 'to_shop',
    });
    req.session.flash = 'Sent! Your shop was emailed a private download link (valid 24 hours).';
    return res.redirect(`/orders/${order.id}`);
  } catch (e) {
    req.session.flash = e.message;
    return res.redirect(`/transfers/send/${order.id}`);
  }
});

// Shop "send to client" for a buy-for-client order (Phase 2).
router.post('/send-client/:orderId', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', [req.params.orderId, req.user.id]);
  if (!order || order.status !== 'paid' || !order.client_email) {
    req.session.flash = 'Only paid buy-for-client orders can be forwarded.';
    return res.redirect('/shop');
  }
  try {
    await createTransfer({
      orderId: order.id, fromUserId: req.user.id,
      toShopUserId: null, toEmail: order.client_email, kind: 'to_client',
    });
    req.session.flash = 'Forwarded! Your client was emailed a private download link (valid 24 hours).';
  } catch (e) {
    req.session.flash = e.message;
  }
  return res.redirect('/shop');
});

// Transfer landing page: license note + file links (token-scoped, 24h).
router.get('/:token', async (req, res) => {
  const tr = await db.get('SELECT * FROM art_transfers WHERE token = ?', [req.params.token]);
  if (!tr || tr.expires_at < Date.now()) {
    return res.status(410).render('error', { title: 'Link expired', message: 'This transfer link has expired. Ask the sender for a fresh one.' });
  }
  const order = await db.get('SELECT status, linework_only FROM orders WHERE id = ?', [tr.order_id]);
  if (!order || order.status !== 'paid') {
    return res.status(403).render('error', { title: 'Forbidden', message: 'This transfer is no longer valid.' });
  }
  const design = await db.get('SELECT title FROM designs WHERE id = ?', [tr.design_id]);
  res.render('transfers/download', {
    title: 'Design transfer — Tattoo Art Customs',
    transfer: tr, design, token: req.params.token,
    lineworkOnly: !!order.linework_only,
  });
});

// Serve the clean files for a transfer token.
router.get('/:token/file', async (req, res) => {
  const { transfer, order, design, error } = await transferFiles(req.params.token);
  if (error === 'expired') {
    return res.status(410).render('error', { title: 'Link expired', message: 'This transfer link has expired. Ask the sender for a fresh one.' });
  }
  if (error === 'unpaid' || error === 'missing') {
    return res.status(403).render('error', { title: 'Forbidden', message: 'This transfer is no longer valid.' });
  }
  const which = req.query.which === 'linework' ? 'linework' : 'color';
  if (order.linework_only && which === 'color') {
    return res.status(403).render('error', { title: 'Not included', message: 'This transfer covers the clean linework only.' });
  }
  const rel = which === 'linework' ? design.linework_path : design.color_path;
  const absPath = resolveStoredPath(rel);
  if (!absPath) return res.status(404).render('error', { title: 'Not found', message: 'Design files are missing.' });
  res.download(absPath);
});

module.exports = router;
