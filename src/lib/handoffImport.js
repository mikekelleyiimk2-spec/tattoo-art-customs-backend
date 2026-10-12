// Cosmos handoff receiver — support lib for the /api/muse/handoff-zips
// routes (see src/routes/muse.js).
//
// CAPACITY DESIGN (the reason this lib exists in this shape):
// The Render persistent disk (tac-uploads, mounted at config.uploadDir)
// is 1 GB total and, as of 2026-10-12, has only ~228 MB free — it cannot
// hold even ONE ~390 MB handoff ZIP, let alone all seven (~2.7 GB).
// So handoff ZIPs NEVER touch the persistent disk:
//
//   1. RECEIVE — the ZIP streams to the container's ephemeral tmp
//      filesystem (stage dir: os.tmpdir()/tac-handoff-stage), which is
//      backed by the host volume (~311 GB) on Render. One ZIP at a time,
//      process-and-delete, so peak tmp usage stays ~1 ZIP + its extracted
//      images.
//   2. IMPORT — extracted pairs are fed through the SAME population path
//      the email ingest pipe uses (extractZipImages -> pairZipImages ->
//      uploadOneDesign with the canonical validation / screening /
//      watermark / fee-hook rules, quiet mode so 2,609 designs don't fire
//      2,609 notification emails).
//   3. RELOCATE — when R2 is configured (the production gallery storage:
//      originals live in the private bucket as r2:// refs, watermarked
//      previews in the public bucket under designs/<file> — exactly how
//      the previous population imports stored them), each imported
//      design's files are PutObject'd to R2 and the local copies are
//      deleted per design, so the persistent disk never accumulates the
//      batch. Peak persistent-disk usage during an import is ONE pair.
//      If R2 is NOT configured, the import fails closed when the batch
//      would not fit the persistent disk with headroom to spare, instead
//      of filling the disk mid-import.
//   4. The staged ZIP is deleted after a successful import (the manifest
//      entry stays, marked imported, as the receipt).
//
// The stage dir is ephemeral: a container restart loses staged-but-not-
// imported ZIPs AND the manifest together, which is consistent — the
// sender re-sends anything the status endpoint no longer lists.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const storage = require('./storage');
const {
  extractZipImages,
  pairZipImages,
  uploadOneDesign,
  moveFileSync,
  DESIGN_STYLES,
} = require('./portfolioUpload');

const HANDOFF_MAX_ZIP_BYTES = 512 * 1024 * 1024; // per-ZIP cap (~390 MB expected)
const HANDOFF_MAX_IMAGES = 6000;                  // one ZIP ≈ 373 pairs ≈ 746 files
const HANDOFF_MAX_UNCOMPRESSED = 3 * 1024 * 1024 * 1024;
const LOCAL_HEADROOM_BYTES = 64 * 1024 * 1024;    // fail-closed reserve in local mode

function stageDir() {
  const d = path.join(os.tmpdir(), 'tac-handoff-stage');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function manifestPath() { return path.join(stageDir(), 'handoff-manifest.json'); }

function readManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    if (m && typeof m === 'object' && m.zips && typeof m.zips === 'object') return m;
  } catch { /* missing/corrupt → start fresh */ }
  return { zips: {} };
}

function writeManifest(m) {
  const tmp = `${manifestPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, manifestPath());
}

function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(abs);
    rs.on('data', (c) => h.update(c));
    rs.on('end', () => resolve(h.digest('hex')));
    rs.on('error', reject);
  });
}

// Only simple, flat .zip names are accepted anywhere in this module —
// no directories, no traversal, nothing else to smuggle a path through.
function sanitizeZipName(name) {
  const base = path.basename(String(name || ''));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/i.test(base)) return null;
  if (base.startsWith('stg-')) return null; // multer staging prefix, never a final name
  return base;
}

function zipAbs(name) {
  const n = sanitizeZipName(name);
  if (!n) return null;
  const abs = path.join(stageDir(), n);
  return abs.startsWith(stageDir() + path.sep) ? abs : null;
}

// List what has arrived: manifest entries merged with any on-disk ZIPs
// the manifest doesn't know about (their sha256 is computed once and
// persisted into the manifest so status checks stay cheap).
async function listHandoffs() {
  const dir = stageDir();
  const manifest = readManifest();
  let changed = false;
  const onDisk = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!/\.zip$/i.test(f) || f.startsWith('stg-')) continue;
    if (!sanitizeZipName(f)) continue;
    onDisk.add(f);
    if (!manifest.zips[f]) {
      const abs = path.join(dir, f);
      const st = fs.statSync(abs);
      manifest.zips[f] = {
        name: f,
        bytes: st.size,
        sha256: await sha256File(abs),
        received_at: Math.round(st.mtimeMs),
        status: 'received',
      };
      changed = true;
    }
  }
  if (changed) { try { writeManifest(manifest); } catch { /* listing still works */ } }
  const zips = Object.values(manifest.zips)
    .map((z) => ({ ...z, on_disk: onDisk.has(z.name) }))
    .sort((a, b) => (a.received_at || 0) - (b.received_at || 0));
  let freeBytes = null, totalBytes = null;
  try {
    const s = fs.statfsSync(dir);
    freeBytes = s.bavail * s.bsize;
    totalBytes = s.blocks * s.bsize;
  } catch { /* statfs unavailable — report nulls */ }
  return { stage: { area: 'ephemeral-tmp', freeBytes, totalBytes }, zips };
}

function recordArrival(name, bytes, sha256) {
  const manifest = readManifest();
  manifest.zips[name] = {
    name, bytes, sha256, received_at: Date.now(), status: 'received',
  };
  writeManifest(manifest);
}

function markImported(name, report) {
  const manifest = readManifest();
  const entry = manifest.zips[name];
  if (entry) {
    entry.status = 'imported';
    entry.imported_at = Date.now();
    entry.import = {
      attributed_to: report.attributed_to,
      pairs: report.pairs,
      imported: report.imported.length,
      failed: report.failed.length,
      problems: report.problems.length,
      relocated_files: report.relocatedFiles,
      local_kept_files: report.localKeptFiles,
      imported_ids: report.imported.map((d) => d.id),
    };
    delete entry.last_import_error;
    writeManifest(manifest);
  }
  const abs = zipAbs(name);
  if (abs) { try { fs.unlinkSync(abs); } catch { /* already gone */ } }
}

function markImportError(name, message) {
  const manifest = readManifest();
  const entry = manifest.zips[name];
  if (entry) {
    entry.last_import_error = String(message || 'import failed').slice(0, 300);
    entry.last_import_error_at = Date.now();
    writeManifest(manifest);
  }
}

function deleteHandoff(name) {
  const abs = zipAbs(name);
  let removedFile = false;
  if (abs && fs.existsSync(abs)) { try { fs.unlinkSync(abs); removedFile = true; } catch { /* ignore */ } }
  const manifest = readManifest();
  const hadEntry = Boolean(manifest.zips[name]);
  if (hadEntry) { delete manifest.zips[name]; writeManifest(manifest); }
  return removedFile || hadEntry;
}

// Mirrors the content-type map in lib/storage.js (not exported there).
function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.svg': return 'image/svg+xml';
    default: return 'image/jpeg';
  }
}

// S3 client for the R2 relocation step. Same construction as the
// publish-lil-bundle route (region 'auto', account endpoint). Tests can
// inject a fake via _setS3Client.
let s3Override = null;
function _setS3Client(c) { s3Override = c; }
function s3Client() {
  if (s3Override) return s3Override;
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

// Move one design's stored files to R2 and rewrite its path columns to
// the stored-value shapes the gallery already understands:
//   linework_wm_path → <R2_PUBLIC_URL>/designs/<basename>   (public bucket)
//   color_path / linework_path → r2://<private bucket>/designs/<basename>
// The public key MUST be designs/<basename>: the /img/designs/:file R2
// fallback redirect targets exactly R2_PUBLIC_URL/designs/<file>.
// Returns { relocated, localKept } file counts. A failed PutObject keeps
// the local file and the DB path untouched (design still serves from the
// local copy) — relocation is an optimization per file, never a
// correctness gate for the import. `dbLike` defaults to the app db; it is
// injectable for tests (the test harness closes its in-process handle
// before the HTTP phase and drives this via its raw sqlite handle).
async function relocateDesignToR2(designId, s3, dbLike = db) {
  const row = await dbLike.get(
    'SELECT color_path, linework_path, linework_wm_path FROM designs WHERE id = ?', [designId]
  );
  if (!row) return { relocated: 0, localKept: 0 };
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const pubBase = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  const privBucket = process.env.R2_PRIVATE_BUCKET;
  const jobs = [
    { col: 'linework_wm_path', bucket: process.env.R2_PUBLIC_BUCKET, ref: (key) => `${pubBase}/${key}` },
    { col: 'color_path', bucket: privBucket, ref: (key) => `r2://${privBucket}/${key}` },
    { col: 'linework_path', bucket: privBucket, ref: (key) => `r2://${privBucket}/${key}` },
  ];
  const updates = {};
  let relocated = 0, localKept = 0;
  for (const job of jobs) {
    const rel = row[job.col];
    if (!rel) continue;
    if (storage.isHttpUrl(rel) || storage.isR2Ref(rel)) continue; // already remote
    const abs = storage.resolveStoredPath(rel);
    if (!abs) { localKept++; continue; }
    const key = `designs/${path.basename(abs)}`;
    try {
      await s3.send(new PutObjectCommand({
        Bucket: job.bucket,
        Key: key,
        Body: fs.createReadStream(abs),
        ContentType: contentTypeFor(abs),
      }));
    } catch (e) {
      console.error(`handoff relocate failed for design ${designId} (${job.col}):`, e.message);
      localKept++;
      continue;
    }
    updates[job.col] = job.ref(key);
    relocated++;
    try { fs.unlinkSync(abs); } catch { /* served from R2 either way */ }
  }
  if (Object.keys(updates).length) await dbLike.update('designs', designId, updates);
  return { relocated, localKept };
}

// Import one staged handoff ZIP into the gallery via the canonical
// population path. Attributed to opts.attributedEmail when given, else
// the head_admin account (whose uploads self-approve — the population
// precedent). Throws (with .code) on zip-level failures; per-pair
// failures land in report.failed / report.problems and never abort the
// batch. The staged ZIP itself is NOT deleted here — the caller marks
// the import (which deletes it) only on success, so a failed import can
// be retried without a re-send.
async function importHandoffZip(name, opts = {}) {
  const abs = zipAbs(name);
  if (!abs || !fs.existsSync(abs)) {
    const e = new Error('handoff zip is not staged (never received, already imported, or lost in a restart)');
    e.code = 'not_found';
    throw e;
  }
  let user = null;
  if (opts.attributedEmail) {
    user = await db.get('SELECT * FROM users WHERE lower(email) = lower(?)', [String(opts.attributedEmail)]);
  }
  if (!user) user = await db.get("SELECT * FROM users WHERE role = 'head_admin' ORDER BY created_at ASC LIMIT 1");
  if (!user && process.env.ADMIN_EMAIL) {
    user = await db.get('SELECT * FROM users WHERE email = ?', [process.env.ADMIN_EMAIL]);
  }
  if (!user) {
    const e = new Error('no attributing user found (no head_admin account exists)');
    e.code = 'no_user';
    throw e;
  }
  const styleRaw = String(opts.style || '').toLowerCase();
  const style = DESIGN_STYLES.includes(styleRaw) ? styleRaw : 'other';

  const extraction = await extractZipImages(abs, {
    tmpParent: stageDir(),
    maxImages: HANDOFF_MAX_IMAGES,
    maxTotalUncompressed: HANDOFF_MAX_UNCOMPRESSED,
  });
  try {
    const { pairs, problems } = pairZipImages(extraction.files);

    // Real extracted bytes (zip headers can lie; stat the files).
    let extractedBytes = 0;
    for (const f of extraction.files) {
      try { extractedBytes += fs.statSync(f.absPath).size; } catch { /* counted below via move */ }
    }

    const useR2 = storage.r2Configured();
    if (!useR2) {
      // Local mode: originals + generated previews would accumulate on
      // the persistent disk. Fail closed BEFORE importing if the batch
      // cannot fit with headroom (×1.3 covers the watermark previews).
      let free = Infinity;
      try {
        const s = fs.statfsSync(config.uploadDir);
        free = s.bavail * s.bsize;
      } catch { /* cannot measure — proceed; per-design flow is unchanged */ }
      if (free - extractedBytes * 1.3 < LOCAL_HEADROOM_BYTES) {
        const e = new Error(
          `insufficient persistent-disk space for a local import: ~${Math.round(extractedBytes * 1.3)} bytes needed, ${free} free, and R2 storage is not configured. ` +
          'Configure the R2_* env vars (the production gallery storage) or free disk space, then retry — the ZIP is still staged.'
        );
        e.code = 'insufficient_storage';
        throw e;
      }
    }

    const designsDir = path.join(config.uploadDir, 'designs');
    fs.mkdirSync(designsDir, { recursive: true });
    const s3 = useR2 ? s3Client() : null;
    const report = {
      attributed_to: user.email,
      style,
      pairs: pairs.length,
      imported: [],
      failed: [],
      problems: problems.map((p) => ({ title: p.title, error: p.error })),
      skipped_entries: extraction.skipped,
      truncated: extraction.truncated,
      relocatedFiles: 0,
      localKeptFiles: 0,
    };

    let n = 0;
    for (const pair of pairs) {
      n++;
      let lwFile = null, colorFile = null;
      try {
        const moveOne = (img, slot) => {
          const ext = (path.extname(img.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 5)) || '.png';
          const stored = path.join(
            designsDir,
            `${user.id}-${Date.now()}-handoff-${n}-${slot}-${crypto.randomBytes(4).toString('hex')}${ext}`
          );
          moveFileSync(img.absPath, stored);
          return { path: stored, originalname: img.originalname, mimetype: img.mimetype, fieldname: slot };
        };
        lwFile = moveOne(pair.linework, 'linework');
        if (pair.color) colorFile = moveOne(pair.color, 'color');
      } catch {
        report.failed.push({ title: pair.title, error: 'could not store the extracted files' });
        continue;
      }

      let r;
      try {
        r = await uploadOneDesign(user, { linework: lwFile, color: colorFile, watermark: null }, {
          title: pair.title,
          style,
          description: String(opts.description || ''),
          categories: String(opts.categories || ''),
          listing_type: 'predesign',
          watermark_choice: 'site',
          sensitivity: 'normal',
          remake: '',
          quiet: true,
        });
      } catch (e) {
        r = { ok: false, error: e.message };
      }
      if (!r.ok) {
        // uploadOneDesign only returns ok:false from pre-insert
        // validation, so the moved files were never consumed — remove
        // them instead of orphaning them on the disk.
        for (const f of [lwFile, colorFile]) {
          if (f) { try { fs.unlinkSync(f.path); } catch { /* ignore */ } }
        }
        report.failed.push({ title: pair.title, error: r.error });
        continue;
      }
      report.imported.push({ id: r.id, title: r.title, status: r.finalStatus });
      if (useR2) {
        const rel = await relocateDesignToR2(r.id, s3);
        report.relocatedFiles += rel.relocated;
        report.localKeptFiles += rel.localKept;
      }
    }
    return report;
  } finally {
    try { fs.rmSync(extraction.tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = {
  HANDOFF_MAX_ZIP_BYTES,
  stageDir,
  sha256File,
  sanitizeZipName,
  zipAbs,
  listHandoffs,
  recordArrival,
  markImported,
  markImportError,
  deleteHandoff,
  importHandoffZip,
  relocateDesignToR2,
  _setS3Client,
};
