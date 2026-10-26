// Sideload download availability for the UsefulAppz native apps.
//
// Owner order 2026-10-14: until the apps are live on Google Play, every
// advertisement points at the sideload (installable now). The canonical
// download URL is the app-updates store route, /api/apps/:package/apk
// (see routes/appUpdates.js). That route serves a package only when BOTH
// the registry (src/data/app-updates.json) has an entry AND the APK file
// sits in the store (uploadDir/app-updates/<apkFile>).
//
// Advertising surfaces (the /apps page, house ads) gate their download
// CTAs on available() below, which mirrors that exact pair of checks —
// so a CTA renders the moment a build is published, and no surface ever
// links to a download that 404s.
const fs = require('fs');
const path = require('path');
const { resolveStoredPath } = require('./storage');

// Package -> store price (null = free). Prices per the current models:
// Odometer $1.99 (+ $1.99/mo automation on Play), OneMind Team $9.99/mo
// subscription (settled Oct 26 — no one-time $9.99 price exists),
// per-AI Buttons + bars $0.99, kids apps free (ads + subs/IAP in-app).
const APPS = {
  'com.usefulappz.aibar': { price: '$9.99/mo' },
  'com.usefulappz.odometer': { price: '$1.99' },
  'com.usefulappz.musebar': { price: '$0.99' },
  'com.usefulappz.chatgptbar': { price: '$0.99' },
  'com.usefulappz.claudebar': { price: '$0.99' },
  'com.usefulappz.geminibar': { price: '$0.99' },
  'com.usefulappz.copilotbar': { price: '$0.99' },
  'com.usefulappz.perplexitybar': { price: '$0.99' },
  'com.usefulappz.grokbar': { price: '$0.99' },
  'com.usefulappz.deepseekbar': { price: '$0.99' },
  'com.usefulappz.clipboardbar': { price: '$0.99' },
  'com.usefulappz.countdownbar': { price: '$0.99' },
  'com.usefulappz.screenqr': { price: null },
  'com.usefulappz.littleinkerscoloring': { price: null },
  'com.usefulappz.stickerworld': { price: null },
  'com.usefulappz.drawwithme': { price: null },
  'com.usefulappz.coloringcontests': { price: null },
};

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

// True only when /api/apps/:pkg/apk would serve a file right now:
// registry entry present AND its APK file resolves in the store.
function available(pkg) {
  if (!APPS[pkg]) return false;
  const entry = loadRegistry()[pkg];
  if (!entry || typeof entry !== 'object') return false;
  const apkFile = String(entry.apkFile || `${pkg}.apk`);
  if (path.basename(apkFile) !== apkFile) return false;
  try {
    return !!resolveStoredPath(path.join('app-updates', apkFile));
  } catch (e) {
    return false;
  }
}

function url(pkg) {
  return `/api/apps/${pkg}/apk`;
}

function availabilityMap() {
  const map = {};
  for (const pkg of Object.keys(APPS)) map[pkg] = available(pkg);
  return map;
}

module.exports = { APPS, available, url, availabilityMap };
