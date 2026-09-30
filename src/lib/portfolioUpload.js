// Designer portfolio uploads: listing-type choice (custom portfolio piece vs
// pre-design), style picker fixed at upload, and watermark choice (site
// standard pipeline vs the artist's own watermark image). Solid-black
// anti-trace marks are applied in BOTH watermark choices by the pipeline.
// Shared by POST /artist/portfolio/upload and POST /account/upload (when the
// uploader holds an active design_artist subscription).
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const pricing = require('./pricing');
const { screenText } = require('./screening');
const { applyWatermarkedLinework, applyBlurredVariant } = require('./watermark');
const { SENSITIVITIES } = require('./contentPolicy');
const { notifyAdmins } = require('./notify');
const { notifyDesignLive } = require('./colorization');

const DESIGN_STYLES = [
  'blackwork', 'traditional', 'japanese', 'realism', 'fine-line', 'floral',
  'animals', 'geometric', 'lettering', 'tribal', 'chicano', 'dotwork',
  'watercolor', 'new-school', 'minimalist', 'other',
];

const portfolioStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = file.fieldname === 'watermark'
      ? path.join(config.assetDir, 'uploads', 'watermarks')
      : path.join(config.assetDir, 'uploads', 'designs');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 5) || '.jpg';
    cb(null, `${req.user.id}-${Date.now()}-${file.fieldname}${ext}`);
  },
});

const portfolioUploadMulter = multer({
  storage: portfolioStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, or WebP images are allowed.'));
  },
}).fields([
  { name: 'color', maxCount: 1 },
  { name: 'linework', maxCount: 1 },
  { name: 'watermark', maxCount: 1 },
]);

// req.user must be set (requireLogin). Redirects back with a flash message.
//
// Linework-only uploads (no color file) are accepted: they get
// color_source='none', color_pending=1, and enter the normal approval flow —
// the piece posts with its watermarked linework while the site-created color
// version follows via the colorization queue.
async function handlePortfolioUpload(req, res, backUrl) {
  const files = req.files || {};
  if (!files.linework) {
    req.session.flash = 'A clean linework image is required.';
    return res.redirect(backUrl);
  }
  const hasColor = !!(files.color && files.color[0]);
  const colorSource = hasColor ? 'designer' : 'none';
  const title = String(req.body.title || '').trim().slice(0, 120);
  if (!title) {
    req.session.flash = 'Give your design a title.';
    return res.redirect(backUrl);
  }
  const style = String(req.body.style || '').trim().toLowerCase();
  if (!DESIGN_STYLES.includes(style)) {
    req.session.flash = 'Pick a style for your design.';
    return res.redirect(backUrl);
  }
  const description = String(req.body.description || '').trim().slice(0, 2000);
  const extraCats = String(req.body.categories || '').split(',')
    .map((c) => c.trim().toLowerCase().replace(/[^a-z0-9- ]/g, '').slice(0, 40))
    .filter(Boolean).filter((c) => c !== style).slice(0, 11);
  // Listing type: default CUSTOM (portfolio only, custom-design price).
  // PRE-DESIGN opt-in: also listed on the main gallery at the premade price.
  const listingType = req.body.listing_type === 'predesign' ? 'predesign' : 'custom';
  const listingScope = listingType === 'predesign' ? 'gallery' : 'portfolio';
  // Watermark choice: default 'site'. 'custom' uses the uploaded file, or the
  // mark the artist built on-site (dark-on-transparent, rendered inverted so
  // the dark ink shows) when no file was attached.
  const watermarkChoice = req.body.watermark_choice === 'custom' ? 'custom' : 'site';
  let customWatermarkPath = '';
  let customWatermarkInvert = false;
  if (watermarkChoice === 'custom') {
    if (files.watermark && files.watermark[0]) {
      customWatermarkPath = path.relative(config.assetDir, files.watermark[0].path);
    } else {
      const builder = require('./watermarkBuilder');
      if (builder.defaultMarkExists(req.user.id)) {
        customWatermarkPath = builder.defaultMarkRel(req.user.id);
        customWatermarkInvert = true;
      } else {
        req.session.flash = 'Upload your watermark image, or build a theft-resistant mark on-site first — then pick "my own watermark" with no file needed.';
        return res.redirect(backUrl);
      }
    }
  }

  const screen = screenText(`${title}\n${description}`);
  // Content rating (owner policy): nudity allowed; sexual acts / highly
  // offensive content is blurred for the public preview; racist material is
  // held for admin-only review. Artist self-declares; admins can adjust.
  const sensitivity = SENSITIVITIES.includes(String(req.body.sensitivity || '').toLowerCase())
    ? String(req.body.sensitivity).toLowerCase() : 'normal';
  const holdForHate = String(req.body.sensitivity || '').toLowerCase() === 'racist';
  const id = await db.insert('designs', {
    title,
    description,
    style,
    categories: JSON.stringify([style, ...extraCats]),
    color_path: hasColor ? path.relative(config.assetDir, files.color[0].path) : '',
    color_source: colorSource,
    color_pending: colorSource === 'none' ? 1 : 0,
    linework_path: path.relative(config.assetDir, files.linework[0].path),
    linework_wm_path: '', // set by the watermark pipeline below
    sensitivity,
    price_cents: listingType === 'custom' ? pricing.customFullCents() : pricing.premadePriceCents(),
    artist_id: req.user.id,
    listing_scope: listingScope,
    listing_type: listingType,
    watermark_choice: watermarkChoice,
    custom_watermark_path: customWatermarkPath,
    // Linework-only uploads are approvable like any other piece: they post
    // with the watermarked linework and the site color version follows via
    // the colorization queue (color_pending). Racist-flagged pieces go on
    // hold for admin-only approve/reject — never auto-approved.
    status: holdForHate ? 'on_hold' : (screen.ok ? 'pending' : 'flagged'),
    created_at: db.now(),
    sale_count: 0,
  });
  if (!screen.ok) {
    await db.insert('review_queue', {
      item_type: 'design', item_id: id,
      reason: 'Contact info detected in title/description: ' + screen.flags.map((f) => f.label).join(', '),
      status: 'open', created_at: db.now(),
    });
  }
  // Tier-1 funding: every upload counts toward the uploader's monthly free
  // quota (15/Chicago month); over-quota uploads book a $0.40 review fee
  // into the prepaid pool that funds design-triage admin pay. Never touches
  // site overhead or the owner's pocket. A booking failure must never break
  // the upload itself.
  let reviewFeeNote = '';
  try {
    const { recordDesignUploadFee, REVIEW_FEE_CENTS } = require('./adminTaskPay');
    const fee = await recordDesignUploadFee(req.user.id, id);
    if (fee.charged) {
      reviewFeeNote = ` That's upload ${fee.count} this month — a $${(REVIEW_FEE_CENTS / 100).toFixed(2)} review fee was applied to your earnings balance (it pays the admin who reviews this piece).`;
    }
  } catch (e) {
    console.error('review fee booking failed for design', id, e.message);
  }
  // Remake upload: link this new piece to the sold custom piece it replaces.
  // The replacement request closes when the remake is approved.
  if (req.body.remake) {
    const { linkRemake } = require('./replacements');
    await linkRemake(String(req.body.remake), id, req.user.id);
  }
  // Generate the public watermarked linework now, with the artist's choice.
  // If generation fails, the design stays pending and the admin can attach
  // watermarked linework manually (existing fallback path).
  let wmNote = '';
  let wmRel = '';
  try {
    wmRel = await applyWatermarkedLinework({
      designId: id,
      lineworkAbs: files.linework[0].path,
      choice: watermarkChoice,
      customWatermarkAbs: customWatermarkPath
        ? path.join(config.assetDir, customWatermarkPath) : null,
      customInvert: customWatermarkInvert,
    });
    await db.update('designs', id, { linework_wm_path: wmRel });
    // Explicit content: also bake a blurred public preview (watermark stays
    // underneath). The blur lifts for age-verified opted-in viewers, the
    // artist, admins, and buyers — otherwise it stays until purchase.
    if (sensitivity === 'explicit') {
      try {
        const blurRel = await applyBlurredVariant({
          designId: id,
          watermarkedAbs: path.join(config.assetDir, wmRel),
        });
        await db.update('designs', id, { linework_blur_path: blurRel });
      } catch (e) {
        console.error('blur pipeline failed for design', id, e.message);
      }
    }
  } catch (e) {
    console.error('watermark pipeline failed for design', id, e.message);
    wmNote = ' (automatic watermarking needs an admin touch — nothing for you to do)';
  }
  // Every pending approval notifies ALL admins (in-app + email) — any one
  // of them may decide the piece's status. Trusted self-approved uploaders
  // (Adolfo, Chris, Cayli) skip the queue entirely: every upload goes live
  // immediately, approved by themselves, wherever it was headed (gallery
  // for pre-designs, portfolio for customs). Screening flags are still
  // logged to the review queue for audit, but they don't block posting.
  let finalStatus = holdForHate ? 'on_hold' : (screen.ok ? 'pending' : 'flagged');
  let selfApproved = false;
  try {
    const uploader = await db.get('SELECT auto_approve_uploads FROM users WHERE id = ?', [req.user.id]);
    if (uploader && uploader.auto_approve_uploads) {
      finalStatus = 'approved';
      selfApproved = true;
      await db.update('designs', id, { status: 'approved', approved_by: req.user.id });
      try { await notifyDesignLive(id, 'self-approved'); } catch (e) { console.error('self-approve live notify failed:', e.message); }
    }
  } catch (e) { console.error('self-approve check failed:', e.message); }
  if (!selfApproved) {
  try {
    const artistName = (req.user.display_name || req.user.email || 'A designer');
    await notifyAdmins({
      kind: 'design_pending',
      title: `New piece needs review: "${title}"`,
      body: `${artistName} uploaded "${title}" (${listingType}). Status: ${finalStatus}.` +
        (sensitivity !== 'normal' ? ` Content rating: ${sensitivity}.` : '') +
        (colorSource === 'none' ? ' Linework-only — a site color version will follow.' : ''),
      link: '/admin/designs',
      emailSubject: `[Tattoo Art Customs] Review needed: "${title}" (${finalStatus})`,
      emailText: `${artistName} uploaded "${title}" (${listingType}, ${style}).\n` +
        `Status: ${finalStatus}${sensitivity !== 'normal' ? ` | Content rating: ${sensitivity}` : ''}\n` +
        `Review it: ${config.baseUrl}/admin/designs\n\n` +
        `Any admin may approve, reject, or hold this piece.`,
    });
  } catch (e) {
    console.error('admin notify failed for design', id, e.message);
  }
  }
  req.session.flash = (selfApproved
    ? 'Art uploaded \u2014 it\u2019s live now (you approve your own pieces).'
    : (holdForHate
    ? 'Art uploaded and placed on hold — an admin will personally review it and decide.'
    : (screen.ok
      ? ((listingType === 'predesign'
        ? 'Pre-design uploaded — it goes live in the gallery and your portfolio after approval (within 2 hours).'
        : 'Custom portfolio piece uploaded — it goes live in your portfolio after approval (within 2 hours).') +
        (colorSource === 'none' ? ' It posts with your linework; we\u2019ll create the color version too.' : '') +
        (sensitivity === 'explicit' ? ' Rated explicit — the public preview is blurred.' : ''))
      : 'Art uploaded but flagged for review (possible contact info). An admin will review it.'))) + wmNote + reviewFeeNote;
  if (colorSource === 'none' && screen.ok) {
    // Tell the owner a color version needs creating (the assistant creates
    // it in a work session; attaching happens in /admin/colorization).
    try {
      const { notifyColorizationNeeded } = require('./colorization');
      await notifyColorizationNeeded(id);
    } catch (e) {
      console.error('colorization notify failed for design', id, e.message);
    }
  }
  res.redirect('/artist/portfolio');
}

module.exports = { DESIGN_STYLES, portfolioUploadMulter, handlePortfolioUpload };
