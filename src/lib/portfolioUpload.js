// Designer portfolio uploads: listing-type choice (custom portfolio piece vs
// pre-design), style picker fixed at upload, and watermark choice (site
// standard pipeline vs the artist's own watermark image). Solid-black
// anti-trace marks are applied in BOTH watermark choices by the pipeline.
// Shared by POST /artist/portfolio/upload and POST /account/upload (when the
// uploader holds an active design_artist subscription).
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const yauzl = require('yauzl');
const db = require('../db');
const config = require('../config');
const { resolveStoredPath } = require('./storage');
const pricing = require('./pricing');
const { screenText } = require('./screening');
const { applyWatermarkedLinework, applyBlurredVariant } = require('./watermark');
const { SENSITIVITIES } = require('./contentPolicy');
const { notifyAdmins } = require('./notify');
const { notifyDesignLive } = require('./colorization');
const { isHeadAdmin } = require('../middleware/auth');

const DESIGN_STYLES = [
  'blackwork', 'traditional', 'japanese', 'realism', 'fine-line', 'floral',
  'animals', 'geometric', 'lettering', 'tribal', 'chicano', 'dotwork',
  'watercolor', 'new-school', 'minimalist', 'pixelated', 'circuit-bloom',
  'ascii-skin', 'kintsugi', 'topographic', 'smoke-form', 'thermal',
  'blueprint', 'cross-stitch', 'stained-shard', 'bioluminescent',
  'mycelium', 'aurora-veil', 'frost-fractal', 'other',
];

const portfolioStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = file.fieldname === 'watermark'
      ? path.join(config.uploadDir, 'watermarks')
      : path.join(config.uploadDir, 'designs');
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
// Tier-1 funding guard for the upload pipeline (shared by POST
// /artist/portfolio/upload and POST /account/upload).
//
// Owner rule 2026-09-29 (narrowed): ONLY population_admin-flagged accounts
// (the six "super admins with population setup": the head_admin plus Chris,
// Cayli, Aiden, Lesha, and Carina) are NEVER charged review fees and their
// uploads NEVER count against quota. Every other lifetime holder follows
// the normal quota/fee rules.
// The flag check runs FIRST, so the quota increment and fee booking are
// skipped entirely for flagged accounts and nothing about fee bookkeeping
// can ever break their upload. A failure inside the check itself fails
// closed to the normal fee path (never an accidental exemption); a
// fee-booking failure still never breaks the upload.
async function maybeBookReviewFee(userId, designId) {
  let popAdmin = false;
  try {
    popAdmin = await require('../middleware/auth').isPopulationAdmin(userId);
  } catch (e) {
    console.error('population_admin check failed for design', designId, e.message);
  }
  if (popAdmin) return { charged: false, exempt: true, count: 0, note: '' };
  // Every upload counts toward the uploader's monthly free quota
  // (15/Chicago month); over-quota uploads book a $0.40 review fee into
  // the prepaid pool that funds design-triage admin pay. Never touches
  // site overhead or the owner's pocket.
  try {
    const { recordDesignUploadFee, REVIEW_FEE_CENTS } = require('./adminTaskPay');
    const fee = await recordDesignUploadFee(userId, designId);
    if (fee.charged) {
      fee.note = ` That's upload ${fee.count} this month — a $${(REVIEW_FEE_CENTS / 100).toFixed(2)} review fee was applied to your earnings balance (it pays the admin who reviews this piece).`;
    }
    return fee;
  } catch (e) {
    console.error('review fee booking failed for design', designId, e.message);
    return { charged: false, count: 0, note: '', error: true };
  }
}

// Batch upload limits: at most BATCH_MAX_ITEMS designs per submission.
// A single .zip archive may also be attached (fieldname 'zipfile'):
// up to ZIP_MAX_IMAGES images are extracted server-side and each becomes
// a design through the same per-item pipeline.
// Non-zip files keep the 15 MB image cap, enforced manually in the route
// (multer's per-file fileSize limit is the zip-sized cap now).
const BATCH_MAX_ITEMS = 10;
const ZIP_MAX_FILE_MB = 50;
const ZIP_MAX_IMAGES = 20;
const ZIP_MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024; // zip-bomb guard
const ZIP_MAX_ENTRIES = 2000; // entry-count bomb guard
const ZIP_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ZIP_MIMES = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream']);
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;

// Multer for the batch form: files arrive as linework_0..N, color_0..N,
// one shared `watermark` file, plus an optional `zipfile` archive. .any()
// keeps the indexed field names flexible.
const batchUploadMulter = multer({
  storage: portfolioStorage,
  limits: { fileSize: ZIP_MAX_FILE_MB * 1024 * 1024, files: BATCH_MAX_ITEMS * 3 + 2 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'zipfile') {
      if (ZIP_MIMES.has(file.mimetype) || /\.zip$/i.test(file.originalname || '')) return cb(null, true);
      return cb(new Error('The archive must be a .zip file.'));
    }
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, or WebP images are allowed.'));
  },
}).any();

// Zip entry safety: absolute paths, Windows drive letters, and any '..'
// segment are never extracted (we write with path.basename into a fresh
// temp dir anyway, so traversal is structurally impossible — this rejects
// the entry explicitly per policy).
function zipEntryIsDangerous(name) {
  if (!name || name.startsWith('/') || name.startsWith('\\')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(name)) return true;
  return name.split(/[\\/]/).includes('..');
}

function zipMimeForExt(ext) {
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
}

// Default per-image title from the archive entry's filename.
function titleFromFilename(name) {
  const base = path.basename(String(name || ''), path.extname(String(name || '')));
  const clean = base.replace(/[_+.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean || 'Untitled design';
}

// Move a file, tolerating cross-device renames (EXDEV): os.tmpdir() and
// config.uploadDir can live on different mounts (Render: /tmp is the
// container filesystem, UPLOAD_DIR is the persistent disk). renameSync
// throws EXDEV across mounts, so fall back to copy+unlink — an upload must
// never fail with a bare EXDEV.
function moveFileSync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw e;
    }
  }
}

// Zip image role classification: which slot does this archive entry fill?
// - name contains "linework", or a separator-bounded "line" -> linework
//   (separators required so words like "feline" don't false-positive)
// - else name contains separator-bounded "color"/"colour" -> color
// - else -> 'linework' (default: neutral single images keep the historic
//   one-design-per-image behavior)
const ZIP_LINEWORK_RE = /linework|(?:^|[_.\- ])line(?:[_.\- ]|$)/i;
const ZIP_COLOR_RE = /(?:^|[_.\- ])colou?r(?:[_.\- ]|$)/i;
function zipImageRole(originalname) {
  const base = String(originalname || '');
  if (ZIP_LINEWORK_RE.test(base)) return 'linework';
  if (ZIP_COLOR_RE.test(base)) return 'color';
  return 'linework';
}

// Grouping key for pairing _color/_linework versions of the same design:
// strips the extension and any role tokens, normalizes separators.
// Falls back to the full normalized basename when nothing is left.
function designKeyFor(originalname) {
  const noExt = String(originalname || '').replace(/\.[a-z0-9]+$/i, '');
  const stripped = noExt
    .replace(/linework/gi, ' ')
    .replace(/(^|[_.\- ])(line|colou?r)(?=[_.\- ]|$)/gi, '$1')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (stripped) return stripped;
  const fb = noExt.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return fb || 'design';
}

// Pair extracted zip images into designs: files sharing a grouping key are
// merged, the linework-role file filling the linework slot and the
// color-role file the color slot. Groups with no linework file become
// per-item problems (a design requires linework) instead of silently
// mislabeling a color image as linework. Returns
// { pairs: [{ key, title, linework, color }], problems: [{ title, error }] }.
function pairZipImages(files) {
  const groups = new Map();
  const slotFor = (key, role) => {
    let k = key;
    let n = 1;
    while (groups.has(k) && groups.get(k)[role]) { n++; k = `${key}-${n}`; }
    if (!groups.has(k)) groups.set(k, { key: k, linework: null, color: null });
    return groups.get(k);
  };
  for (const f of (files || [])) {
    const key = designKeyFor(f.originalname);
    const g = slotFor(key, zipImageRole(f.originalname));
    if (zipImageRole(f.originalname) === 'color') g.color = f;
    else g.linework = f;
  }
  const pairs = [];
  const problems = [];
  for (const g of groups.values()) {
    const title = (g.key.replace(/-/g, ' ').slice(0, 120) || 'Untitled design');
    if (!g.linework) {
      problems.push({
        title,
        error: `"${title}" needs a linework image — only a color version was found in the zip. Add its linework file and upload again.`,
      });
      continue;
    }
    pairs.push({ key: g.key, title, linework: g.linework, color: g.color || null });
  }
  return { pairs, problems };
}

// Extract accepted images from a zip archive into a fresh temp dir.
// Returns { files: [{ absPath, originalname, mimetype, size }],
//           skipped: { nonImage, appleDouble, macosx, traversal, tooMany },
//           truncated, tmpDir }.
// Throws on unreadable archives, entry-count bombs, and uncompressed
// totals over the zip-bomb cap (the temp dir is removed on throw).
//
// Hardening notes:
// - The temp dir is created inside config.uploadDir (same filesystem as the
//   final designs dir) so the later move never hits EXDEV; os.tmpdir() is
//   only a fallback, and moveFileSync() additionally tolerates EXDEV.
// - The uncompressed-size cap is enforced TWICE: a fast pre-check from the
//   central-directory headers, and a byte counter on the actual decompressed
//   stream (headers can be forged, so the stream cap is the real guard).
// - opts lets tests override caps: { tmpParent, maxImages,
//   maxTotalUncompressed }.
function extractZipImages(zipPath, opts = {}) {
  const maxImages = opts.maxImages || ZIP_MAX_IMAGES;
  const maxTotalUncompressed = opts.maxTotalUncompressed || ZIP_MAX_TOTAL_UNCOMPRESSED;
  return new Promise((resolve, reject) => {
    // decodeStrings:false — yauzl would otherwise fail the WHOLE archive on
    // a single bad filename; we decode manually so traversal entries can be
    // skipped per-entry by zipEntryIsDangerous instead.
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, decodeStrings: false }, (err, zipfile) => {
      if (err || !zipfile) return reject(new Error('That file is not a valid zip archive.'));
      // Same-filesystem temp dir: avoids EXDEV when moving into the designs
      // dir (Render: /tmp vs the persistent disk are different mounts).
      let tmpDir;
      try {
        tmpDir = fs.mkdtempSync(path.join(opts.tmpParent || config.uploadDir, 'tmp-zipbatch-'));
      } catch (e) {
        try { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipbatch-')); }
        catch (e2) { return reject(new Error('Could not prepare the upload. Please try again.')); }
      }
      const files = [];
      const skipped = { nonImage: 0, appleDouble: 0, macosx: 0, traversal: 0, tooMany: 0 };
      let totalUncompressed = 0; // header-based fast pre-check
      let totalStreamed = 0; // actual decompressed bytes — the real bomb guard
      let entryCount = 0;
      let truncated = false;
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch (_) {}
        fs.rmSync(tmpDir, { recursive: true, force: true });
        reject(e);
      };
      zipfile.on('error', fail);
      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ files, skipped, truncated, tmpDir });
      });
      zipfile.on('entry', (entry) => {
        if (settled) return;
        entryCount++;
        if (entryCount > ZIP_MAX_ENTRIES) return fail(new Error('Zip has too many entries.'));
        const rawName = entry.fileName;
        const name = Buffer.isBuffer(rawName) ? rawName.toString('utf8') : String(rawName || '');
        if (/\/$/.test(name)) return zipfile.readEntry(); // directory
        const base = name.split('/').pop();
        if (name.startsWith('__MACOSX/') || name.includes('/__MACOSX/')) { skipped.macosx++; return zipfile.readEntry(); }
        if (base.startsWith('._')) { skipped.appleDouble++; return zipfile.readEntry(); }
        if (zipEntryIsDangerous(name)) { skipped.traversal++; return zipfile.readEntry(); }
        const ext = path.extname(base).toLowerCase();
        if (!ZIP_IMAGE_EXTS.has(ext)) { skipped.nonImage++; return zipfile.readEntry(); }
        totalUncompressed += entry.uncompressedSize || 0;
        if (totalUncompressed > maxTotalUncompressed) {
          return fail(new Error('Zip contents are too large (over 200 MB uncompressed).'));
        }
        if (files.length >= maxImages) { truncated = true; skipped.tooMany++; return zipfile.readEntry(); }
        zipfile.openReadStream(entry, (err2, rs) => {
          if (settled) return;
          if (err2 || !rs) return fail(err2 || new Error('Could not read a zip entry.'));
          const safeBase = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'image';
          const dest = path.join(tmpDir, `${files.length}-${safeBase}`);
          const ws = fs.createWriteStream(dest);
          // Stream byte cap: central-directory sizes can be forged, so count
          // the actual decompressed bytes and abort mid-stream on overflow.
          rs.on('data', (chunk) => {
            if (settled) return;
            totalStreamed += chunk.length;
            if (totalStreamed > maxTotalUncompressed) {
              try { rs.destroy(); } catch (_) {}
              try { ws.destroy(); } catch (_) {}
              fail(new Error('Zip contents are too large (over 200 MB uncompressed).'));
            }
          });
          rs.on('error', fail);
          ws.on('error', fail);
          ws.on('finish', () => {
            if (settled) return;
            files.push({ absPath: dest, originalname: base, mimetype: zipMimeForExt(ext), size: entry.uncompressedSize || 0 });
            zipfile.readEntry();
          });
          rs.pipe(ws);
        });
      });
      zipfile.readEntry();
    });
  });
}

// Core single-design upload, shared by the single-file and batch flows.
// user: the logged-in user object.
// fileSet: { linework, color?, watermark? } — multer file objects.
// fields: { title, style, description, categories, listing_type,
//   watermark_choice, sensitivity, remake }.
// Returns { ok:true, id, title, listingType, finalStatus, selfApproved,
//   holdForHate, screenOk, colorSource, sensitivity, wmNote, reviewFeeNote }
// or { ok:false, error }. Never redirects — callers decide the response.
async function uploadOneDesign(user, fileSet, fields) {
  const files = {
    linework: fileSet.linework ? [fileSet.linework] : null,
    color: fileSet.color ? [fileSet.color] : null,
    watermark: fileSet.watermark ? [fileSet.watermark] : null,
  };
  if (!files.linework) return { ok: false, error: 'A clean linework image is required.' };
  const hasColor = !!(files.color && files.color[0]);
  const colorSource = hasColor ? 'designer' : 'none';
  const title = String(fields.title || '').trim().slice(0, 120);
  if (!title) return { ok: false, error: 'Give your design a title.' };
  const style = String(fields.style || '').trim().toLowerCase();
  if (!DESIGN_STYLES.includes(style)) return { ok: false, error: 'Pick a style for your design.' };
  const description = String(fields.description || '').trim().slice(0, 2000);
  const extraCats = String(fields.categories || '').split(',')
    .map((c) => c.trim().toLowerCase().replace(/[^a-z0-9- ]/g, '').slice(0, 40))
    .filter(Boolean).filter((c) => c !== style).slice(0, 11);
  // Listing type: default CUSTOM (portfolio only, custom-design price).
  // PRE-DESIGN opt-in: also listed on the main gallery at the premade price.
  const listingType = fields.listing_type === 'predesign' ? 'predesign' : 'custom';
  const listingScope = listingType === 'predesign' ? 'gallery' : 'portfolio';
  // Watermark choice: default 'site'. 'custom' uses the uploaded file, or the
  // mark the artist built on-site (dark-on-transparent, rendered inverted so
  // the dark ink shows) when no file was attached.
  const watermarkChoice = fields.watermark_choice === 'custom' ? 'custom' : 'site';
  let customWatermarkPath = '';
  let customWatermarkInvert = false;
  if (watermarkChoice === 'custom') {
    if (files.watermark && files.watermark[0]) {
      customWatermarkPath = path.relative(config.uploadDir, files.watermark[0].path);
    } else {
      const builder = require('./watermarkBuilder');
      if (builder.defaultMarkExists(user.id)) {
        customWatermarkPath = builder.defaultMarkRel(user.id);
        customWatermarkInvert = true;
      } else {
        return { ok: false, error: 'Upload your watermark image, or build a theft-resistant mark on-site first — then pick "my own watermark" with no file needed.' };
      }
    }
  }

  const screen = screenText(`${title}\n${description}`);
  // Content rating (owner policy): nudity allowed; sexual acts / highly
  // offensive content is blurred for the public preview; racist material is
  // held for admin-only review. Artist self-declares; admins can adjust.
  const sensitivity = SENSITIVITIES.includes(String(fields.sensitivity || '').toLowerCase())
    ? String(fields.sensitivity).toLowerCase() : 'normal';
  const holdForHate = String(fields.sensitivity || '').toLowerCase() === 'racist';
  const id = await db.insert('designs', {
    title,
    description,
    style,
    categories: JSON.stringify([style, ...extraCats]),
    color_path: hasColor ? path.relative(config.uploadDir, files.color[0].path) : '',
    color_source: colorSource,
    color_pending: colorSource === 'none' ? 1 : 0,
    linework_path: path.relative(config.uploadDir, files.linework[0].path),
    linework_wm_path: '', // set by the watermark pipeline below
    sensitivity,
    price_cents: listingType === 'custom' ? pricing.customFullCents() : pricing.premadePriceCents(),
    artist_id: user.id,
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
  // Tier-1 funding: the fee guard runs the population_admin exemption
  // first, then quota/fees for everyone else. It never throws, so fee
  // bookkeeping can never break the upload itself.
  let reviewFeeNote = '';
  try {
    const fee = await maybeBookReviewFee(user.id, id);
    if (fee.note) reviewFeeNote = fee.note;
  } catch (e) {
    console.error('review fee hook failed for design', id, e.message);
  }
  // Remake upload: link this new piece to the sold custom piece it replaces.
  // The replacement request closes when the remake is approved.
  if (fields.remake) {
    const { linkRemake } = require('./replacements');
    await linkRemake(String(fields.remake), id, user.id);
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
        ? resolveStoredPath(customWatermarkPath) : null,
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
          watermarkedAbs: resolveStoredPath(wmRel),
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
  // for pre-designs, portfolio for customs). The site owner (head_admin)
  // always skips it too — owner uploads go live immediately. Screening
  // flags are still logged to the review queue for audit, but they don't
  // block posting. Plain admins still go through the normal review queue.
  let finalStatus = holdForHate ? 'on_hold' : (screen.ok ? 'pending' : 'flagged');
  let selfApproved = false;
  try {
    const uploader = await db.get('SELECT auto_approve_uploads FROM users WHERE id = ?', [user.id]);
    if ((uploader && uploader.auto_approve_uploads) || isHeadAdmin(user)) {
      finalStatus = 'approved';
      selfApproved = true;
      await db.update('designs', id, { status: 'approved', approved_by: user.id });
      try { await notifyDesignLive(id, 'self-approved'); } catch (e) { console.error('self-approve live notify failed:', e.message); }
    }
  } catch (e) { console.error('self-approve check failed:', e.message); }
  if (!selfApproved) {
  try {
    const artistName = (user.display_name || user.email || 'A designer');
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
  return {
    ok: true, id, title, listingType, finalStatus, selfApproved,
    holdForHate, screenOk: screen.ok, colorSource, sensitivity, wmNote, reviewFeeNote,
  };
}

// Flash message for a single upload result — the exact wording the
// single-file flow has always shown.
function uploadFlash(r) {
  return (r.selfApproved
    ? 'Art uploaded — it\u2019s live now (you approve your own pieces).'
    : (r.holdForHate
    ? 'Art uploaded and placed on hold — an admin will personally review it and decide.'
    : (r.screenOk
      ? ((r.listingType === 'predesign'
        ? 'Pre-design uploaded — it goes live in the gallery and your portfolio after approval (within 2 hours).'
        : 'Custom portfolio piece uploaded — it goes live in your portfolio after approval (within 2 hours).') +
        (r.colorSource === 'none' ? ' It posts with your linework; we\u2019ll create the color version too.' : '') +
        (r.sensitivity === 'explicit' ? ' Rated explicit — the public preview is blurred.' : ''))
      : 'Art uploaded but flagged for review (possible contact info). An admin will review it.'))) + r.wmNote + r.reviewFeeNote;
}

// Single-file flow: thin wrapper around uploadOneDesign. Redirects back with
// a flash message on validation errors, and to the portfolio on success —
// exactly as before.
async function handlePortfolioUpload(req, res, backUrl) {
  const files = req.files || {};
  const r = await uploadOneDesign(req.user, {
    linework: files.linework && files.linework[0],
    color: files.color && files.color[0],
    watermark: files.watermark && files.watermark[0],
  }, {
    title: req.body.title,
    style: req.body.style,
    description: req.body.description,
    categories: req.body.categories,
    listing_type: req.body.listing_type,
    watermark_choice: req.body.watermark_choice,
    sensitivity: req.body.sensitivity,
    remake: req.body.remake,
  });
  if (!r.ok) {
    req.session.flash = r.error;
    return res.redirect(backUrl);
  }
  req.session.flash = uploadFlash(r);
  res.redirect('/artist/portfolio');
}

module.exports = { DESIGN_STYLES, portfolioUploadMulter, batchUploadMulter, BATCH_MAX_ITEMS, ZIP_MAX_IMAGES, ZIP_MAX_FILE_MB, IMAGE_MAX_BYTES, handlePortfolioUpload, uploadOneDesign, maybeBookReviewFee, extractZipImages, titleFromFilename, moveFileSync, zipImageRole, designKeyFor, pairZipImages };
