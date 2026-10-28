// FillMyList slice 4 — the Profile Plug machine (owner strike
// 2026-10-26 07:07: the Rolodex/Profile Plug numbers are SETTLED).
//
// ONE product, ONE price: a developer's links live in their own
// Rolodex (developer edition) and the Rolodex plugs them into their
// FillMyList developer profile — the FillMyList surface is named the
// "Profile Plug". There is no separate plug fee and no subscription.
//
// SETTLED numbers (the model doc is
// ~/workspace/your_files/tester-hub-profile-plug-model-2026-10-26.md):
//   - Rolodex app: $4.99 one-time on Google Play (sold by the app
//     listing, not here — this backend is the plug machine itself).
//   - FIRST link plugged: FREE (per profile, once).
//   - Every further link: $0.99 flat one-time, OR a ride at 15% of
//     that link's Hub-attributed earnings (band 10-20%, zero floor).
//     Flat or ride, per link — never both on the same link.
//   - THE PENNY SPLIT on every paid flat $0.99 link: ~15c Google /
//     1c referrer / 1c FillMyList prize pot / 1c buyer back as plug
//     credit / ~81c house. 15+1+1+1+81 = 99. Referrer pennies pay
//     out at a $5 balance (the payout rail itself rides a later
//     slice; balances accrue here, visibly).
//
// THIS SLICE'S HONEST LIMITS: profiles and entitlements are managed
// through service-token admin endpoints. The Play IAP rail (receipt
// verification on a real purchase) and the website checkout rail
// land with the app/console train — until then a flat grant through
// the admin endpoint SIMULATES the verified purchase (purchase_ref
// 'sim-…') so the ledger math is real, recorded, and testable. The
// self-serve profile UI rides the next Hub app build.
//
// The plug contract (PLUG.md) is inherited, not reinvented:
//   - Entries carry the house Rolodex shape (name, network, status,
//     link, code, rate, cookie, payout, disclosure, kid_safe).
//   - DISCLOSURE LOCK: an entry renders whole — the redirect URL,
//     code, and disclosure together — or not at all. An entry always
//     has a disclosure (a house standard line by default).
//   - ONLY LIVE ENTRIES RENDER, and "live" here means all three
//     gates: status='live' AND an active entitlement AND the
//     per-network allow-check recorded (model §4 — no plug goes
//     live before its allow-check).
//   - kid_safe is FALSE BY CONSTRUCTION for developer entries:
//     kids'-side pulls can never return them.
//   - Plugging a link NEVER changes feed order or pool counts. The
//     plug buys presence on the developer's own profile/app cards
//     only. We don't sell the pool's trust.
const db = require('../db');
const { normalizeGmail, isGmail } = require('./testerPool');

const LINK_PRICE_CENTS = 99;
const GOOGLE_FEE_CENTS = 15; // Play's 15% of $0.99, off the top
const REFERRER_PENNY_CENTS = 1;
const POT_PENNY_CENTS = 1;
const BUYER_CREDIT_PENNY_CENTS = 1;
const HOUSE_CENTS = LINK_PRICE_CENTS - GOOGLE_FEE_CENTS
  - REFERRER_PENNY_CENTS - POT_PENNY_CENTS - BUYER_CREDIT_PENNY_CENTS; // 81
const RIDE_PERCENT = 15;
const RIDE_BAND = [10, 20];
const REFERRER_PAYOUT_THRESHOLD_CENTS = 500; // $5, settled
const DEFAULT_DISCLOSURE = 'Affiliate link — this developer may earn a commission at no extra cost to you.';
const ENTRY_STATUSES = new Set(['pending', 'live', 'paused', 'approved-not-placed', 'closed']);
const POT_ACCOUNT = 'pot';
const HOUSE_ACCOUNT = 'house';
const GOOGLE_ACCOUNT = 'google';

function clean(v, max) {
  const s = String(v == null ? '' : v).trim().slice(0, max);
  return s || null;
}

// ---------- profiles ----------

function adminProfile(row) {
  if (!row) return null;
  return {
    gmail: row.gmail,
    display_name: row.display_name,
    blurb: row.blurb || '',
    referrer_gmail: row.referrer_gmail || null,
    first_link_free_used: !!Number(row.first_link_free_used),
    rolodex_app_owned: !!Number(row.rolodex_app_owned),
    status: row.status,
    created_at: row.created_at,
  };
}

async function getProfileRow(gmail) {
  return db.get('SELECT * FROM tester_hub_developers WHERE gmail = ?', [normalizeGmail(gmail)]);
}

// Create a developer profile (service-token admin for this slice).
// Idempotent per Gmail: a repeat call refreshes display name/blurb.
// REFERRER ATTRIBUTION IS SET ONCE, AT THE DOOR: the first referrer
// recorded stands — later calls never rewrite who brought them in.
async function createProfile({ gmail, display_name, blurb, referrer_gmail, rolodex_app_owned }) {
  const email = normalizeGmail(gmail);
  if (!isGmail(email)) return { ok: false, error: 'a developer Gmail is required' };
  const name = clean(display_name, 120);
  if (!name) return { ok: false, error: 'display_name is required' };
  let referrer = null;
  if (referrer_gmail != null && String(referrer_gmail).trim() !== '') {
    referrer = normalizeGmail(referrer_gmail);
    if (!isGmail(referrer)) return { ok: false, error: 'referrer_gmail must be a Gmail address' };
    if (referrer === email) return { ok: false, error: 'a developer cannot refer themselves' };
  }
  const existing = await getProfileRow(email);
  if (existing) {
    const patch = { display_name: name, blurb: clean(blurb, 280) };
    if (!existing.referrer_gmail && referrer) patch.referrer_gmail = referrer;
    if (rolodex_app_owned != null) patch.rolodex_app_owned = rolodex_app_owned ? 1 : 0;
    if (existing.status !== 'active') patch.status = 'active';
    await db.update('tester_hub_developers', existing.id, patch);
    return { ok: true, created: false, profile: adminProfile(await getProfileRow(email)) };
  }
  await db.insert('tester_hub_developers', {
    gmail: email, display_name: name, blurb: clean(blurb, 280),
    referrer_gmail: referrer, first_link_free_used: 0,
    rolodex_app_owned: rolodex_app_owned ? 1 : 0, status: 'active',
  });
  return { ok: true, created: true, profile: adminProfile(await getProfileRow(email)) };
}

// Retire a profile (admin): out of every public surface. Its links
// stop rendering with it (the render gate checks profile status).
async function closeProfile({ gmail }) {
  const row = await getProfileRow(gmail);
  if (!row) return { ok: false, notFound: true, error: 'no such developer profile' };
  await db.update('tester_hub_developers', row.id, { status: 'closed' });
  return { ok: true, closed: true, profile: adminProfile(await getProfileRow(row.gmail)) };
}

// ---------- rolodex entries ----------

function adminEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    developer_gmail: row.developer_gmail,
    name: row.name,
    network: row.network || null,
    status: row.status,
    link: row.link || null,
    code: row.code || null,
    rate: row.rate || null,
    cookie: row.cookie || null,
    payout: row.payout || null,
    disclosure: row.disclosure,
    kid_safe: false, // by construction — see header
    subid: row.subid || null,
    entitlement: row.entitlement,
    allow_check_ok: !!Number(row.allow_check_ok),
    allow_check_note: row.allow_check_note || null,
    clicks: Number(row.clicks) || 0,
    created_at: row.created_at,
  };
}

// The render gate — ALL THREE must hold, or the entry does not exist
// as far as any surface is concerned: live status, an entitlement,
// and the allow-check. (Profile status is checked by the callers
// that join through the profile.)
function isRenderable(row) {
  return !!row && row.status === 'live' && row.entitlement !== 'none'
    && Number(row.allow_check_ok) === 1;
}

// The public projection of a plugged link. DISCLOSURE LOCK: the
// redirect URL, code, and disclosure travel together — there is no
// projection with a bare link. The raw affiliate URL never renders
// directly; surfaces link to the Hub redirect (/api/testers/go/<id>)
// so the click is counted by the same counter both sides can read.
function publicEntry(row) {
  return {
    id: row.id,
    name: row.name,
    network: row.network || null,
    code: row.code || null,
    rate: row.rate || null,
    cookie: row.cookie || null,
    payout: row.payout || null,
    disclosure: row.disclosure,
    kid_safe: false,
    go: `/api/testers/go/${row.id}`,
  };
}

async function getEntryRow(entryId) {
  return db.get('SELECT * FROM developer_rolodex_entries WHERE id = ?', [String(entryId || '')]);
}

// Add a link to a developer's Rolodex (service-token admin for this
// slice). The entry starts 'pending' with NO entitlement: it exists
// in the book and renders nowhere until check + grant.
async function addLink({ developer_gmail, name, network, link, code, rate, cookie, payout, disclosure, subid }) {
  const email = normalizeGmail(developer_gmail);
  const profile = await getProfileRow(email);
  if (!profile) return { ok: false, error: 'no developer profile for that Gmail — create the profile first' };
  if (profile.status !== 'active') return { ok: false, error: 'that developer profile is closed' };
  const cleanName = clean(name, 120);
  if (!cleanName) return { ok: false, error: 'name is required' };
  const rawLink = String(link || '').trim().slice(0, 1000);
  let linkUrl;
  try {
    const u = new URL(rawLink);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('http(s) only');
    linkUrl = u.toString();
  } catch (e) {
    return { ok: false, error: 'a valid link URL is required' };
  }
  const id = await db.insert('developer_rolodex_entries', {
    developer_gmail: email,
    name: cleanName,
    network: clean(network, 120),
    status: 'pending',
    link: linkUrl,
    code: clean(code, 120),
    rate: clean(rate, 120),
    cookie: clean(cookie, 120),
    payout: clean(payout, 120),
    // The disclosure lock starts here: an entry ALWAYS has one.
    disclosure: clean(disclosure, 300) || DEFAULT_DISCLOSURE,
    kid_safe: 0, // developer entries are kid_safe=false by construction
    subid: clean(subid, 120),
    entitlement: 'none',
    allow_check_ok: 0,
    allow_check_note: null,
    clicks: 0,
  });
  return { ok: true, entry: adminEntry(await getEntryRow(id)) };
}

// Record the per-network allow-check (model §4) on an entry. No
// entry can be granted — and therefore can never render — until
// this passes. The check is a structural gate, not a promise.
async function recordAllowCheck({ entry_id, ok: passed, note }) {
  const row = await getEntryRow(entry_id);
  if (!row) return { ok: false, notFound: true, error: 'no such rolodex entry' };
  await db.update('developer_rolodex_entries', row.id, {
    allow_check_ok: passed ? 1 : 0,
    allow_check_note: clean(note, 300),
  });
  return { ok: true, entry: adminEntry(await getEntryRow(row.id)) };
}

// ---------- the penny ledger ----------

async function ledgerSum(account, kinds) {
  const placeholders = kinds.map(() => '?').join(', ');
  const row = await db.get(
    `SELECT COALESCE(SUM(amount_cents), 0) AS t FROM penny_ledger WHERE account = ? AND kind IN (${placeholders})`,
    [account, ...kinds]);
  return Number(row && row.t) || 0;
}

// A profile's spendable plug credit: pennies earned as a buyer minus
// credits already consumed by credit-paid plugs.
async function creditBalance(gmail) {
  return ledgerSum(normalizeGmail(gmail), ['split_buyer_credit', 'credit_spend']);
}

// Pennies a person has accrued as a referrer (pays out at $5).
async function referrerBalance(gmail) {
  return ledgerSum(normalizeGmail(gmail), ['split_referrer']);
}

// The prize pot total — public: a visible pot is proof the sweep is
// real (the profiles endpoint publishes it).
async function potTotal() {
  return ledgerSum(POT_ACCOUNT, ['split_pot']);
}

async function writeLedger(rows) {
  for (const r of rows) await db.insert('penny_ledger', r);
}

// THE PENNY SPLIT, executed: one verified $0.99 flat purchase writes
// its five slices, and the five slices sum to the purchase — math
// both sides can audit. Google's slice is recorded for the full
// breakdown (it never reaches us; Play takes it off the top). If
// the buyer has no referrer on file, the referrer penny falls into
// the pot instead — pennies never vanish.
async function writeSplit({ entry, profile, purchaseRef }) {
  const referrer = profile.referrer_gmail || null;
  const rows = [
    { account: GOOGLE_ACCOUNT, kind: 'split_google_fee', amount_cents: GOOGLE_FEE_CENTS, entry_id: entry.id, purchase_ref: purchaseRef, note: 'Play 15% on the $0.99 link plug' },
    { account: POT_ACCOUNT, kind: 'split_pot', amount_cents: POT_PENNY_CENTS, entry_id: entry.id, purchase_ref: purchaseRef, note: 'prize pot penny' },
    { account: profile.gmail, kind: 'split_buyer_credit', amount_cents: BUYER_CREDIT_PENNY_CENTS, entry_id: entry.id, purchase_ref: purchaseRef, note: 'buyer penny back as plug credit' },
    { account: HOUSE_ACCOUNT, kind: 'split_house', amount_cents: HOUSE_CENTS, entry_id: entry.id, purchase_ref: purchaseRef, note: 'the toll' },
  ];
  if (referrer) {
    rows.push({ account: referrer, kind: 'split_referrer', amount_cents: REFERRER_PENNY_CENTS, entry_id: entry.id, purchase_ref: purchaseRef, note: 'referrer penny' });
  } else {
    rows.push({ account: POT_ACCOUNT, kind: 'split_pot', amount_cents: REFERRER_PENNY_CENTS, entry_id: entry.id, purchase_ref: purchaseRef, note: 'unreferred penny — falls into the pot' });
  }
  await writeLedger(rows);
  return {
    purchase_price_cents: LINK_PRICE_CENTS,
    google_fee_cents: GOOGLE_FEE_CENTS,
    referrer_cents: REFERRER_PENNY_CENTS,
    referrer_account: referrer || POT_ACCOUNT,
    pot_cents: POT_PENNY_CENTS + (referrer ? 0 : REFERRER_PENNY_CENTS),
    buyer_credit_cents: BUYER_CREDIT_PENNY_CENTS,
    house_cents: HOUSE_CENTS,
  };
}

// ---------- the entitlement gate ----------

// Grant an entry its entitlement — the moment a link becomes a plug.
// Rules, in order:
//   1. The entry must have passed the allow-check (structural).
//   2. A profile's FIRST granted link is the free one — no purchase,
//      no split. Any other method on the first link is refused.
//   3. 'flat' simulates the verified $0.99 Play purchase (the IAP
//      rail lands with the app train) and fires the penny split.
//   4. 'ride' records the 15% agreement; no purchase, no split —
//      the share reconciles monthly against the network report.
//   5. 'credit' consumes $0.99 of the buyer's accumulated plug
//      credit. NO NEW SPLIT is written: the split already happened
//      when those pennies were earned (each credit penny arrived
//      via a split_buyer_credit row). A credit-paid plug writes
//      exactly one row — the spend — so no penny is ever split
//      twice and the ledger still sums clean.
async function grantEntitlement({ entry_id, method }) {
  const row = await getEntryRow(entry_id);
  if (!row) return { ok: false, notFound: true, error: 'no such rolodex entry' };
  if (row.entitlement !== 'none') return { ok: false, error: 'that link already has an entitlement' };
  if (Number(row.allow_check_ok) !== 1) {
    return { ok: false, error: 'the allow-check has not passed for that link — no plug goes live before its check' };
  }
  const profile = await getProfileRow(row.developer_gmail);
  if (!profile || profile.status !== 'active') return { ok: false, error: 'the developer profile is not active' };
  const m = String(method || 'free').trim().toLowerCase();

  if (!Number(profile.first_link_free_used)) {
    if (m !== 'free') {
      return { ok: false, error: 'the first link is free — grant it with method "free" (no purchase, no split)' };
    }
    await db.update('developer_rolodex_entries', row.id, { entitlement: 'free_first', status: 'live' });
    await db.update('tester_hub_developers', profile.id, { first_link_free_used: 1 });
    return { ok: true, entitlement: 'free_first', entry: adminEntry(await getEntryRow(row.id)) };
  }

  if (m === 'flat') {
    const purchaseRef = `sim-${db.newId()}`;
    const split = await writeSplit({ entry: row, profile, purchaseRef });
    await db.update('developer_rolodex_entries', row.id, { entitlement: 'flat', status: 'live' });
    return {
      ok: true, entitlement: 'flat', simulated_purchase: true, purchase_ref: purchaseRef,
      split, entry: adminEntry(await getEntryRow(row.id)),
    };
  }
  if (m === 'ride') {
    await db.update('developer_rolodex_entries', row.id, { entitlement: 'ride', status: 'live' });
    return {
      ok: true, entitlement: 'ride', ride_percent: RIDE_PERCENT, ride_band: RIDE_BAND,
      entry: adminEntry(await getEntryRow(row.id)),
    };
  }
  if (m === 'credit') {
    const balance = await creditBalance(profile.gmail);
    if (balance < LINK_PRICE_CENTS) {
      return { ok: false, error: `plug credit balance is ${balance}c — a credit-paid plug needs ${LINK_PRICE_CENTS}c` };
    }
    // The spend row ONLY (see rule 5 above): -$0.99 against the
    // buyer's credit, no split rows for this entry.
    await db.insert('penny_ledger', {
      account: profile.gmail, kind: 'credit_spend', amount_cents: -LINK_PRICE_CENTS,
      entry_id: row.id, purchase_ref: null, note: 'credit-paid plug — credit auto-applied',
    });
    await db.update('developer_rolodex_entries', row.id, { entitlement: 'credit', status: 'live' });
    return {
      ok: true, entitlement: 'credit', credit_spent_cents: LINK_PRICE_CENTS,
      credit_balance_cents: await creditBalance(profile.gmail),
      entry: adminEntry(await getEntryRow(row.id)),
    };
  }
  return { ok: false, error: 'method must be one of: free, flat, ride, credit' };
}

// Pause / resume / close an entry (admin). Flipping back to 'live'
// re-checks the full gate — a live flip without entitlement + check
// is refused, so no side door around the gate exists.
async function setLinkStatus({ entry_id, status }) {
  const row = await getEntryRow(entry_id);
  if (!row) return { ok: false, notFound: true, error: 'no such rolodex entry' };
  const s = String(status || '').trim().toLowerCase();
  if (!ENTRY_STATUSES.has(s)) return { ok: false, error: 'unknown status' };
  if (s === 'live' && !isRenderable({ ...row, status: 'live' })) {
    return { ok: false, error: 'cannot go live: the entry needs an entitlement and a passed allow-check first' };
  }
  await db.update('developer_rolodex_entries', row.id, { status: s });
  return { ok: true, entry: adminEntry(await getEntryRow(row.id)) };
}

// ---------- rendering ----------

// A developer's renderable (plugged + live + checked) links, public
// projection. Used by the profile view, the app cards, and the feed.
async function renderableLinksFor(gmail) {
  const profile = await getProfileRow(gmail);
  if (!profile || profile.status !== 'active') return [];
  const rows = await db.all(
    'SELECT * FROM developer_rolodex_entries WHERE developer_gmail = ? ORDER BY created_at ASC',
    [profile.gmail]);
  return rows.filter(isRenderable).map(publicEntry);
}

// Public profiles: display name + blurb, their apps (with the same
// plug_links riding their cards), and their plugged links. NO Gmail
// anywhere — profiles are public, addresses are not.
// NOTE: the app projection mirrors testerPool.publicApp field-for-
// field; the pool module stays the feed's owner, this is the
// profile-shaped view of the same rows.
async function publicProfiles() {
  const profiles = await db.all(
    "SELECT * FROM tester_hub_developers WHERE status = 'active' ORDER BY created_at ASC");
  const out = [];
  for (const p of profiles) {
    const links = await renderableLinksFor(p.gmail);
    const appRows = await db.all(
      "SELECT * FROM tester_hub_apps WHERE developer_gmail = ? AND status = 'active' ORDER BY created_at ASC",
      [p.gmail]);
    const apps = appRows.map((row) => ({
      id: row.id,
      app_name: row.app_name,
      package: row.package || null,
      optin_url: row.optin_url || null,
      blurb: row.blurb || '',
      source: row.source,
      pool_snapshot: Number(row.pool_snapshot) || 0,
      created_at: row.created_at,
      plug_links: links,
    }));
    out.push({ display_name: p.display_name, blurb: p.blurb || '', apps, links });
  }
  return out;
}

// The redirect: a plugged link's one door. Counts the click on the
// same counter the owner reads (both-sides-visible math), appends
// the Hub SubID where the entry carries one, and returns the raw
// target. Ungated/unchecked/non-live entries 404 — the redirect
// never vouches for a link the gate hasn't passed.
async function resolveGo(entryId) {
  const row = await getEntryRow(entryId);
  if (!isRenderable(row)) return null;
  const profile = await getProfileRow(row.developer_gmail);
  if (!profile || profile.status !== 'active') return null;
  await db.update('developer_rolodex_entries', row.id, { clicks: (Number(row.clicks) || 0) + 1 });
  let target = row.link;
  if (row.subid) {
    target += (target.includes('?') ? '&' : '?') + 'subid=' + encodeURIComponent(row.subid);
  }
  return target;
}

// The owner-side read (service-token): the full book for one profile
// or all of them — every entry in every state with its clicks and
// entitlement, plus the penny balances. This is the roster-style
// endpoint the click math and the ledger are read from.
async function adminProfileDetail(gmail) {
  const row = await getProfileRow(gmail);
  if (!row) return null;
  const entries = await db.all(
    'SELECT * FROM developer_rolodex_entries WHERE developer_gmail = ? ORDER BY created_at ASC',
    [row.gmail]);
  return {
    profile: adminProfile(row),
    links: entries.map(adminEntry),
    balances: {
      credit_cents: await creditBalance(row.gmail),
      referrer_cents: await referrerBalance(row.gmail),
      referrer_payout_threshold_cents: REFERRER_PAYOUT_THRESHOLD_CENTS,
    },
  };
}

async function adminAllProfiles() {
  const rows = await db.all('SELECT * FROM tester_hub_developers ORDER BY created_at ASC');
  const out = [];
  for (const r of rows) out.push(await adminProfileDetail(r.gmail));
  return { profiles: out, pot_cents: await potTotal() };
}

module.exports = {
  LINK_PRICE_CENTS, GOOGLE_FEE_CENTS, HOUSE_CENTS, RIDE_PERCENT,
  REFERRER_PAYOUT_THRESHOLD_CENTS, DEFAULT_DISCLOSURE,
  createProfile, closeProfile, getProfileRow, adminProfile,
  addLink, recordAllowCheck, grantEntitlement, setLinkStatus,
  isRenderable, publicEntry, renderableLinksFor, publicProfiles,
  resolveGo, creditBalance, referrerBalance, potTotal,
  adminProfileDetail, adminAllProfiles,
};
