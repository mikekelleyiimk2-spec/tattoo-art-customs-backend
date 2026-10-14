// App auto-update service for the Android clients.
//
//   GET /api/apps/:package/update — latest-release metadata as JSON
//   GET /api/apps/:package/apk    — the stored APK itself
//
// The registry is a tiny JSON file (src/data/app-updates.json, overridable
// with the APP_UPDATES_REGISTRY env var — an absolute path, used by tests)
// keyed by package name. Each entry:
//   { versionCode, versionName, notes, sha256, sizeBytes, publishedAt,
//     apkFile: "<package>.apk" }
// It is read on every request so a new release is just a registry edit plus
// an APK upload (POST /api/muse/upload-sideload accepts any
// com.usefulappz.* package and stores its APK under app-updates/).
// APKs live at path.join(config.uploadDir, 'app-updates', entry.apkFile);
// resolveStoredPath() resolves that location relative to the upload dir.
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { resolveStoredPath } = require('../lib/storage');

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
  });
});

router.get('/apps/:package/apk', (req, res) => {
  const entry = entryFor(req.params.package);
  if (!entry) return unknownPackage(res);
  const apkFile = String(entry.apkFile || '');
  if (!APK_FILE_RE.test(apkFile) || apkFile === '.' || apkFile === '..'
      || path.basename(apkFile) !== apkFile) {
    return res.status(404).json({ ok: false, error: 'apk not found' });
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
