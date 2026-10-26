// Tester Hub pool machine (owner ruling 2026-10-26).
//
// Tester Hub is NOT test-for-test trading. It fixes the 12-tester
// problem for EVERY developer with ONE standing pool:
//   - A person signs up ONCE with the Gmail they use for apps.
//     Sign-up IS the opt-in: the Hub holds that Gmail and routes it
//     into the tester lists of apps in the Hub (the roster leaves only
//     through the service-token-guarded GET /api/testers/pool).
//   - A developer adds an app once; the pool that already exists is
//     its tester list — 12+ people already opted in, in one go. The
//     app row records pool_snapshot: how many testers it instantly
//     had at the moment it was added.
//   - Leaving is one call (POST /api/testers/leave): status flips to
//     'left', the member is out of the count, the roster, everything.
//     No dark patterns — the record stays only so a re-join is clean.
//
// HONEST LIMIT (Google's rule, unchanged by this machine): Google
// counts a tester toward an app's 12 only when that person taps the
// app's own Play opt-in link. The pool is pre-agreed humans + the
// roster routed to developers + every app's opt-in link in one feed,
// so the taps happen in one go. Nothing here fakes an opt-in.
//
// Tables: tester_signups (migration 102, + status in 104) is the pool;
// tester_hub_apps (migration 104) is the app feed. The fleet's own 21
// apps seed the feed (source 'fleet'); our console shared "Tester
// list" attach stays the fleet mechanism — the pool feeds it, and the
// shared-list export IS GET /api/testers/pool.
const db = require('../db');

// The pool is a Gmail pool: members test Android apps, so the address
// that counts is the Google account address. gmail.com and its
// googlemail.com alias are the only shapes that can ever be routed
// onto a Play tester list.
const GMAIL_RE = /^[a-z0-9._%+-]+@(gmail\.com|googlemail\.com)$/;
const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i;
const SIGNUP_SOURCES = new Set(['hub-app', 'web', 'fleet']);

function normalizeGmail(v) {
  return String(v || '').trim().toLowerCase().slice(0, 120);
}
function isGmail(v) {
  return GMAIL_RE.test(v);
}

// The fleet's 21 apps, seeded into the feed on first use. Opt-in URLs
// are the real Play testing links from the Tester Hub app / console
// records; OneMind's track is not live yet, so its optin_url is null —
// "Link coming", never a fabricated link.
const PLAY_TESTING = 'https://play.google.com/apps/testing/';
const FLEET_APPS = [
  ['com.tattooartcustoms.app', 'Tattoo Art Customs', 'Tattoo designs, custom work, and the gallery.'],
  ['com.tattooartcustoms.app.pro', 'Tattoo Art Customs Pro', 'The pro edition of Tattoo Art Customs.'],
  ['com.usefulappz.littleinkers', 'Little Inkers', "Coloring and learning fun for kids."],
  ['com.usefulappz.littleinkerscoloring', 'Little Inkers Coloring', 'Coloring pages made for kids.'],
  ['com.usefulappz.stickerworld', 'Sticker World', 'Sticker packs and sticker fun.'],
  ['com.usefulappz.drawwithme', 'Draw With Me', 'Draw along, step by step.'],
  ['com.usefulappz.coloringcontests', 'Coloring Contests', 'Coloring contests and community picks.'],
  ['com.usefulappz.clipboardbar', 'Clipboard Bar', 'A floating clipboard bar, always at hand.'],
  ['com.usefulappz.countdownbar', 'Countdown Bar', 'Countdowns in a handy floating bar.'],
  ['com.usefulappz.musebar', 'Muse Bar', 'A one-tap floating bar for Muse.'],
  ['com.usefulappz.chatgptbar', 'ChatGPT Bar', 'A one-tap floating bar for ChatGPT.'],
  ['com.usefulappz.claudebar', 'Claude Bar', 'A one-tap floating bar for Claude.'],
  ['com.usefulappz.geminibar', 'Gemini Bar', 'A one-tap floating bar for Gemini.'],
  ['com.usefulappz.grokbar', 'Grok Bar', 'A one-tap floating bar for Grok.'],
  ['com.usefulappz.perplexitybar', 'Perplexity Bar', 'A one-tap floating bar for Perplexity.'],
  ['com.usefulappz.copilotbar', 'Copilot Bar', 'A one-tap floating bar for Copilot.'],
  ['com.usefulappz.deepseekbar', 'DeepSeek Bar', 'A one-tap floating bar for DeepSeek.'],
  ['com.usefulappz.aibar', 'OneMind (AI Bar)', 'All your AIs, one team — the master bar.'],
  ['com.usefulappz.screenqr', 'ScreenQR', 'Scan QR codes right off your screen.'],
  ['com.usefulappz.odometer', 'Odometer — Mileage Tracker', 'Simple mileage tracking for drivers.'],
  ['com.usefulappz.habitdot', 'Habit Dot', 'A tiny daily habit tracker — one dot a day.'],
].map(([pkg, name, blurb]) => ({
  app_name: name,
  package: pkg,
  optin_url: pkg === 'com.usefulappz.aibar' ? null : PLAY_TESTING + pkg,
  blurb,
}));

async function poolCount() {
  const row = await db.get(
    "SELECT COUNT(*) AS n FROM tester_signups WHERE status = 'active'");
  return (row && row.n) || 0;
}

// Join the pool (idempotent per Gmail). A repeat join refreshes the
// name/source; a member who left and joins again is reactivated —
// joining is always a fresh, explicit opt-in.
async function joinPool({ name, gmail, source }) {
  const email = normalizeGmail(gmail);
  if (!isGmail(email)) return { ok: false, error: 'a Gmail address is required' };
  const cleanName = String(name || '').trim().slice(0, 80);
  if (!cleanName) return { ok: false, error: 'name is required' };
  const src = SIGNUP_SOURCES.has(source) ? source : 'hub-app';
  const existing = await db.get('SELECT id, status FROM tester_signups WHERE email = ?', [email]);
  if (existing) {
    await db.update('tester_signups', existing.id, {
      name: cleanName, source: src, status: 'active',
    });
    return { ok: true, joined: true, already_member: existing.status === 'active', reactivated: existing.status !== 'active', count: await poolCount() };
  }
  await db.insert('tester_signups', {
    email, name: cleanName, interests: 'everything', credit_ok: 0,
    source: src, status: 'active', invited_at: null,
  });
  return { ok: true, joined: true, already_member: false, reactivated: false, count: await poolCount() };
}

// Leave the pool: status -> 'left'. Out of the count, out of the
// roster, out of every future routing. The row stays so the leave is
// auditable and a later re-join is one clean flip back.
async function leavePool({ gmail }) {
  const email = normalizeGmail(gmail);
  if (!isGmail(email)) return { ok: false, error: 'a Gmail address is required' };
  const existing = await db.get('SELECT id, status FROM tester_signups WHERE email = ?', [email]);
  if (!existing) return { ok: false, notFound: true, error: 'that Gmail is not in the pool' };
  if (existing.status !== 'left') {
    await db.update('tester_signups', existing.id, { status: 'left' });
  }
  return { ok: true, left: true, count: await poolCount() };
}

// The roster for developer tester-list population. SERVICE-TOKEN ONLY
// (the route enforces it): this is the pool's PII and it never leaves
// any other way — no endpoint, log, or page returns these addresses.
async function poolRoster() {
  const rows = await db.all(
    "SELECT name, email FROM tester_signups WHERE status = 'active' ORDER BY created_at ASC");
  return rows.map((r) => ({ name: r.name || '', gmail: r.email }));
}

function publicApp(row) {
  return {
    id: row.id,
    app_name: row.app_name,
    package: row.package || null,
    optin_url: row.optin_url || null,
    blurb: row.blurb || '',
    source: row.source,
    pool_snapshot: row.pool_snapshot || 0,
    created_at: row.created_at,
  };
}

// Seed the fleet's 21 apps once (first feed read or app add). The
// snapshot stamped on each is the pool size at seed time.
let seedPromise = null;
async function ensureFleetSeed() {
  if (!seedPromise) {
    seedPromise = (async () => {
      const row = await db.get('SELECT COUNT(*) AS n FROM tester_hub_apps');
      if (row && row.n > 0) return;
      const snapshot = await poolCount();
      const base = db.now();
      for (let i = 0; i < FLEET_APPS.length; i++) {
        const a = FLEET_APPS[i];
        await db.insert('tester_hub_apps', {
          app_name: a.app_name, package: a.package, optin_url: a.optin_url,
          blurb: a.blurb, developer_gmail: null, pool_snapshot: snapshot,
          source: 'fleet', status: 'active', created_at: base + i,
        });
      }
    })().catch((e) => { seedPromise = null; throw e; });
  }
  return seedPromise;
}

async function listApps() {
  await ensureFleetSeed();
  const rows = await db.all(
    "SELECT * FROM tester_hub_apps WHERE status = 'active' ORDER BY created_at ASC");
  const apps = rows.map(publicApp);
  // Profile Plug (slice 4): each app's card also carries its
  // developer's LIVE plugged links (rendered whole — redirect URL +
  // code + disclosure — per the plug contract). The plug buys
  // presence on the developer's own cards ONLY: this attachment
  // changes no order (rows stay created_at ASC), no pool count,
  // and no app without a profiled developer gains or loses anything
  // (plug_links is simply []). Lazy require: profilePlug loads this
  // module at init for the Gmail helpers, so the reverse edge is
  // resolved at call time, never at load time.
  const { renderableLinksFor } = require('./profilePlug');
  const linksByDev = new Map();
  for (let i = 0; i < rows.length; i++) {
    const dev = rows[i].developer_gmail;
    if (!dev) { apps[i].plug_links = []; continue; }
    if (!linksByDev.has(dev)) linksByDev.set(dev, await renderableLinksFor(dev));
    apps[i].plug_links = linksByDev.get(dev);
  }
  return apps;
}

// A developer adds an app to the Hub. Idempotent per package: a
// repeat add refreshes the listing details but keeps the original
// pool_snapshot — that number is the historical fact of how many
// testers the app instantly had the first time it joined the Hub.
async function addApp({ app_name, package: pkg, optin_url, developer_gmail, blurb }) {
  const name = String(app_name || '').trim().slice(0, 120);
  if (!name) return { ok: false, error: 'app_name is required' };
  const packageId = String(pkg || '').trim().toLowerCase().slice(0, 160);
  if (!PACKAGE_RE.test(packageId)) return { ok: false, error: 'a valid app package id is required' };
  const optin = String(optin_url || '').trim().slice(0, 500);
  let optinUrl;
  try {
    const u = new URL(optin);
    if (u.protocol !== 'https:') throw new Error('https only');
    optinUrl = u.toString();
  } catch (e) {
    return { ok: false, error: 'a valid https opt-in URL is required' };
  }
  const devGmail = normalizeGmail(developer_gmail);
  if (!isGmail(devGmail)) return { ok: false, error: 'a developer Gmail is required' };
  const cleanBlurb = String(blurb || '').trim().slice(0, 280) || null;

  await ensureFleetSeed();
  const existing = await db.get(
    "SELECT * FROM tester_hub_apps WHERE package = ? AND status = 'active'", [packageId]);
  if (existing) {
    await db.update('tester_hub_apps', existing.id, {
      app_name: name, optin_url: optinUrl, blurb: cleanBlurb, developer_gmail: devGmail,
    });
    const row = await db.get('SELECT * FROM tester_hub_apps WHERE id = ?', [existing.id]);
    return { ok: true, added: true, already_listed: true, app: publicApp(row), count: await poolCount() };
  }
  const snapshot = await poolCount();
  const id = await db.insert('tester_hub_apps', {
    app_name: name, package: packageId, optin_url: optinUrl, blurb: cleanBlurb,
    developer_gmail: devGmail, pool_snapshot: snapshot, source: 'hub-app', status: 'active',
  });
  const row = await db.get('SELECT * FROM tester_hub_apps WHERE id = ?', [id]);
  return { ok: true, added: true, already_listed: false, app: publicApp(row), count: snapshot };
}

module.exports = {
  GMAIL_RE, normalizeGmail, isGmail,
  poolCount, joinPool, leavePool, poolRoster,
  listApps, addApp, ensureFleetSeed, FLEET_APPS,
};
