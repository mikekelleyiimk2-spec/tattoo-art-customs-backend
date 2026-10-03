// Design artist area (requires designer access: an active design_artist
// subscription, or a tattoo shop subscription — which includes the full
// designer membership automatically).
// Uploads, bio editor (screened), commission dashboard (splits visible
// here ONLY — never to customers), payout email setup.
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const config = require('../config');
const { resolveStoredPath } = require('../lib/storage');
const { requireLogin } = require('../middleware/auth');
const { requireDesignerAccess, dualSubBonusActive } = require('../shop/shopDesigner');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { screenText } = require('../lib/screening');
const { payableBalance } = require('../lib/commissions');
const slaEnforcer = require('../lib/slaEnforcer');
const { commissionSuspendedUntil } = require('../lib/commissions');
const { registerPayoutRoutes, payoutDashboardData } = require('../lib/payoutRoutes');
const { upsertProfile } = require('../lib/profiles');
const pricing = require('../lib/pricing');
const { DESIGN_STYLES, portfolioUploadMulter, batchUploadMulter, BATCH_MAX_ITEMS, ZIP_MAX_IMAGES, ZIP_MAX_FILE_MB, IMAGE_MAX_BYTES, handlePortfolioUpload, uploadOneDesign, extractZipImages, moveFileSync, pairZipImages } = require('../lib/portfolioUpload');
// notifyColorizationNeeded/notifyDesignLive are called by the admin-side
// colorization workflow (src/lib/colorization.js); the designer side only
// receives informational notifications — there is no approval gate here.

const router = express.Router();
router.use(requireLogin, requireDesignerAccess());
registerPayoutRoutes(router, 'artist');

// Note 2026-09-28: designer portfolio uploads live here (subscription-gated).
// /account/upload stays the free path for every logged-in member.

router.get('/portfolio', async (req, res) => {
  const designs = await db.all(
    'SELECT * FROM designs WHERE artist_id = ? ORDER BY created_at DESC', [req.user.id]);
  const appeals = await db.all(
    'SELECT design_id, status FROM design_appeals WHERE artist_id = ?', [req.user.id]).catch(() => []);
  const appealByDesign = {};
  for (const a of appeals) appealByDesign[a.design_id] = a.status;
  const me = await db.get(
    'SELECT is_founding_artist, founding_artist_ends_at FROM users WHERE id = ?', [req.user.id]);
  res.render('artist/portfolio', {
    title: 'My portfolio — Tattoo Art Customs',
    designs: designs.map((d) => ({ ...d, categories: JSON.parse(d.categories || '[]'), appealStatus: appealByDesign[d.id] || null })),
    userId: req.user.id,
    isFoundingArtist: !!(me && me.is_founding_artist),
    foundingEndsAt: me && me.founding_artist_ends_at,
    customPrice: pricing.customFullCents(), premadePrice: pricing.premadePriceCents(),
  });
});

router.get('/portfolio/upload', async (req, res) => {
  // Remake upload: the artist is replacing one of their sold custom pieces.
  let remake = null;
  if (req.query.remake) {
    const r = await db.get('SELECT * FROM design_replacements WHERE id = ?', [req.query.remake]);
    if (r && r.status === 'pending' && r.artist_id === req.user.id) {
      const sold = await db.get('SELECT title FROM designs WHERE id = ?', [r.design_id]);
      remake = { id: r.id, title: sold ? sold.title : (r.title || 'your sold piece') };
    }
  }
  res.render('artist/portfolio-upload', {
    title: 'Upload a new piece — Tattoo Art Customs',
    styles: DESIGN_STYLES, action: '/artist/portfolio/upload',
    customPrice: pricing.customFullCents(), premadePrice: pricing.premadePriceCents(),
    remake,
  });
});

// ---- Batch upload: up to BATCH_MAX_ITEMS designs in one submission.
// Per-item: linework_N (required), color_N (optional), title_N, style_N.
// Shared across the batch: description, categories, listing_type,
// watermark_choice (+ one shared watermark file), sensitivity.
router.get('/portfolio/upload-batch', async (req, res) => {
  res.render('artist/portfolio-upload-batch', {
    title: 'Batch upload — Tattoo Art Customs',
    styles: DESIGN_STYLES, maxItems: BATCH_MAX_ITEMS,
    customPrice: pricing.customFullCents(), premadePrice: pricing.premadePriceCents(),
  });
});

router.post('/portfolio/upload-batch', formLimiter, (req, res, next) => {
  batchUploadMulter(req, res, (err) => {
    if (err) { req.session.flash = err.message; return res.redirect('/artist/portfolio/upload-batch'); }
    next();
  });
}, checkHoneypot, async (req, res) => {
  // Whole-handler guard: an unexpected throw here must never become an
  // unhandled rejection (which crashes the worker and 502s the whole
  // site) — fail this upload with a clean flash instead.
  try {
  const byField = {};
  for (const f of (req.files || [])) byField[f.fieldname] = f;
  // Non-zip files keep the 15 MB image cap (multer's per-file fileSize is
  // the zip-sized cap now, so this is enforced manually — same flash UX).
  for (const f of (req.files || [])) {
    if (f.fieldname !== 'zipfile' && f.size > IMAGE_MAX_BYTES) {
      req.session.flash = 'Each image must be under 15 MB.';
      return res.redirect('/artist/portfolio/upload-batch');
    }
  }
  const shared = {
    description: req.body.description,
    categories: req.body.categories,
    listing_type: req.body.listing_type,
    watermark_choice: req.body.watermark_choice,
    sensitivity: req.body.sensitivity,
    remake: '',
  };
  const results = [];
  let zipEmptyMsg = '';
  let zipNote = '';
  // Zip archive path: extract images server-side, then pair them into
  // designs — files sharing a name key (e.g. 01_foo_color.png +
  // 01_foo_linework.png) become ONE design with the linework in the
  // linework slot and the color version attached. Neutral names keep the
  // historic one-design-per-image behavior. Shared metadata applies to
  // every piece; titles default to the file names; style comes from the
  // zip_style select.
  const zipFile = byField['zipfile'];
  if (zipFile) {
    let extraction = null;
    try {
      extraction = await extractZipImages(zipFile.path);
    } catch (e) {
      console.error('zip batch extract failed:', e.message);
      try { fs.unlinkSync(zipFile.path); } catch (_) {}
      req.session.flash = e.message;
      return res.redirect('/artist/portfolio/upload-batch');
    }
    try { fs.unlinkSync(zipFile.path); } catch (_) {} // archive itself is not kept
    if (!extraction.files.length) {
      zipEmptyMsg = 'No usable images found in that zip (JPG, PNG, or WebP only).';
    } else {
      const designsDir = path.join(config.uploadDir, 'designs');
      fs.mkdirSync(designsDir, { recursive: true });
      const zipStyle = String(req.body.zip_style || '').trim().toLowerCase();
      const { pairs, problems } = pairZipImages(extraction.files);
      for (const p of problems) {
        results.push({ index: `${p.title} (from zip)`, ok: false, error: p.error });
      }
      let n = 0;
      for (const pair of pairs) {
        n++;
        // Move into the designs dir with a unique name so the stored
        // original lives where the pipeline expects it (same as multer).
        // moveFileSync tolerates EXDEV (cross-mount temp dir).
        const moveOne = (img, slot) => {
          const ext = path.extname(img.originalname).toLowerCase();
          const stored = path.join(designsDir,
            `${req.user.id}-${Date.now()}-zipbatch-${n}-${slot}-${Math.random().toString(36).slice(2, 8)}${ext}`);
          moveFileSync(img.absPath, stored);
          return { path: stored, originalname: img.originalname, mimetype: img.mimetype, fieldname: slot };
        };
        let lwFile = null;
        let colorFile = null;
        try {
          lwFile = moveOne(pair.linework, 'linework');
          if (pair.color) colorFile = moveOne(pair.color, 'color');
        } catch (e) {
          console.error('zip image move failed:', e.message);
          results.push({ index: `${pair.title} (from zip)`, ok: false, error: 'Could not store the image — please try this one again.' });
          continue;
        }
        const fields = { ...shared, title: pair.title, style: zipStyle };
        try {
          const r = await uploadOneDesign(req.user, {
            linework: lwFile,
            color: colorFile,
            watermark: byField['watermark'] || null,
          }, fields);
          results.push({ index: `${pair.title} (from zip)`, ...r });
        } catch (e) {
          console.error('zip batch item failed:', e.message);
          results.push({ index: `${pair.title} (from zip)`, ok: false, error: 'Upload failed — please try this one again.' });
        }
      }
      if (extraction.truncated) {
        zipNote = `Only the first ${ZIP_MAX_IMAGES} images in the zip were used.`;
      }
    }
    try { fs.rmSync(extraction.tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
  for (let i = 0; i < BATCH_MAX_ITEMS; i++) {
    const lw = byField[`linework_${i}`];
    if (!lw) continue; // empty row — skip
    const fields = {
      ...shared,
      title: req.body[`title_${i}`],
      style: req.body[`style_${i}`],
    };
    try {
      const r = await uploadOneDesign(req.user, {
        linework: lw,
        color: byField[`color_${i}`] || null,
        watermark: byField['watermark'] || null,
      }, fields);
      results.push({ index: i, ...r });
    } catch (e) {
      console.error('batch upload item failed:', e.message);
      results.push({ index: i, ok: false, error: 'Upload failed — please try this one again.' });
    }
  }
  if (!results.length) {
    req.session.flash = zipEmptyMsg || 'Add at least one linework image to upload.';
    return res.redirect('/artist/portfolio/upload-batch');
  }
  res.render('artist/portfolio-upload-result', {
    title: 'Batch upload results — Tattoo Art Customs',
    results, note: zipNote,
  });
  } catch (e) {
    console.error('batch upload handler failed:', e);
    req.session.flash = 'Something went wrong processing that upload — please try again.';
    return res.redirect('/artist/portfolio/upload-batch');
  }
});

router.post('/portfolio/upload', formLimiter, (req, res, next) => {
  portfolioUploadMulter(req, res, (err) => {
    if (err) { req.session.flash = err.message; return res.redirect('/artist/portfolio/upload'); }
    next();
  });
}, checkHoneypot, async (req, res) => {
  await handlePortfolioUpload(req, res, '/artist/portfolio/upload');
});

// On-site watermark builder (owner rule 2026-09-29): the builder only
// produces dense dark marks — protection is not opt-in, and it refuses to
// make weak ones. The saved mark becomes the artist's default custom
// watermark for uploads where they pick "my own watermark".
router.get('/watermark-builder', async (req, res) => {
  const builder = require('../lib/watermarkBuilder');
  res.render('artist/watermark-builder', {
    title: 'Build your watermark — Tattoo Art Customs',
    palette: builder.DARK_PALETTE,
    hasMark: builder.defaultMarkExists(req.user.id),
    error: null,
    values: { line1: '', line2: '', line3: '', color: builder.DARK_PALETTE[0].hex },
  });
});

router.post('/watermark-builder', formLimiter, checkHoneypot, async (req, res) => {
  const builder = require('../lib/watermarkBuilder');
  const values = {
    line1: String(req.body.line1 || ''),
    line2: String(req.body.line2 || ''),
    line3: String(req.body.line3 || ''),
    color: String(req.body.color || ''),
  };
  try {
    await builder.buildAndSave({
      artistId: req.user.id,
      lines: [values.line1, values.line2, values.line3],
      color: values.color,
    });
    req.session.flash = 'Your theft-resistant mark is saved — it will be used automatically whenever you choose "my own watermark" on an upload.';
    return res.redirect('/artist/watermark-builder');
  } catch (e) {
    res.render('artist/watermark-builder', {
      title: 'Build your watermark — Tattoo Art Customs',
      palette: builder.DARK_PALETTE,
      hasMark: builder.defaultMarkExists(req.user.id),
      error: e.message,
      values,
    });
  }
});

// The artist's own saved mark (private to them — never mounted publicly).
router.get('/watermark-builder/preview', async (req, res) => {
  const builder = require('../lib/watermarkBuilder');
  if (!builder.defaultMarkExists(req.user.id)) return res.status(404).send('No mark built yet.');
  res.type('png').send(fs.readFileSync(builder.defaultMarkAbs(req.user.id)));
});

router.get('/portfolio/:id/edit', async (req, res) => {
  const design = await db.get('SELECT * FROM designs WHERE id = ? AND artist_id = ?', [req.params.id, req.user.id]);
  if (!design) return res.status(404).render('error', { title: 'Not found', message: 'That piece is not in your portfolio.' });
  const cats = JSON.parse(design.categories || '[]');
  res.render('artist/portfolio-edit', {
    title: 'Edit piece — Tattoo Art Customs',
    design, styles: DESIGN_STYLES,
    extraCats: cats.filter((c) => c !== design.style).join(', '),
  });
});

router.post('/portfolio/:id/edit', formLimiter, checkHoneypot, async (req, res) => {
  const design = await db.get('SELECT * FROM designs WHERE id = ? AND artist_id = ?', [req.params.id, req.user.id]);
  if (!design) return res.status(404).render('error', { title: 'Not found', message: 'That piece is not in your portfolio.' });
  const title = String(req.body.title || '').trim().slice(0, 120);
  if (!title) { req.session.flash = 'Give your design a title.'; return res.redirect(`/artist/portfolio/${design.id}/edit`); }
  const style = String(req.body.style || '').trim().toLowerCase();
  if (!DESIGN_STYLES.includes(style)) { req.session.flash = 'Pick a style.'; return res.redirect(`/artist/portfolio/${design.id}/edit`); }
  const description = String(req.body.description || '').trim().slice(0, 2000);
  const extraCats = String(req.body.categories || '').split(',')
    .map((c) => c.trim().toLowerCase().replace(/[^a-z0-9- ]/g, '').slice(0, 40))
    .filter(Boolean).filter((c) => c !== style).slice(0, 11);
  const screen = screenText(`${title}\n${description}`);
  await db.update('designs', design.id, {
    title, description, style, categories: JSON.stringify([style, ...extraCats]),
  });
  if (!screen.ok) {
    await db.insert('review_queue', {
      item_type: 'design', item_id: design.id,
      reason: 'Contact info detected in edited title/description: ' + screen.flags.map((f) => f.label).join(', '),
      status: 'open', created_at: db.now(),
    });
    req.session.flash = 'Saved, but flagged for review (possible contact info). An admin will review it.';
  } else {
    req.session.flash = 'Piece updated.';
  }
  res.redirect('/artist/portfolio');
});

router.post('/portfolio/:id/delete', formLimiter, checkHoneypot, async (req, res) => {  const design = await db.get('SELECT * FROM designs WHERE id = ? AND artist_id = ?', [req.params.id, req.user.id]);
  if (!design) return res.status(404).render('error', { title: 'Not found', message: 'That piece is not in your portfolio.' });
  const paid = await db.get("SELECT id FROM orders WHERE design_id = ? AND status = 'paid' LIMIT 1", [design.id]);
  if (paid || (design.sale_count || 0) > 0) {
    req.session.flash = 'This piece has sales and cannot be deleted — contact an administrator.';
    return res.redirect('/artist/portfolio');
  }
  for (const p of [design.color_path, design.linework_path, design.linework_wm_path, design.custom_watermark_path]) {
    const abs = p ? resolveStoredPath(p) : null;
    if (abs) { try { fs.unlinkSync(abs); } catch { /* already gone */ } }
  }
  await db.query('DELETE FROM designs WHERE id = ?', [design.id]);
  req.session.flash = 'Piece deleted.';
  res.redirect('/artist/portfolio');
});

// --- Appeal: one appeal per rejected design, decided by the site owner.
// The owner's decision is final.
router.post('/portfolio/:id/appeal', formLimiter, checkHoneypot, async (req, res) => {
  const design = await db.get('SELECT * FROM designs WHERE id = ? AND artist_id = ?', [req.params.id, req.user.id]);
  if (!design) return res.status(404).render('error', { title: 'Not found', message: 'That piece is not in your portfolio.' });
  if (design.status !== 'rejected') {
    req.session.flash = 'Only rejected pieces can be appealed.';
    return res.redirect('/artist/portfolio');
  }
  const existing = await db.get('SELECT id, status FROM design_appeals WHERE design_id = ?', [design.id]).catch(() => null);
  if (existing) {
    req.session.flash = existing.status === 'open'
      ? 'Your appeal is already with the site owner for a final decision.'
      : 'You already used your one appeal for this piece — the owner\u2019s decision is final.';
    return res.redirect('/artist/portfolio');
  }
  const reason = String(req.body.reason || '').trim().slice(0, 2000);
  if (!reason) {
    req.session.flash = 'Tell the owner why the rejection should be reconsidered.';
    return res.redirect('/artist/portfolio');
  }
  await db.insert('design_appeals', {
    design_id: design.id, artist_id: req.user.id, reason,
    status: 'open', created_at: db.now(),
  });
  // The appeal goes to the site owner (head_admin) — in-app + email.
  const { notifyUser, adminUsers } = require('../lib/notify');
  const { sendMail } = require('../lib/mail');
  const config = require('../config');
  const owners = (await adminUsers()).filter((a) => a.role === 'head_admin');
  const artistName = req.user.display_name || req.user.email || 'A designer';
  const { pushToUser } = require('../lib/push');
  for (const o of owners) {
    await notifyUser(o.id, {
      kind: 'design_appeal',
      title: `Appeal needs your final decision: "${design.title || 'untitled'}"`,
      body: `${artistName} appealed the rejection of "${design.title || 'untitled'}".\n\nTheir case: ${reason}\n\nYour decision is final.`,
      link: '/admin/appeals',
    });
    try { await pushToUser(o.id, {
      title: `Appeal needs your final decision: "${design.title || 'untitled'}"`,
      body: `${artistName} appealed the rejection. Your decision is final.`,
      url: '/admin/appeals',
    }); } catch (e) { console.error('appeal push failed:', e.message); }
    if (o.email) {
      try {
        await sendMail({
          to: o.email,
          subject: `[Tattoo Art Customs] Appeal — final decision needed: "${design.title || 'untitled'}"`,
          text: `${artistName} appealed the rejection of "${design.title || 'untitled'}".\n\nTheir case:\n${reason}\n\nDecide here: ${config.baseUrl}/admin/appeals\n\nYour decision is final.`,
        });
      } catch (e) { console.error('appeal email failed:', e.message); }
    }
  }
  req.session.flash = 'Appeal submitted to the site owner — their decision is final.';
  res.redirect('/artist/portfolio');
});

// --- Colorization status: site-created color versions are approved by a
// site administrator only (no designer approval gate). The private preview
// and any approval controls were removed per the 2026-09-28 workflow — the
// designer is notified when color is attached and when the piece goes live.

router.get('/', async (req, res) => {
  const designs = await db.all('SELECT * FROM designs WHERE artist_id = ? ORDER BY created_at DESC', [req.user.id]);
  const profile = await db.get('SELECT * FROM artist_profiles WHERE user_id = ?', [req.user.id]) || {};
  const balance = await payableBalance('artist', req.user.id);
  const payouts = await db.all(
    "SELECT * FROM payouts WHERE recipient_type = 'artist' AND recipient_id = ? ORDER BY created_at DESC LIMIT 10",
    [req.user.id]);
  const ledger = await db.all(
    'SELECT * FROM commission_ledger WHERE recipient_type = ? AND recipient_id = ? ORDER BY created_at DESC LIMIT 25',
    ['artist', req.user.id]);
  const payout = await payoutDashboardData(req.user.id, 'artist');
  // SLA banner: this artist's at-risk (<24h) and overdue custom orders.
  // Terminated orders are excluded — the artist's assignment on those ended.
  const nowMs = Date.now();
  const slaRows = await db.all(
    `SELECT id, custom_brief, delivery_due, custom_status, late_penalty_days
     FROM orders WHERE order_type = 'custom' AND status = 'paid'
     AND requested_artist_id = ? AND custom_status NOT IN ('delivered', 'order_terminated')
     AND delivery_due IS NOT NULL ORDER BY delivery_due ASC`, [req.user.id]);
  const slaOrders = [];
  const slaRepeat = await slaEnforcer.repeatOffenderInfo(req.user.id, nowMs);
  // Tier 2: commission suspension notice (plain, warm — account stays active).
  const commissionPausedUntil = await commissionSuspendedUntil(req.user.id, nowMs);
  // Remake requests: this artist's sold custom pieces awaiting their remake.
  const remakeRequests = await db.all(
    `SELECT r.id, r.title, r.style, r.categories, d.title AS sold_title
     FROM design_replacements r LEFT JOIN designs d ON d.id = r.design_id
     WHERE r.artist_id = ? AND r.status = 'pending' ORDER BY r.created_at ASC`,
    [req.user.id]);
  for (const o of slaRows) {
    const pen = await db.get(
      `SELECT COALESCE(SUM(deduction_cents),0) AS t FROM sla_penalties WHERE order_id = ?`, [o.id]);
    const msLeft = o.delivery_due - nowMs;
    const daysLate = Math.max(0, Math.floor(-msLeft / 86400000));
    if (daysLate > 0 || msLeft <= 24 * 3600 * 1000) {
      slaOrders.push({
        id: o.id, brief: (o.custom_brief || '').slice(0, 80),
        status: (o.custom_status || '').replace(/_/g, ' '),
        days_late: daysLate, hours_left: Math.max(0, Math.floor(msLeft / 3600000)),
        penalty_cents: pen.t,
      });
    }
  }
  res.render('artist/dashboard', {
    title: 'Artist Dashboard — Tattoo Art Customs',
    designs: designs.map((d) => ({ ...d, categories: JSON.parse(d.categories || '[]') })),
    profile, balance, payouts, ledger,
    slaOrders, slaRepeat, repeatNotice: slaEnforcer.REPEAT_OFFENDER_NOTICE, nowMs,
    commissionPausedUntil, remakeRequests,
    dualBonus: await dualSubBonusActive(req.user.id),
    ...payout,
  });
});

router.get('/upload', (req, res) => res.redirect('/artist/portfolio/upload'));
router.post('/upload', (req, res) => res.redirect(307, '/artist/portfolio/upload'));
// Note 2026-09-28: designer portfolio uploads live at /artist/portfolio/upload
// (subscription-gated). /account/upload stays the free path for members.

// Bio editor — contact info is hard-blocked: never saved, never shown publicly.
router.post('/bio', formLimiter, checkHoneypot, async (req, res) => {
  const bio = String(req.body.bio || '').trim().slice(0, 2000);
  const screen = screenText(bio);
  if (!screen.ok) {
    req.session.flash = 'Blocked: bios may not contain contact info or off-site links — no emails, phones, socials, or payment info. (' +
      screen.flags.map((f) => f.label).join(', ') + ')';
    return res.redirect('/artist');
  }
  await upsertProfile('artist_profiles', req.user.id, { bio, bio_status: 'ok' });
  req.session.flash = 'Bio updated.';
  res.redirect('/artist');
});

// Payout method (PayPal email).
router.post('/payout-email', formLimiter, checkHoneypot, async (req, res) => {
  const email = String(req.body.paypal_email || '').trim().toLowerCase().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    req.session.flash = 'Enter a valid PayPal email.';
    return res.redirect('/artist');
  }
  await upsertProfile('artist_profiles', req.user.id, { payout_paypal_email: email });
  req.session.flash = 'Payout email saved. You become payable once registered, subscribed, and this is set.';
  res.redirect('/artist');
});

module.exports = router;
