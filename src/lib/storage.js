// Unified object storage — local disk (default) or Cloudflare R2.
//
// Provider is chosen by STORAGE_PROVIDER: 'local' (default, today's behavior,
// files under ASSET_DIR) or 'r2' (Cloudflare R2 via its S3-compatible API).
// Local mode never touches the network and needs no credentials.
//
// Two R2 buckets (public reads are free on R2, so gallery images cost nothing
// to serve):
//   R2_PUBLIC_BUCKET  — gallery previews, member photos, ad creatives.
//                       Served straight from R2_PUBLIC_URL (public bucket).
//   R2_PRIVATE_BUCKET — color deliverables, clean linework, custom-order
//                       files. Served ONLY via short-lived presigned URLs
//                       minted by authed routes; never directly linkable.
//
// DB conventions in r2 mode:
//   public files  → full https URL (R2_PUBLIC_URL/<key>) — views render as-is
//   private files → 'r2://<bucket>/<key>' (opaque; use servePrivateFile)
//
// Read paths accept ALL THREE forms (local rel path, https URL, r2:// ref)
// regardless of the active provider, so a failed R2 upload that falls back
// to local storage keeps working, and mixed-era rows render fine.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const R2_REF_PREFIX = 'r2://';

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

let warnedMisconfig = false;

function r2Configured() {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_PUBLIC_BUCKET &&
    process.env.R2_PRIVATE_BUCKET &&
    process.env.R2_PUBLIC_URL
  );
}

// 'r2' only when explicitly selected AND fully configured; otherwise 'local'.
// A half-configured r2 request falls back to local with one loud warning.
function provider() {
  if ((process.env.STORAGE_PROVIDER || 'local').toLowerCase() === 'r2') {
    if (r2Configured()) return 'r2';
    if (!warnedMisconfig) {
      warnedMisconfig = true;
      console.error('[storage] STORAGE_PROVIDER=r2 but R2_* env vars are incomplete — falling back to local disk.');
    }
  }
  return 'local';
}

// ---------------------------------------------------------------------------
// Reference classification
// ---------------------------------------------------------------------------

function isHttpUrl(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s);
}

function isR2Ref(s) {
  return typeof s === 'string' && s.startsWith(R2_REF_PREFIX);
}

function parseR2Ref(ref) {
  // 'r2://bucket/key...' → { bucket, key }
  const rest = ref.slice(R2_REF_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return { bucket: rest, key: '' };
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
}

// ---------------------------------------------------------------------------
// R2 client (lazy; only constructed in r2 mode)
// ---------------------------------------------------------------------------

let clientOverride = null; // test injection
function _setClient(c) { clientOverride = c; }
function _resetClient() { clientOverride = null; }

function r2Client() {
  if (clientOverride) return clientOverride;
  // Lazy require so local mode never needs the SDK at runtime.
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

function contentTypeFor(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function publicBaseUrl() {
  return (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// Upload a finished local file to the active provider.
//   absPath   — local file to store (must exist)
//   localRef  — the value to store in the DB when in local mode
//               (i.e. exactly what the caller stored before this module)
//   kind      — key namespace: 'designs' | 'photos' | 'ads' | 'private'
//   filename  — unique object name within the namespace
//   visibility — 'public' (gallery/photos/ads) or 'private' (deliverables)
//
// Returns the value the caller should store in the DB:
//   local → localRef (unchanged behavior)
//   r2    → public https URL (public) or 'r2://bucket/key' (private)
// Never throws: an R2 failure logs loudly, notifies admins, and falls back
// to localRef (today's behavior) so the user's upload still succeeds.
async function storeFile(absPath, { localRef, kind = 'private', filename, visibility = 'private' }) {
  if (provider() !== 'r2') return localRef;
  const key = `${kind}/${filename}`;
  const bucket = visibility === 'public' ? process.env.R2_PUBLIC_BUCKET : process.env.R2_PRIVATE_BUCKET;
  try {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await r2Client().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(absPath),
      ContentType: contentTypeFor(filename),
    }));
    // Best effort: the local copy is redundant once R2 has it (Render's disk
    // is ephemeral anyway). Never let cleanup break the upload.
    fs.unlink(absPath, () => {});
    if (visibility === 'public') return `${publicBaseUrl()}/${key}`;
    return `${R2_REF_PREFIX}${bucket}/${key}`;
  } catch (e) {
    console.error(`[storage] R2 upload failed for ${key}:`, e.message || e);
    try {
      const { notifyAdmins } = require('./notify');
      await notifyAdmins({
        kind: 'storage',
        title: 'R2 upload failed — file kept on local disk',
        body: `storeFile(${key}) failed: ${e.message || e}. The upload was kept locally; it may vanish on the next deploy.`,
      });
    } catch { /* notification must never break uploads */ }
    return localRef;
  }
}

// Delete a stored file, whatever form its DB reference takes:
//   r2://bucket/key → DeleteObject
//   https URL under R2_PUBLIC_URL → DeleteObject from the public bucket
//   local rel path or /img/<kind>/<file> → unlink under ASSET_DIR
// Never throws.
async function removeStored(stored) {
  if (!stored) return;
  try {
    if (isR2Ref(stored)) {
      const { bucket, key } = parseR2Ref(stored);
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await r2Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return;
    }
    if (isHttpUrl(stored) && publicBaseUrl() && stored.startsWith(publicBaseUrl() + '/')) {
      const key = stored.slice(publicBaseUrl().length + 1);
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await r2Client().send(new DeleteObjectCommand({ Bucket: process.env.R2_PUBLIC_BUCKET, Key: key }));
      return;
    }
    // Local: map /img/<kind>/<file> back to its upload dir, else treat as a
    // stored relative path (resolved across uploadDir then assetDir).
    let rel = String(stored);
    const m = rel.match(/^\/img\/(designs|photos|ads)\/(.+)$/);
    if (m) {
      const dirMap = { designs: path.join('designs', 'linework-wm'), photos: 'photos', ads: 'ads' };
      rel = path.join(dirMap[m[1]], path.basename(m[2]));
    }
    const abs = resolveStoredPath(rel);
    if (!abs) return;
    await fs.promises.unlink(abs);
  } catch { /* already gone / not ours */ }
}

// ---------------------------------------------------------------------------
// Stored-path resolution (local mode)
// ---------------------------------------------------------------------------

// Resolve a DB-stored relative file reference to an absolute path.
// Uploads written since the persistent-disk move live under uploadDir;
// older rows and Docker-baked assets live under assetDir. uploadDir is
// checked first so mixed-era rows keep resolving. Traversal outside both
// roots is refused. Returns null when the file isn't under either root.
function resolveStoredPath(rel) {
  if (!rel || typeof rel !== 'string') return null;
  for (const root of [config.uploadDir, config.assetDir]) {
    const rootAbs = path.resolve(root);
    const abs = path.resolve(rootAbs, rel);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) continue; // traversal guard
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    } catch { /* unreadable — try the other root */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Public gallery URL for a designs-table image column (linework_wm_path etc).
// Remote (r2) → the stored https URL as-is; local → today's /img/designs URL.
function designImgUrl(stored) {
  if (!stored) return '';
  if (isHttpUrl(stored)) return stored;
  return `/img/designs/${String(stored).split('/').pop()}`;
}

// Mint a short-lived presigned GET URL for an r2:// private ref.
async function presignGet(stored, { expiresIn = 900, downloadName = null } = {}) {
  const { bucket, key } = parseR2Ref(stored);
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(downloadName ? { ResponseContentDisposition: `attachment; filename="${downloadName}"` } : {}),
  });
  return getSignedUrl(r2Client(), cmd, { expiresIn });
}

// Serve a PRIVATE file (purchase deliverable, custom-order file) through an
// already-authed route. Handles every stored form:
//   local rel path → res.download / res.sendFile from ASSET_DIR
//   r2://bucket/key → 302 to a 15-minute presigned URL (R2 serves the bytes)
//   https URL → 302 straight there (public fallback; shouldn't happen)
async function servePrivateFile(res, stored, { downloadName = null, inline = false } = {}) {
  if (!stored) return res.status(404).send('Not found.');
  try {
    if (isR2Ref(stored)) {
      const name = downloadName || parseR2Ref(stored).key.split('/').pop();
      const url = await presignGet(stored, { downloadName: inline ? null : name });
      return res.redirect(url);
    }
    if (isHttpUrl(stored)) return res.redirect(stored);
    const abs = resolveStoredPath(stored);
    if (!abs) return res.status(404).send('File missing.');
    if (inline) return res.sendFile(abs);
    return res.download(abs, downloadName || path.basename(abs));
  } catch (e) {
    console.error('[storage] servePrivateFile failed:', e.message || e);
    return res.status(502).send('Storage temporarily unavailable.');
  }
}

// ---------------------------------------------------------------------------
// Capacity monitoring
// ---------------------------------------------------------------------------

// Total stored bytes: both R2 buckets in r2 mode; in local mode the upload
// dir plus the baked asset dir (skipping the upload dir when it already
// lives inside the asset dir, i.e. the dev default).
async function usageBytes() {
  if (provider() === 'r2') {
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const client = r2Client();
    let total = 0;
    for (const bucket of [process.env.R2_PUBLIC_BUCKET, process.env.R2_PRIVATE_BUCKET]) {
      let token;
      do {
        const out = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
        for (const o of out.Contents || []) total += o.Size || 0;
        token = out.IsTruncated ? out.NextContinuationToken : null;
      } while (token);
    }
    return total;
  }
  let total = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { total += fs.statSync(p).size; } catch { /* gone */ } }
    }
  };
  try {
    const roots = [config.uploadDir, config.assetDir];
    const seen = new Set();
    for (const root of roots) {
      const abs = path.resolve(root);
      if (seen.has(abs)) continue;
      seen.add(abs);
      // Skip a root nested inside an already-walked root (dev default:
      // uploadDir = <assetDir>/uploads).
      if ([...seen].some((s) => s !== abs && abs.startsWith(s + path.sep))) continue;
      walk(abs);
    }
  } catch { /* no dir yet */ }
  return total;
}

function capacityBytes() {
  const gb = parseFloat(process.env.STORAGE_CAPACITY_GB || '100');
  return Math.max(1, gb) * 1024 * 1024 * 1024;
}

module.exports = {
  provider,
  r2Configured,
  isHttpUrl,
  isR2Ref,
  parseR2Ref,
  designImgUrl,
  resolveStoredPath,
  storeFile,
  removeStored,
  servePrivateFile,
  presignGet,
  usageBytes,
  capacityBytes,
  _setClient,
  _resetClient,
};
