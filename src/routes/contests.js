// Design contests / bounty board (mounted at /contests). Owner rule 2026-09-30.
//
// Public board lists open contests; entry images stay private (contest
// holder + admins + each entry's own designer) until a winner is picked,
// when the winning entry is shown publicly. The winner's rights transfer
// to the contest holder; every other entry remains the designer's.
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { resolveStoredPath } = require('../lib/storage');
const paypal = require('../lib/paypal');
const pricing = require('../lib/pricing');
const { requireLogin } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { requireDesignerAccess } = require('../shop/shopDesigner');
const { DESIGN_STYLES } = require('../lib/portfolioUpload');
const {
  CONTEST_MIN_PRIZE_CENTS, CONTEST_PRIZE_SUGGESTIONS, contestQuote,
  createPendingContest, openContest, contestEntries, enterContest,
  pickWinner, timeLeftMs,
} = require('../lib/contests');

const router = express.Router();

const contestUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(config.uploadDir, 'contests');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 5) || '.jpg';
      cb(null, `${req.params.id}-${req.user.id}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, or WebP images are allowed.'));
  },
}).single('entry_image');

function fmtLeft(ms) {
  if (ms == null) return '';
  const h = Math.floor(ms / 3600000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60000))}m left`;
  if (h < 48) return `${h}h left`;
  return `${Math.floor(h / 24)}d left`;
}

// --- Public bounty board ---
router.get('/', async (req, res) => {
  const open = await db.all(
    `SELECT c.*, (SELECT COUNT(*) FROM contest_entries e WHERE e.contest_id = c.id) AS entry_count,
            u.display_name AS customer_name
     FROM contests c LEFT JOIN users u ON u.id = c.customer_id
     WHERE c.status IN ('open', 'judging') ORDER BY c.created_at DESC`
  );
  const recent = await db.all(
    `SELECT c.*, u.display_name AS winner_name, e.image_path AS winner_image
     FROM contests c LEFT JOIN users u ON u.id = c.winner_user_id
     LEFT JOIN contest_entries e ON e.id = c.winner_entry_id
     WHERE c.status = 'awarded' ORDER BY c.awarded_at DESC LIMIT 6`
  );
  res.render('contests/index', {
    title: 'Design Contests — Tattoo Art Customs',
    open, recent, money: pricing.money, fmtLeft, timeLeftMs,
    metaDescription: 'Post a tattoo design bounty or win one — design contests with real cash prizes.',
  });
});

// --- New contest form ---
router.get('/new', requireLogin, (req, res) => {
  res.render('contests/new', {
    title: 'Post a Design Contest — Tattoo Art Customs',
    styles: DESIGN_STYLES,
    suggestions: CONTEST_PRIZE_SUGGESTIONS.map((p) => ({ prize: p, quote: contestQuote(p) })),
    minPrize: CONTEST_MIN_PRIZE_CENTS, money: pricing.money,
  });
});

router.post('/', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const { contestId, orderId, quote } = await createPendingContest({
      customerId: req.user.id,
      title: req.body.title,
      description: req.body.description,
      style: req.body.style,
      sizePlacement: req.body.size_placement,
      prizeCents: parseInt(req.body.prize_cents, 10),
    });
    try {
      const pp = await paypal.createCheckoutOrder({
        amountCents: quote.totalCents,
        description: `Tattoo Art Customs design contest prize escrow — "${String(req.body.title).slice(0, 60)}"`,
        returnUrl: `${config.baseUrl}/contests/capture/${contestId}`,
        cancelUrl: `${config.baseUrl}/contests/new`,
      });
      await db.update('orders', orderId, { paypal_order_id: pp.id });
      await db.update('contests', contestId, { paypal_order_id: pp.id });
      const approve = pp.links.find((l) => l.rel === 'approve');
      return res.redirect(approve.href);
    } catch (e) {
      console.error('PayPal contest checkout failed:', e.message);
      req.session.flash = 'PayPal checkout is unavailable right now — you can pay the prize manually below.';
      return res.redirect(`/orders/manual/${orderId}`);
    }
  } catch (e) {
    req.session.flash = e.message || 'Could not create your contest.';
    return res.redirect('/contests/new');
  }
});

// --- PayPal return: capture prize escrow, open the contest ---
router.get('/capture/:id', requireLogin, async (req, res) => {
  try {
    const c = await db.get('SELECT * FROM contests WHERE id = ? AND customer_id = ?', [req.params.id, req.user.id]);
    if (!c) throw new Error('Contest not found.');
    if (c.status === 'open') return res.redirect(`/contests/${c.id}`);
    if (c.status !== 'pending_payment') throw new Error('This contest is no longer awaiting payment.');
    const order = await db.get(
      `SELECT * FROM orders WHERE buyer_id = ? AND order_type = 'contest' AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );
    if (!order || !order.paypal_order_id) throw new Error('No pending prize payment found.');
    const capture = await paypal.captureCheckoutOrder(order.paypal_order_id);
    // Prize + fee must be captured exactly — never open the contest on a
    // short escrow payment.
    const paidCents = paypal.assertCaptureAmount(capture, order.amount_cents + (order.fee_cents || 0));
    await openContest(c.id, { paidCents, paymentMethod: 'paypal', paypalOrderId: order.paypal_order_id });
    req.session.flash = 'Prize escrow received — your contest is live for 7 days.';
    res.redirect(`/contests/${c.id}`);
  } catch (e) {
    req.session.flash = 'Contest activation failed: ' + e.message;
    res.redirect('/contests');
  }
});

// --- Contest detail ---
router.get('/:id', async (req, res) => {
  const c = await db.get(
    `SELECT c.*, u.display_name AS customer_name FROM contests c
     LEFT JOIN users u ON u.id = c.customer_id WHERE c.id = ?`,
    [req.params.id]
  );
  if (!c) return res.status(404).render('error', { title: 'Not found', message: 'Contest not found.' });
  const me = req.session && req.session.userId
    ? await db.get('SELECT id, role FROM users WHERE id = ?', [req.session.userId]).catch(() => null)
    : null;
  const isCustomer = !!(me && me.id === c.customer_id);
  const isAdmin = !!(me && (me.role === 'admin' || me.role === 'head_admin'));
  const all = await db.all(
    `SELECT e.*, u.display_name AS designer_name FROM contest_entries e
     LEFT JOIN users u ON u.id = e.designer_id WHERE e.contest_id = ? ORDER BY e.created_at ASC`,
    [c.id]
  );
  // Entries are private until judged: the holder, admins, and each entry's
  // own designer can see them. The winning entry goes public on award.
  const entries = all.map((e) => ({
    ...e,
    visible: c.status === 'awarded' ? e.id === c.winner_entry_id : (isCustomer || isAdmin || (me && me.id === e.designer_id)),
    mine: !!(me && me.id === e.designer_id),
  }));
  const canPick = (isCustomer || isAdmin) && ['open', 'judging'].includes(c.status) && all.length > 0;
  const canEnter = !!(me && c.status === 'open' && me.id !== c.customer_id);
  res.render('contests/detail', {
    title: `${c.title} — Design Contest — Tattoo Art Customs`,
    c, entries, entryCount: all.length, isCustomer, isAdmin, canPick, canEnter, me,
    money: pricing.money, fmtLeft, timeLeftMs, leftMs: timeLeftMs(c),
  });
});

// --- Entry image file (auth-gated) ---
router.get('/entry/:entryId/file', async (req, res) => {
  const e = await db.get('SELECT * FROM contest_entries WHERE id = ?', [req.params.entryId]);
  if (!e) return res.status(404).send('Not found');
  const c = await db.get('SELECT * FROM contests WHERE id = ?', [e.contest_id]);
  if (!c) return res.status(404).send('Not found');
  const me = req.session && req.session.userId
    ? await db.get('SELECT id, role FROM users WHERE id = ?', [req.session.userId]).catch(() => null)
    : null;
  const publicWinner = c.status === 'awarded' && c.winner_entry_id === e.id;
  const allowed = publicWinner || (me && (me.id === c.customer_id || me.id === e.designer_id || me.role === 'admin' || me.role === 'head_admin'));
  if (!allowed) return res.status(403).send('Not allowed');
  const abs = resolveStoredPath(e.image_path);
  if (!abs) return res.status(404).send('File missing');
  res.sendFile(abs);
});

// --- Enter a contest (designers) ---
router.get('/:id/enter', requireLogin, requireDesignerAccess(), (req, res) => {
  res.render('contests/enter', {
    title: 'Enter contest — Tattoo Art Customs',
    contestId: req.params.id,
  });
});

router.post('/:id/enter', requireLogin, requireDesignerAccess(), formLimiter, (req, res, next) => {
  contestUpload(req, res, (err) => {
    if (err) { req.session.flash = err.message; return res.redirect(`/contests/${req.params.id}/enter`); }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) throw new Error('Attach your entry image (JPG, PNG, or WebP).');
    const rel = path.relative(config.uploadDir, req.file.path);
    await enterContest({
      contestId: req.params.id, designerId: req.user.id,
      imagePath: rel, note: req.body.note,
    });
    req.session.flash = 'Entry submitted — good luck!';
    res.redirect(`/contests/${req.params.id}`);
  } catch (e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    req.session.flash = e.message || 'Could not submit your entry.';
    res.redirect(`/contests/${req.params.id}/enter`);
  }
});

// --- Pick the winner (contest holder or admin) ---
router.post('/:id/pick/:entryId', requireLogin, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const me = await db.get('SELECT id, role FROM users WHERE id = ?', [req.user.id]);
    const isAdmin = me && (me.role === 'admin' || me.role === 'head_admin');
    const { winnerShare } = await pickWinner({
      contestId: req.params.id, entryId: req.params.entryId,
      pickerId: req.user.id, pickerIsAdmin: !!isAdmin,
    });
    req.session.flash = `Winner picked — ${pricing.money(winnerShare)} goes to the winning designer.`;
  } catch (e) {
    req.session.flash = e.message || 'Could not pick a winner.';
  }
  res.redirect(`/contests/${req.params.id}`);
});

module.exports = router;
