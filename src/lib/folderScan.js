// Folder Scan — phone-home scan store (2026-10-26).
//
// The UsefulAppz Folder app (~/workspace/app/usefulappz-folder/,
// com.usefulappz.folder) scans the owner's phone on every open: every
// installed com.usefulappz.* / com.tattooartcustoms.* package with its
// version, plus the core tools NOT installed yet. From vc2/1.1.0 the
// app POSTs that scan here so Aria can reconcile the phone against
// the fleet roster from her side (before this, the scan existed only
// on the phone's screen — the device channel has no installed-apps
// command, so this endpoint IS the window).
//
//   POST /api/folder-scan   the phone's report (no token: the app
//                           carries no secrets; the payload is a
//                           fleet-app inventory, validated field by
//                           field and rebuilt through the whitelist
//                           below before storage, so nothing beyond
//                           device label + package/version rows can
//                           ever reach storage)
//   GET  /api/folder-scan   Muse service-token only: the latest
//                           stored scan per device.
//
// Storage is site_kv (migration 033 — the same key-value store the
// Email Keeper uses for its latest-state blob): one blob per device
// under `folder_scan:<slug>` plus a small `folder_scan_index` of the
// known slugs. Latest-per-device is exactly what the reconciliation
// reads, so no new table is warranted.
const db = require('../db');

const INDEX_KEY = 'folder_scan_index';
const KEY_PREFIX = 'folder_scan:';
const MAX_ENTRIES = 500;
const PKG_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;

function deviceSlug(device) {
  const slug = String(device || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'device';
}

// A scan timestamp: an ISO-8601 string of sane length (the app sends
// UTC ISO with millis). Anything else is a validation failure.
function tsField(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 40) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return undefined;
  return v;
}

function pkgField(v) {
  if (typeof v !== 'string' || v.length < 3 || v.length > 255) return undefined;
  if (!PKG_RE.test(v)) return undefined;
  return v;
}

// Validate a POST body and rebuild it as the exact stored payload.
// Returns { ok: true, payload } or { ok: false, error }. The payload is
// constructed field-by-field from the whitelist — stray keys in the
// body or in any entry never survive this function.
function sanitizeScan(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  if (typeof body.device !== 'string') {
    return { ok: false, error: 'device must be a string' };
  }
  const device = body.device.trim();
  if (device.length === 0 || device.length > 80 || /[\u0000-\u001f\u007f]/.test(device)) {
    return { ok: false, error: 'bad device label' };
  }
  const timestamp = tsField(body.timestamp !== undefined ? body.timestamp : body.scanned_at);
  if (timestamp === undefined) return { ok: false, error: 'bad timestamp' };

  if (!Array.isArray(body.installed) || body.installed.length > MAX_ENTRIES) {
    return { ok: false, error: `installed must be an array of 0..${MAX_ENTRIES} entries` };
  }
  if (!Array.isArray(body.missing) || body.missing.length > MAX_ENTRIES) {
    return { ok: false, error: `missing must be an array of 0..${MAX_ENTRIES} entries` };
  }

  const installed = [];
  const seenInstalled = new Set();
  for (const e of body.installed) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      return { ok: false, error: 'installed entries must be objects' };
    }
    const pkg = pkgField(e.package);
    if (pkg === undefined) return { ok: false, error: 'bad installed package' };
    if (typeof e.versionCode !== 'number' || !Number.isInteger(e.versionCode)
        || e.versionCode < 0 || e.versionCode > 2147483647) {
      return { ok: false, error: 'bad versionCode' };
    }
    if (typeof e.versionName !== 'string' || e.versionName.length > 64
        || /[\u0000-\u001f\u007f]/.test(e.versionName)) {
      return { ok: false, error: 'bad versionName' };
    }
    if (seenInstalled.has(pkg)) return { ok: false, error: 'duplicate installed package' };
    seenInstalled.add(pkg);
    installed.push({ package: pkg, versionCode: e.versionCode, versionName: e.versionName });
  }

  const missing = [];
  const seenMissing = new Set();
  for (const e of body.missing) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      return { ok: false, error: 'missing entries must be objects' };
    }
    const pkg = pkgField(e.package);
    if (pkg === undefined) return { ok: false, error: 'bad missing package' };
    if (seenMissing.has(pkg)) return { ok: false, error: 'duplicate missing package' };
    seenMissing.add(pkg);
    missing.push({ package: pkg });
  }

  return {
    ok: true,
    payload: {
      device,
      slug: deviceSlug(device),
      timestamp,
      received_at: new Date().toISOString(),
      installed,
      missing,
      counts: { installed: installed.length, missing: missing.length },
    },
  };
}

// Re-project a stored blob through the whitelist on the way out too:
// reads stay true to the contract even against a hand-edited kv row.
function projectScan(stored) {
  if (!stored || typeof stored !== 'object') return null;
  if (typeof stored.device !== 'string' || !Array.isArray(stored.installed)
      || !Array.isArray(stored.missing)) return null;
  const installed = [];
  for (const e of stored.installed) {
    if (!e || typeof e.package !== 'string') continue;
    installed.push({
      package: e.package,
      versionCode: Number.isInteger(e.versionCode) ? e.versionCode : null,
      versionName: typeof e.versionName === 'string' ? e.versionName : '',
    });
  }
  const missing = [];
  for (const e of stored.missing) {
    if (!e || typeof e.package !== 'string') continue;
    missing.push({ package: e.package });
  }
  return {
    device: stored.device,
    slug: typeof stored.slug === 'string' ? stored.slug : deviceSlug(stored.device),
    timestamp: typeof stored.timestamp === 'string' ? stored.timestamp : null,
    received_at: typeof stored.received_at === 'string' ? stored.received_at : null,
    installed,
    missing,
    counts: { installed: installed.length, missing: missing.length },
  };
}

async function kvGet(name) {
  try {
    const row = await db.get('SELECT val FROM site_kv WHERE name = ?', [name]);
    return row ? row.val : null;
  } catch { return null; }
}

async function kvSet(name, val) {
  // Raw upsert (the favorites-merge pattern): db.insert() always mints an
  // `id`, and site_kv has no id column — its PRIMARY KEY is `name`.
  await db.query(
    `INSERT INTO site_kv (name, val, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET val = excluded.val, updated_at = excluded.updated_at`,
    [name, val, db.now()]);
}

async function readIndex() {
  const raw = await kvGet(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => typeof s === 'string' && s.length > 0 && s.length <= 60);
  } catch { return []; }
}

// Store a sanitized scan as its device's latest, and register the
// device slug in the index the first time it reports.
async function saveScan(payload) {
  await kvSet(KEY_PREFIX + payload.slug, JSON.stringify(payload));
  const index = await readIndex();
  if (!index.includes(payload.slug)) {
    index.push(payload.slug);
    await kvSet(INDEX_KEY, JSON.stringify(index));
  }
}

// Latest scan per device, newest report first. Empty array before the
// first phone ever reports.
async function getScans() {
  const index = await readIndex();
  const scans = [];
  for (const slug of index) {
    const raw = await kvGet(KEY_PREFIX + slug);
    if (!raw) continue;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const projected = projectScan(parsed);
    if (projected) scans.push(projected);
  }
  scans.sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')));
  return scans;
}

module.exports = { deviceSlug, sanitizeScan, projectScan, saveScan, getScans };
