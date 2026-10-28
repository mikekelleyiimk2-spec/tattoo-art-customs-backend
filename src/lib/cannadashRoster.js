// HerbHaul — founding driver roster (counts only, never identities).
//
// WHAT THIS IS: the aggregate picture of the founding DRIVER list
// (cannadash_waitlist rows with role = 'drive', migration 114) behind
// GET /admin/cannadash-drivers (+ its .json export). Dispensary-facing
// reporting needs to know WHERE founding drivers are and HOW MANY —
// it never needs a name or an email, so this module's outputs carry
// counts and cities only. Emails are read for exactly one purpose:
// counting how many waitlist drivers are already recorded as app
// holders (added to / invited from the HerbHaul Driver tester list).
// They are never returned, logged, or rendered.
//
// THE APP LINK: the founding driver build ships through the house
// app-updates store like every other sideload (registry
// src/data/app-updates.json + GET /api/apps/:package/apk, see
// routes/appUpdates.js). The BYTES live in the CANONICAL host's store
// (tattoo-art-customs.onrender.com): the upload door
// (POST /api/muse/upload-sideload) needs MUSE_SERVICE_TOKEN, which is
// seated on the canonical host only — the onemind service 404s the
// whole /api/muse lane (found Oct 28, 2026, same per-service env-gap
// class as the earlier Gemini key). So DRIVER_APK_URL is the absolute
// canonical-host URL, and driverApkReady() gates on the committed
// registry entry — the durable half of the pair; the store upload is
// part of the release procedure and is live-verified after every
// deploy. When the token is seated on the onemind service, the file
// can be uploaded there too and this URL can come home.
const fs = require('fs');
const path = require('path');
const db = require('../db');

const DRIVER_PACKAGE = 'com.usefulappz.cannadashdriver';
const DRIVER_APK_URL = 'https://tattoo-art-customs.onrender.com/api/apps/com.usefulappz.cannadashdriver/apk';

// --- area parsing -------------------------------------------------------
// cannadash_waitlist.area is free text ("Lafayette, LA"). The roster
// groups on a parsed { city, state }:
//   - state = text after the LAST comma, trimmed; uppercased when it
//     is exactly 2 letters ("la" -> "LA"), otherwise title-cased
//     ("texas" -> "Texas");
//   - city = text before the last comma, trimmed, kept as written;
//   - no comma -> the whole text is the city, state is 'Unknown';
//   - empty / missing pieces read as 'Unknown' — never a blank bucket.
function titleCase(s) {
  return s.split(/\s+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function parseArea(area) {
  const raw = String(area == null ? '' : area).trim();
  if (!raw) return { city: 'Unknown', state: 'Unknown' };
  const idx = raw.lastIndexOf(',');
  if (idx < 0) return { city: raw, state: 'Unknown' };
  const city = raw.slice(0, idx).trim() || 'Unknown';
  const stateRaw = raw.slice(idx + 1).trim();
  if (!stateRaw) return { city, state: 'Unknown' };
  const state = stateRaw.length === 2 ? stateRaw.toUpperCase() : titleCase(stateRaw);
  return { city, state };
}

// --- the summary (PURE) -------------------------------------------------
// rows: drive-role waitlist rows ({ area, email, ... } — extra fields
// are ignored and never copied out). appHolderEmails: array or Set of
// lowercased emails recorded as tester-list-added/invited. Returns
// counts only: { total, withApp, byState, byCity }, both groupings
// sorted by count descending (name ascending breaks ties so the
// output is deterministic).
function summarize(rows, appHolderEmails) {
  const list = Array.isArray(rows) ? rows : [];
  const holders = new Set(
    (appHolderEmails instanceof Set ? [...appHolderEmails]
      : Array.isArray(appHolderEmails) ? appHolderEmails : [])
      .map((e) => String(e || '').trim().toLowerCase()).filter(Boolean));
  let withApp = 0;
  const stateCounts = new Map();
  const cityCounts = new Map();
  for (const row of list) {
    const email = String((row && row.email) || '').trim().toLowerCase();
    if (email && holders.has(email)) withApp += 1;
    const { city, state } = parseArea(row && row.area);
    stateCounts.set(state, (stateCounts.get(state) || 0) + 1);
    const key = `${city}\u0000${state}`;
    const cur = cityCounts.get(key) || { city, state, count: 0 };
    cur.count += 1;
    cityCounts.set(key, cur);
  }
  const byState = [...stateCounts.entries()]
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state));
  const byCity = [...cityCounts.values()]
    .sort((a, b) => b.count - a.count
      || a.city.localeCompare(b.city) || a.state.localeCompare(b.state));
  return { total: list.length, withApp, byState, byCity };
}

// The live roster: drive-role rows only. Email is selected ONLY so
// summarize() can count withApp — it never leaves this module.
async function roster(appHolderEmails) {
  const rows = await db.all(
    "SELECT area, email FROM cannadash_waitlist WHERE role = 'drive'");
  return summarize(rows, appHolderEmails);
}

// --- driver APK availability ---------------------------------------------
// Same registry discipline as routes/appUpdates.js: the JSON file at
// src/data/app-updates.json, overridable with APP_UPDATES_REGISTRY,
// read fresh on every call.
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

function driverRegistryEntry() {
  const entry = loadRegistry()[DRIVER_PACKAGE];
  if (!entry || typeof entry !== 'object') return null;
  return entry;
}

// True only when /api/apps/com.usefulappz.cannadashdriver/apk would
// serve a file right now: registry entry present AND its APK file
// resolves in the app-updates store.
function driverApkReady() {
  // Registry-entry gate (see THE APP LINK above): the entry is the
  // committed half of the release; the bytes sit in the canonical
  // host's store, which sibling services cannot stat from here.
  const entry = driverRegistryEntry();
  if (!entry) return false;
  if (entry.apkFile !== undefined && path.basename(String(entry.apkFile)) !== String(entry.apkFile)) return false;
  return true;
}

module.exports = {
  DRIVER_PACKAGE,
  DRIVER_APK_URL,
  parseArea,
  summarize,
  roster,
  driverApkReady,
  driverRegistryEntry,
  loadRegistry,
};
