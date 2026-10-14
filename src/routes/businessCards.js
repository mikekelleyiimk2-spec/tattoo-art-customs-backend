// Business cards for tattoo-shop subscribers (owner order 2026-10-14).
// Mounted at /merch/business-cards.
//
// A merch item only shops with an active tattoo_shop subscription can
// order (admins included) — the shop's own name/contact/art on the cards.
// Pricing — FINAL (owner, 2026-10-14): paid orders at cost x 1.25 per
// tier (costs in config.js, math in lib/businessCards.js), PLUS one
// FREE box of the 50-card set for shops on the ANNUAL tattoo_shop
// plan — once per shop, ever, tracked by business_card_orders
// .is_free_box (migration 088). Paid orders ride the standard
// plumbing: orders row -> PayPal checkout (/orders/approve/:id
// capture) -> print_orders row -> lib/printful onOrderPaid submits to
// Printful (product 724) when PRINTFUL_API_KEY is set, otherwise the
// order waits in the admin print queue as a clearly-labeled
// manual-fulfillment job. A free-box order skips PayPal entirely: its
// orders row is created already 'paid' at $0 and onOrderPaid is
// called directly, so it lands in the exact same fulfillment queue.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const paypal = require('../lib/paypal');
const { onOrderPaid } = require('../lib/printful');
const pricing = require('../lib/pricing');
const bc = require('../lib/businessCards');
const { requireLogin, requireRole, hasActiveSubscription, isAdminRole } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');

const router = express.Router();

// Shop-subscriber gate (same rule as the other subscriber perks:
// requireSubscription('tattoo_shop') semantics + admin bypass).
async function requireShopSubscriber(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (isAdminRole(req.user.role)) return next();
  if (await hasActiveSubscription(req.user.id, 'tattoo_shop')) return next();
  req.session.flash = 'Business cards are a Tattoo Shop membership perk — join the shop plan to order cards for your shop.';
  return res.redirect('/membership/shops');
}

const artStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.uploadDir, 'bcards');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 5) || '.jpg';
    cb(null, `${req.user.id}-${Date.now()}-front${ext}`);
  },
});
const artUpload = multer({
  storage: artStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Card art must be a JPG, PNG, or WebP image.'));
  },
});

function tierOptions() {
  return bc.tierKeys().map((key) => {
    const tier = bc.getTier(key);
    const price = bc.priceCentsFor(key);
    return { key, cards: tier.cards, priceCents: price, purchasable: price != null };
  });
}

async function shopPrefill(userId) {
  const profile = await db.get('SELECT * FROM shop_profiles WHERE user_id = ?', [userId]).catch(() => null);
  const designs = await db.all(
    "SELECT id, title FROM designs WHERE artist_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 100",
    [userId]).catch(() => []);
  return { profile, designs };
}

// --- Order form ---
router.get('/', requireLogin, requireShopSubscriber, formLimiter, async (req, res) => {
  const { profile, designs } = await shopPrefill(req.user.id);
  // Free-box offer is visible ONLY to annual-plan shops that have not
  // redeemed it yet (owner ruling) — everyone else never sees it.
  const freeBox = await bc.freeBoxStatus(req.user.id);
  const freeTier = bc.getTier(bc.freeTierKey());
  res.render('merch/business-cards', {
    title: 'Business Cards for Your Shop — Tattoo Art Customs',
    tiers: tierOptions(),
    freeBox: { available: freeBox.available, cards: freeTier ? freeTier.cards : 50 },
    checkoutEnabled: config.businessCards.checkoutEnabled,
    shopName: (profile && profile.business_name) || '',
    shopLocation: (profile && profile.location) || '',
    myDesigns: designs,
    withFee: (c) => pricing.withFeeCents(c),
    money: pricing.money,
    metaDescription: 'Business cards for tattoo shops: your shop name, contact details, and art, printed and shipped to your door.',
  });
});

// --- Place an order ---
router.post('/', requireLogin, requireShopSubscriber, formLimiter, artUpload.single('art'), checkHoneypot, async (req, res) => {
  try {
    if (!config.businessCards.checkoutEnabled) {
      throw new Error('Business card checkout is not open yet.');
    }
    // Free first box claim (annual-plan shops only, smallest set only,
    // once ever). Eligibility is re-verified HERE, at order time —
    // the checkbox on the form is never trusted on its own. A claim
    // forces the free tier regardless of the quantity selected.
    const wantsFree = req.body.claim_free_box === '1' || req.body.claim_free_box === 'on';
    let tierKey = String(req.body.tier || '');
    if (wantsFree) {
      const status = await bc.freeBoxStatus(req.user.id);
      if (!status.available) {
        throw new Error(status.redeemed
          ? 'Your free annual box has already been claimed — reorders are regular price.'
          : 'The free first box is a perk of the annual Tattoo Shop plan.');
      }
      tierKey = bc.freeTierKey();
    }
    const tier = bc.getTier(tierKey);
    const price = wantsFree ? 0 : bc.priceCentsFor(tierKey);
    if (!tier || price == null) throw new Error('Choose a valid card quantity.');

    const fields = {
      shop_name: String(req.body.shop_name || '').slice(0, 120).trim(),
      contact_name: String(req.body.contact_name || '').slice(0, 120).trim(),
      phone: String(req.body.phone || '').slice(0, 60).trim(),
      email_line: String(req.body.email_line || '').slice(0, 120).trim(),
      address_line: String(req.body.address_line || '').slice(0, 160).trim(),
      website_line: String(req.body.website_line || '').slice(0, 120).trim(),
      socials_line: String(req.body.socials_line || '').slice(0, 160).trim(),
    };
    if (!fields.shop_name) throw new Error('Your shop name is required — it is the headline on the card.');

    // Design choice: one of the shop's own approved designs (their art on
    // file) or an uploaded logo/art file. There is no shop-logo column on
    // shop_profiles, so a logo arrives through the upload option.
    const source = req.body.design_source === 'design' ? 'design' : 'upload';
    let designId = null;
    let artFile = '';
    if (source === 'design') {
      const design = await db.get(
        "SELECT id FROM designs WHERE id = ? AND artist_id = ? AND status = 'approved'",
        [String(req.body.design_id || ''), req.user.id]);
      if (!design) throw new Error('Pick one of your own approved designs for the card front.');
      designId = design.id;
    } else {
      if (!req.file) throw new Error('Upload your logo or card art (JPG, PNG, or WebP).');
      artFile = req.file.filename;
    }

    const ship = {
      ship_name: String(req.body.ship_name || '').slice(0, 120).trim(),
      ship_address1: String(req.body.ship_address1 || '').slice(0, 160).trim(),
      ship_address2: String(req.body.ship_address2 || '').slice(0, 160).trim(),
      ship_city: String(req.body.ship_city || '').slice(0, 80).trim(),
      ship_state: String(req.body.ship_state || '').slice(0, 80).trim(),
      ship_zip: String(req.body.ship_zip || '').slice(0, 20).trim(),
      ship_country: String(req.body.ship_country || 'US').slice(0, 60).trim() || 'US',
    };
    if (!ship.ship_name || !ship.ship_address1 || !ship.ship_city || !ship.ship_zip) {
      throw new Error('Name, street address, city, and ZIP are required for shipping.');
    }

    // Compose the card BACK (contact lines) as a print-ready PNG.
    const orderStamp = `${req.user.id}-${Date.now()}`;
    let backFile = '';
    try {
      const abs = await bc.composeBackImage({
        outDir: path.join(config.uploadDir, 'bcards'),
        fileBase: orderStamp,
        shopName: fields.shop_name,
        lines: [fields.contact_name, fields.phone, fields.email_line, fields.address_line, fields.website_line, fields.socials_line],
      });
      backFile = path.basename(abs);
    } catch (e) {
      // A failed back render must not lose the sale: the front still
      // prints, and the admin sees the note in the fulfillment queue.
      console.error('business card back compose failed:', e.message);
    }

    const fee = wantsFree ? 0 : pricing.processingFeeCents(price);
    const orderId = await db.insert('orders', {
      buyer_id: req.user.id, design_id: designId, order_type: 'print',
      amount_cents: price, fee_cents: fee,
      // A free-box order is born 'paid' at $0 — no PayPal checkout —
      // and drops into the same fulfillment queue via onOrderPaid
      // below, exactly like a captured paid order.
      status: wantsFree ? 'paid' : 'pending',
      payment_method: wantsFree ? 'free_annual_perk' : 'paypal',
      ...(wantsFree ? { amount_paid_cents: 0, paid_at: db.now() } : {}),
      created_at: db.now(),
    });
    const printOrderId = db.newId();
    await db.insert('print_orders', {
      id: printOrderId, order_id: orderId, user_id: req.user.id,
      design_id: designId, combo_id: null, product: 'business_cards', quantity: 1,
      style: 'color', size: tierKey, color: 'White', ...ship, status: 'pending',
      fulfill_token: db.newId() + db.newId(), created_at: db.now(),
    });
    await db.insert('business_card_orders', {
      id: db.newId(), order_id: orderId, print_order_id: printOrderId, user_id: req.user.id,
      ...fields, tier: tierKey, quantity: tier.cards,
      design_source: source, design_id: designId, art_file: artFile, back_file: backFile,
      cost_cents: tier.cost.totalCents, price_cents: price,
      is_free_box: wantsFree ? 1 : 0,
      fulfillment_note: backFile ? '' : 'Back image failed to compose — front only; check with the shop before printing.',
      created_at: db.now(), updated_at: db.now(),
    });

    if (wantsFree) {
      // Straight to the fulfillment queue (Printful auto-submit when
      // configured, admin print queue otherwise) — same entry point a
      // captured PayPal order uses. Never throws.
      const fresh = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
      const fulfil = await onOrderPaid(fresh);
      req.session.flash = fulfil && fulfil.submitted
        ? 'Your free box of 50 cards is claimed and sent to the printer — it will ship to the address you gave.'
        : 'Your free box of 50 cards is claimed and in the print queue — we will get it printed and shipped to you.';
      return res.redirect('/merch/business-cards/mine');
    }

    try {
      const pp = await paypal.createCheckoutOrder({
        amountCents: price + fee,
        description: `Tattoo Art Customs business cards — ${tier.cards} cards for ${fields.shop_name}`,
        returnUrl: `${config.baseUrl}/orders/approve/${orderId}`,
        cancelUrl: `${config.baseUrl}/account`,
      });
      await db.update('orders', orderId, { paypal_order_id: pp.id });
      const approve = pp.links.find((l) => l.rel === 'approve');
      return res.redirect(approve.href);
    } catch (e) {
      console.error('PayPal business card order create failed:', e.message);
      req.session.flash = 'PayPal checkout is unavailable right now — you can pay manually below.';
      return res.redirect(`/orders/manual/${orderId}`);
    }
  } catch (e) {
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    req.session.flash = e.message || 'Could not start your business card order.';
    return res.redirect('/merch/business-cards');
  }
});

// --- The shop's own card orders ---
router.get('/mine', requireLogin, requireShopSubscriber, async (req, res) => {
  const rows = await db.all(
    `SELECT b.*, po.status AS fulfillment_status, po.tracking_number, po.tracking_url,
            o.status AS pay_status
     FROM business_card_orders b
     JOIN print_orders po ON po.id = b.print_order_id
     JOIN orders o ON o.id = b.order_id
     WHERE b.user_id = ? ORDER BY b.created_at DESC`, [req.user.id]);
  res.render('merch/business-cards-mine', {
    title: 'My Business Card Orders — Tattoo Art Customs',
    rows,
    money: pricing.money,
  });
});

// --- Admin: every card order + fulfillment status ---
router.get('/admin', requireLogin, requireRole('admin'), async (req, res) => {
  const rows = await db.all(
    `SELECT b.*, po.status AS fulfillment_status, po.printful_order_id, po.fulfill_token,
            o.status AS pay_status, o.amount_paid_cents, u.email AS buyer_email,
            po.ship_name, po.ship_city, po.ship_state, po.ship_zip
     FROM business_card_orders b
     JOIN print_orders po ON po.id = b.print_order_id
     JOIN orders o ON o.id = b.order_id
     JOIN users u ON u.id = b.user_id
     ORDER BY b.created_at DESC`);
  res.render('admin/business-cards', {
    title: 'Business card orders — Admin',
    rows,
    money: pricing.money,
  });
});

router.post('/admin/:id/note', requireLogin, requireRole('admin'), formLimiter, checkHoneypot, async (req, res) => {
  const row = await db.get('SELECT * FROM business_card_orders WHERE id = ?', [req.params.id]);
  if (!row) { req.session.flash = 'Business card order not found.'; return res.redirect('/merch/business-cards/admin'); }
  await db.update('business_card_orders', row.id, {
    fulfillment_note: String(req.body.fulfillment_note || '').slice(0, 500),
    updated_at: db.now(),
  });
  req.session.flash = 'Fulfillment note saved.';
  res.redirect('/merch/business-cards/admin');
});

router.post('/admin/:id/fulfill', requireLogin, requireRole('admin'), formLimiter, checkHoneypot, async (req, res) => {
  const row = await db.get('SELECT * FROM business_card_orders WHERE id = ?', [req.params.id]);
  if (!row) { req.session.flash = 'Business card order not found.'; return res.redirect('/merch/business-cards/admin'); }
  await db.update('print_orders', row.print_order_id, { status: 'fulfilled', fulfilled_at: db.now() });
  req.session.flash = 'Business card order marked fulfilled.';
  res.redirect('/merch/business-cards/admin');
});

module.exports = router;
