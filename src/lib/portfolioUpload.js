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
const { applyWatermarkedLinework } = require('./watermark');

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
async function handlePortfolioUpload(req, res, backUrl) {
  const files = req.files || {};
  if (!files.color || !files.linework) {
    req.session.flash = 'Both a full-color image and a clean linework image are required.';
    return res.redirect(backUrl);
  }
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
  // Watermark choice: default 'site'. 'custom' requires an uploaded image.
  const watermarkChoice = req.body.watermark_choice === 'custom' ? 'custom' : 'site';
  let customWatermarkPath = '';
  if (watermarkChoice === 'custom') {
    if (!files.watermark || !files.watermark[0]) {
      req.session.flash = 'Upload your watermark image, or choose the site watermark instead.';
      return res.redirect(backUrl);
    }
    customWatermarkPath = path.relative(config.assetDir, files.watermark[0].path);
  }

  const screen = screenText(`${title}\n${description}`);
  const id = await db.insert('designs', {
    title,
    description,
    style,
    categories: JSON.stringify([style, ...extraCats]),
    color_path: path.relative(config.assetDir, files.color[0].path),
    linework_path: path.relative(config.assetDir, files.linework[0].path),
    linework_wm_path: '', // set by the watermark pipeline below
    price_cents: listingType === 'custom' ? pricing.customFullCents() : pricing.premadePriceCents(),
    artist_id: req.user.id,
    listing_scope: listingScope,
    listing_type: listingType,
    watermark_choice: watermarkChoice,
    custom_watermark_path: customWatermarkPath,
    status: screen.ok ? 'pending' : 'flagged',
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
  // Generate the public watermarked linework now, with the artist's choice.
  // If generation fails, the design stays pending and the admin can attach
  // watermarked linework manually (existing fallback path).
  let wmNote = '';
  try {
    const wmRel = await applyWatermarkedLinework({
      designId: id,
      lineworkAbs: files.linework[0].path,
      choice: watermarkChoice,
      customWatermarkAbs: customWatermarkPath
        ? path.join(config.assetDir, customWatermarkPath) : null,
    });
    await db.update('designs', id, { linework_wm_path: wmRel });
  } catch (e) {
    console.error('watermark pipeline failed for design', id, e.message);
    wmNote = ' (automatic watermarking needs an admin touch — nothing for you to do)';
  }
  req.session.flash = (screen.ok
    ? (listingType === 'predesign'
      ? 'Pre-design uploaded — it goes live in the gallery and your portfolio after admin approval.'
      : 'Custom portfolio piece uploaded — it goes live in your portfolio after admin approval.')
    : 'Art uploaded but flagged for review (possible contact info). An admin will review it.') + wmNote;
  res.redirect('/artist/portfolio');
}

module.exports = { DESIGN_STYLES, portfolioUploadMulter, handlePortfolioUpload };
