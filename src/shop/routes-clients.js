// Client profiles CRM routes (mounted at /shop/clients by the coordinator).
//
// Mount lines the coordinator adds in src/index.js:
//   app.use('/shop/clients', require('./shop/routes-clients'));
//
// NOTE: the view local is named `shopClient`, never `client` — a local
// named `client` collides with EJS's `client` compile option (truthy turns
// on client-side compile mode, which drops the `include` helper and breaks
// every layout include with "include is not a function").
const express = require('express');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const {
  createClient, getClients, getClient, updateClient, deleteClient, addTattoo,
} = require('./clients');

const router = express.Router();
const SHOP = requireSubscription('tattoo_shop');

// Shop: client list (with the new-client form embedded).
router.get('/', requireLogin, SHOP, async (req, res) => {
  const clients = await getClients(req.user.id);
  res.render('shop/clients/list', {
    title: 'Clients — Tattoo Art Customs', clients,
  });
});

// Shop: new-client form page.
router.get('/new', requireLogin, SHOP, async (req, res) => {
  res.render('shop/clients/new', {
    title: 'New Client — Tattoo Art Customs',
  });
});

// Shop: create a client.
router.post('/', requireLogin, SHOP, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const id = await createClient(req.user.id, req.body);
    req.session.flash = 'Client added.';
    res.redirect(`/shop/clients/${id}`);
  } catch (e) {
    req.session.flash = e.message;
    res.redirect('/shop/clients/new');
  }
});

// Shop: client detail (record + tattoo history).
router.get('/:id', requireLogin, SHOP, async (req, res) => {
  const shopClient = await getClient(req.params.id, req.user.id);
  if (!shopClient) {
    return res.status(404).render('error', { title: 'Not found', message: 'Client not found.' });
  }
  const bookings = await getRecentCompletedBookings(req.user.id);
  res.render('shop/clients/detail', {
    title: `${shopClient.name} — Tattoo Art Customs`, shopClient, bookings,
  });
});

// Shop: update a client record.
router.post('/:id', requireLogin, SHOP, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await updateClient(req.params.id, req.user.id, req.body);
    req.session.flash = 'Client updated.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect(`/shop/clients/${req.params.id}`);
});

// Shop: add a tattoo to the client's history.
router.post('/:id/tattoos', requireLogin, SHOP, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await addTattoo(req.params.id, req.user.id, req.body);
    req.session.flash = 'Tattoo added to the client\u2019s history.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect(`/shop/clients/${req.params.id}`);
});

// Shop: delete a client (and their tattoo history).
router.post('/:id/delete', requireLogin, SHOP, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await deleteClient(req.params.id, req.user.id);
    req.session.flash = 'Client deleted.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect('/shop/clients');
});

// Recent completed bookings for this shop, so a tattoo can be linked to one.
async function getRecentCompletedBookings(shopUserId) {
  const db = require('../db');
  return db.all(
    `SELECT b.id, b.start_at, u.display_name AS customer_name
     FROM bookings b JOIN users u ON u.id = b.customer_user_id
     WHERE b.shop_user_id = ? AND b.status = 'completed'
     ORDER BY b.completed_at DESC LIMIT 50`,
    [String(shopUserId)]);
}

module.exports = router;
