// App auto-update service for the Android clients.
//
//   GET /api/apps/:package/update — latest-release metadata as JSON
//   GET /api/apps/:package/apk    — the stored APK itself
//
// The registry is a tiny JSON file (src/data/app-updates.json, overridable
// with the APP_UPDATES_REGISTRY env var — an absolute path, used by tests)
// keyed by package name. Each entry:
//   { versionCode, versionName, notes, sha256, sizeBytes, publishedAt,
//     apkFile?: "<package>.apk", gated?: true,
//     storageRef?: "r2://<bucket>/<key>" — externally stored build for
//     APKs too big for the Render disk; served via presigned redirect
//     after the gate, see the /apk handler }
// It is read on every request so a new release is just a registry edit plus
// an APK upload (POST /api/muse/upload-sideload accepts any
// com.usefulappz.* package and stores its APK under app-updates/).
//
// APK filename: the upload route stores every auto-update APK at
// <uploadDir>/app-updates/<package>.apk, so when an entry omits apkFile the
// file name defaults to "<package>.apk" — the registry producers emit
// apkUrl, not apkFile (live defect 2026-10-14: requiring apkFile 404'd
// EVERY package, free included, while /update worked fine).
// resolveStoredPath() resolves app-updates/<file> against uploadDir first,
// which is exactly where the upload route writes (config.uploadDir).
//
// PAID GATE (owner ruling 2026-10-14): entries with "gated": true never
// serve APK bytes without a valid purchase token (see lib/updateTokens):
// header "x-update-token" or ?t=, HMAC-verified, then DB-checked against a
// paid orders row with order_type === "sideload:" + package. Free entries
// stay public; /update stays public for all (gated entries add gated:true).
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const { resolveStoredPath, servePrivateFile } = require('../lib/storage');
const updateTokens = require('../lib/updateTokens');
const seatVerify = require('../lib/seatVerify');

const router = express.Router();

const PACKAGE_RE = /^[a-zA-Z0-9._-]+$/;
// apkFile must be a bare filename: no separators, no traversal segments.
const APK_FILE_RE = /^[a-zA-Z0-9._-]+$/;

function registryPath() {
  return process.env.APP_UPDATES_REGISTRY
    || path.join(__dirname, '..', 'data', 'app-updates.json');
}

function loadRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (e) { /* missing/corrupt registry reads as empty */ }
  return {};
}

// Returns the registry entry for a package, or null when the package param
// is malformed or the package is not in the registry.
function entryFor(pkg) {
  if (!PACKAGE_RE.test(String(pkg || ''))) return null;
  const entry = loadRegistry()[pkg];
  if (!entry || typeof entry !== 'object') return null;
  return entry;
}

function unknownPackage(res) {
  return res.status(404).json({ ok: false, error: 'unknown package' });
}

router.get('/apps/:package/update', (req, res) => {
  const entry = entryFor(req.params.package);
  if (!entry) return unknownPackage(res);
  const pkg = req.params.package;
  return res.json({
    ok: true,
    package: pkg,
    versionCode: entry.versionCode,
    versionName: entry.versionName,
    apkUrl: `${config.baseUrl}/api/apps/${pkg}/apk`,
    notes: entry.notes,
    sha256: entry.sha256,
    sizeBytes: entry.sizeBytes,
    publishedAt: entry.publishedAt,
    ...(entry.gated ? { gated: true } : {}),
  });
});

function purchaseTokenRequired(res) {
  return res.status(401).json({ ok: false, error: 'purchase token required' });
}

// The gated download verifies at EVERY attempt (HMAC + live order
// re-check in the handler below) — and a refused attempt is
// behavior, so it lands in the verify watch (cadence pass
// 2026-11-01): a forged token, a token replayed after its order was
// refunded, a token minted for another package — each is rejected
// at the moment of the attempt AND recorded.
router.get('/apps/:package/apk', async (req, res) => {
  const entry = entryFor(req.params.package);
  if (!entry) return unknownPackage(res);
  const pkg = req.params.package;
  if (entry.gated) {
    const token = req.get('x-update-token') || req.query.t;
    const orderId = updateTokens.verify(token, pkg);
    if (!orderId) {
      await seatVerify.logEvent({
        kind: 'download_gate_rejected', detail: `${pkg}:bad_token`, surface: 'app-updates', req,
      });
      return purchaseTokenRequired(res);
    }
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order || order.status !== 'paid' || order.order_type !== `sideload:${pkg}`) {
      const reason = !order ? 'order_gone'
        : order.status !== 'paid' ? `order_${order.status}`
        : 'order_type_mismatch';
      await seatVerify.logEvent({
        kind: 'download_gate_rejected', detail: `${pkg}:${reason}`, surface: 'app-updates',
        userId: order && order.buyer_id ? order.buyer_id : null, req,
      });
      return purchaseTokenRequired(res);
    }
  }
  // Default to the exact filename the upload route writes
  // (app-updates/<package>.apk) when the entry carries no apkFile.
  const apkFile = String(entry.apkFile || `${pkg}.apk`);
  if (!APK_FILE_RE.test(apkFile) || apkFile === '.' || apkFile === '..'
      || path.basename(apkFile) !== apkFile) {
    return res.status(404).json({ ok: false, error: 'apk not found' });
  }
  // Externally stored build (2026-11-01): an entry may carry a
  // `storageRef` (an r2:// ref into the private bucket) for builds too
  // big for the 1 GB Render disk — the ~394 MB Brambleforce APK can
  // never sit in uploadDir. The purchase gate above has already passed
  // at this point; servePrivateFile 302s to a short-lived presigned
  // URL, so the bytes stream from R2, never through this service's
  // disk. Local-file entries (no storageRef) are unchanged.
  if (entry.storageRef) {
    return servePrivateFile(res, String(entry.storageRef), { downloadName: apkFile });
  }
  const absPath = resolveStoredPath(path.join('app-updates', apkFile));
  if (!absPath) {
    return res.status(404).json({ ok: false, error: 'apk not found' });
  }
  res.set('Content-Type', 'application/vnd.android.package-archive');
  res.set('Content-Length', String(fs.statSync(absPath).size));
  return fs.createReadStream(absPath).pipe(res);
});

module.exports = router;
