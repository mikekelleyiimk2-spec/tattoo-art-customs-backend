// Email-to-upload ingestion: designers email image batches or zip files to
// the site's inbox (tattoo.art.customs@gmail.com); a local poller downloads
// the attachments and POSTs them here with the sender's address, subject, and
// body text. Designs are attributed to the matching users row and go through
// the exact same per-item validation, result reporting, and approval logic as
// the web batch flow (owner auto-approve applies; population_admin exempt).
//
// Auth: Authorization: Bearer <token>, compared timing-safe against the
// MUSE_SERVICE_TOKEN env var — the same convention as /api/muse/notify.
// The endpoint 404s when the env var is unset, so it is inert by default.
// The token is read live from process.env (not the config snapshot) so tests
// can toggle it. Never log the token.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { isAdminRole } = require('../middleware/auth');
const { designerAccess } = require('../shop/shopDesigner');
const { messageLimiter } = require('../middleware/rateLimit');
const {
  DESIGN_STYLES, IMAGE_MAX_BYTES, ZIP_MAX_FILE_MB, ZIP_MAX_IMAGES,
  uploadOneDesign, extractZipImages, titleFromFilename, moveFileSync, pairZipImages,
} = require('../lib/portfolioUpload');

const router = express.Router();

// Live env read (see header): keeps the endpoint test-toggleable.
function serviceToken() {
  return process.env.MUSE_SERVICE_TOKEN || '';
}

function authorized(req) {
  const expected = serviceToken();
  if (!expected) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = Buffer.from(m[1], 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const ingestMulter = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(config.uploadDir, 'ingest');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return cb(e); }
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 5) || '.bin';
      cb(null, `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: ZIP_MAX_FILE_MB * 1024 * 1024, files: 40 },
  fileFilter: (req, file, cb) => {
    const isZip = /^(application\/(zip|x-zip-compressed|x-zip)|application\/octet-stream)$/.test(file.mimetype)
      || /\.zip$/i.test(file.originalname || '');
    if (isZip) return cb(null, true);
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPG, PNG, WebP images or .zip archives are accepted.'));
  },
}).array('files', 40);

function swallowUnlink(p) { try { if (p) fs.unlinkSync(p); } catch (e) {} }
function swallowRmDir(p) { try { if (p) fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }

// POST /api/ingest/email-upload
// multipart: files[] (images and/or .zip archives — zips are extracted with
// the same guards as the web batch flow), plus fields:
//   sender_email (required) — matched case-insensitively to users.email
//   subject      (optional) — used as the per-image title prefix
//   body_text    (optional) — shared description for each listing
//   style        (optional) — must be a valid style, else 'other'
//   listing_type (optional) — 'custom', else defaults to 'predesign'
// Returns { ok: true, results: [...] } (one entry per image, in order) plus
// notes[] for skipped files/truncation.
router.post('/email-upload', messageLimiter, (req, res, next) => {
  ingestMulter(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: 'bad_upload', message: err.message || 'Invalid upload.' });
    next();
  });
}, async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const senderEmail = String(req.body.sender_email || '').trim().toLowerCase().slice(0, 200);
  if (!senderEmail || !senderEmail.includes('@')) {
    return res.status(422).json({ ok: false, error: 'bad_sender', message: 'sender_email is required.' });
  }
  let user = null;
  try {
    user = await db.get('SELECT * FROM users WHERE lower(email) = ?', [senderEmail]);
  } catch (e) { user = null; }
  if (!user) {
    return res.status(422).json({
      ok: false,
      error: 'unknown_sender',
      message: `No Tattoo Art Customs account uses ${senderEmail}. Sign up on the site with that email address, then email the designs again.`,
    });
  }
  let canUpload = false;
  try { canUpload = isAdminRole(user.role) || await designerAccess(user.id); } catch (e) { canUpload = false; }
  if (!canUpload) {
    return res.status(422).json({
      ok: false,
      error: 'no_upload_rights',
      message: 'That account cannot upload designs yet — an active Design Artist membership (included automatically with every tattoo shop subscription) is required.',
    });
  }

  const subjectPrefix = String(req.body.subject || '').trim().slice(0, 80);
  const description = String(req.body.body_text || '').trim().slice(0, 2000);
  const styleRaw = String(req.body.style || '').toLowerCase();
  const style = DESIGN_STYLES.includes(styleRaw) ? styleRaw : 'other';
  const listingType = req.body.listing_type === 'custom' ? 'custom' : 'predesign';

  const designsDir = path.join(config.uploadDir, 'designs');
  try { fs.mkdirSync(designsDir, { recursive: true }); } catch (e) {}

  // Collect the linework items: direct images plus images extracted from zips
  // (same guards as the web batch flow — traversal rejected, 20-image cap,
  // 200 MB uncompressed cap). Zip images are paired into designs: matching
  // _color/_linework files become one design (color attached); a lone color
  // file without linework is reported, never mislabeled. Extracted files are
  // moved into the designs dir with moveFileSync (EXDEV-safe); nothing is
  // ever written outside config.uploadDir.
  const items = []; // { file, colorFile, title } or { skip: true, title, reason }
  const notes = [];
  const tmpDirs = [];
  try {
    for (const f of (req.files || [])) {
      if (/\.zip$/i.test(f.originalname || '')) {
        let extraction;
        try {
          extraction = await extractZipImages(f.path);
        } catch (e) {
          items.push({ skip: true, title: f.originalname || 'archive', reason: e.message || 'Could not read the zip file.' });
          swallowUnlink(f.path);
          continue;
        }
        swallowUnlink(f.path);
        tmpDirs.push(extraction.tmpDir);
        const { pairs, problems } = pairZipImages(extraction.files);
        for (const p of problems) {
          items.push({ skip: true, title: p.title, reason: p.error });
        }
        let n = 0;
        const moveOne = (img, slot) => {
          const ext = path.extname(img.originalname).toLowerCase().slice(0, 5) || '.png';
          const stored = path.join(
            designsDir,
            `${user.id}-${Date.now()}-ingest-${n}-${slot}-${Math.random().toString(36).slice(2, 8)}${ext}`
          );
          moveFileSync(img.absPath, stored);
          return { path: stored, originalname: img.originalname, mimetype: img.mimetype, fieldname: slot };
        };
        for (const pair of pairs) {
          n++;
          let lwFile = null;
          let colorFile = null;
          try {
            lwFile = moveOne(pair.linework, 'linework');
            if (pair.color) colorFile = moveOne(pair.color, 'color');
          } catch (e) {
            items.push({ skip: true, title: pair.title, reason: 'Could not store the file.' });
            continue;
          }
          const title = subjectPrefix ? `${subjectPrefix} — ${pair.title}`.slice(0, 120) : pair.title;
          items.push({ file: lwFile, colorFile, title });
        }
        if (extraction.truncated) {
          notes.push(`Only the first ${ZIP_MAX_IMAGES} images in ${f.originalname} were used.`);
        }
        continue;
      }
      if (f.size > IMAGE_MAX_BYTES) {
        items.push({ skip: true, title: f.originalname || 'image', reason: 'File is over 15 MB — please send a smaller copy.' });
        swallowUnlink(f.path);
        continue;
      }
      // Move direct images into the designs dir alongside web-uploaded originals.
      const ext = path.extname(f.originalname || '').toLowerCase().slice(0, 5) || '.png';
      const stored = path.join(
        designsDir,
        `${user.id}-${Date.now()}-ingest-${Math.random().toString(36).slice(2, 8)}${ext}`
      );
      try { moveFileSync(f.path, stored); }
      catch (e) { items.push({ skip: true, title: f.originalname || 'image', reason: 'Could not store the file.' }); continue; }
      items.push({
        file: { path: stored, originalname: f.originalname || 'image', mimetype: f.mimetype, fieldname: 'linework' },
        title: titleFromFilename(f.originalname || 'image'),
      });
    }

    if (!items.length && !notes.length) {
      return res.status(422).json({ ok: false, error: 'no_images', message: 'No usable images were found — attach .png, .jpg, .jpeg, or .webp images (or a .zip of them).' });
    }

    const results = [];
    for (const it of items) {
      if (it.skip) { results.push({ ok: false, title: it.title, error: it.reason }); continue; }
      const title = subjectPrefix ? `${subjectPrefix} — ${it.title}`.slice(0, 120) : it.title;
      try {
        const r = await uploadOneDesign(user, { linework: it.file, color: it.colorFile || null, watermark: null }, {
          title,
          style,
          description,
          categories: '',
          listing_type: listingType,
          watermark_choice: 'site',
          sensitivity: 'normal',
          remake: '',
        });
        if (r.ok) {
          results.push({
            ok: true, id: r.id, title: r.title || title,
            status: r.finalStatus, selfApproved: !!r.selfApproved, listingType: r.listingType,
          });
        } else {
          results.push({ ok: false, title, error: r.error });
        }
      } catch (e) {
        results.push({ ok: false, title, error: 'Upload failed — please try again.' });
      }
    }
    return res.json({ ok: true, results, notes, sender: user.email, userId: user.id });
  } catch (e) {
    console.error('email-upload handler failed:', e);
    return res.status(500).json({ ok: false, error: 'ingest_failed', message: 'Something went wrong processing that upload — please try again.' });
  } finally {
    for (const d of tmpDirs) swallowRmDir(d);
  }
});

module.exports = router;
