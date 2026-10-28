// OneMind Root — the root tier's home inside the table (2026-10-26).
//
// CANONICAL PROJECT: ~/workspace/app/onemind-root/ — the owner-level
// root doorway over the OneMind TABLE ITSELF. Distinct from the Root
// AI API (src/lib/rootApi.js), which is the root lane over the
// estate's DOORS (Play, PayPal, Gmail, the connector doors). This
// lane is the table's own root: the seats registry, the plug points
// where tools join the table, the plug-in charge on each point, and
// the root operation log for the table.
//
// THE TABLE IS A PLUGIN PLATFORM (Messenger spec Addendum 10 + the
// owner's Oct 26 plug-in-charge note): tools plug into the table,
// and ADDING a tool costs — never a free act. The charge on every
// plug point is computed here from the Price of the Plug (Codex law):
//   - fleet (the owner's own apps/tools): plug in for ZERO — house
//     into house; his own fleet plugs carry no charge and no toll.
//   - outside, with a subscription: the maker's OWN subscription
//     price, carried in the bundle — no second, invented plug fee,
//     ever; our cut is the toll on the flow across the plug.
//   - outside, no subscription: pays in PEOPLE — plugging in ties
//     its users to the table.
// An implied charge is an uncharged one: every plug point this lane
// serves carries its charge object next to it, computed, never
// assumed.
//
// Custody discipline is INHERITED from the Service Plug vault
// (src/lib/servicePlug.js), exactly as the Root AI API inherited it:
// seat credentials register / rotate / revoke by sha256 FINGERPRINT
// ONLY; raw credential material is a hard refusal at the registrar;
// no function here accepts, stores, or returns secret bytes.
//
// ESTATE-INTERNAL ONLY. This lane serves the owner's own table. NO
// customer onboarding exists here and NO outside key is accepted,
// requested, or held — the custody-paper gate (Approval Batch #1) is
// absolute and stands exactly as it does for the plug's root tier.
//
// State lives in site_kv, the estate's service store:
//   onemind_root_seats       — seat registrations made on this lane
//   onemind_root_plugpoints  — plug-point registrations on this lane
//   onemind_root_seat_index  — this lane's credential seat index
//                              (metadata only: name, fingerprint,
//                              class, status, seat association)
//   onemind_root_oplog       — the table's root operation log (capped)
const fs = require('fs');
const path = require('path');
const db = require('../db');
const servicePlug = require('./servicePlug');

const SEATS_KV = 'onemind_root_seats';
const PLUGPOINTS_KV = 'onemind_root_plugpoints';
const SEAT_INDEX_KV = 'onemind_root_seat_index';
const OPLOG_KV = 'onemind_root_oplog';
const OPLOG_CAP = 200;
const OPLOG_SERVED = 50;
const CODEX_PATH = path.join(__dirname, '..', 'data', 'codex.json');

// ---- site_kv plumbing (same pattern as rootApi / servicePlug) -------
async function kvGet(name) {
  try {
    const row = await db.get('SELECT val FROM site_kv WHERE name = ?', [name]);
    return row ? row.val : null;
  } catch { return null; }
}

async function kvSet(name, val) {
  await db.query(
    `INSERT INTO site_kv (name, val, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET val = excluded.val, updated_at = excluded.updated_at`,
    [name, val, db.now()]);
}

async function kvJson(name, fallback) {
  const raw = await kvGet(name);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function actorOf(body) {
  const a = body && typeof body.actor === 'string' ? body.actor.trim().slice(0, 60) : '';
  return a || 'onemind-root';
}

// ---- the operation log ------------------------------------------------
// Every root operation on the table appends { ts, actor, target,
// operation, result } — who operated, on which seat or plug point,
// what happened. Rejections are logged too. No payloads, no secrets.
async function logOp(actor, target, operation, result) {
  const log = await kvJson(OPLOG_KV, []);
  const entries = Array.isArray(log) ? log : [];
  entries.push({
    ts: new Date().toISOString(),
    actor: String(actor || 'onemind-root').slice(0, 60),
    target: String(target || '').slice(0, 160),
    operation,
    result: String(result || '').slice(0, 120),
  });
  await kvSet(OPLOG_KV, JSON.stringify(entries.slice(-OPLOG_CAP)));
}

// ---- the Codex book: seats, plugs, settled prices ---------------------
function codexBook() {
  try {
    return JSON.parse(fs.readFileSync(CODEX_PATH, 'utf8'));
  } catch (e) {
    console.error('[onemind-root] codex read failed:', e.message);
    return {};
  }
}

function livenessOf(e) {
  const lv = (e && e.liveness) || {};
  return {
    how_checked: lv.how_checked || null,
    last_verified: lv.last_verified || null,
  };
}

// Settled price entries are projected as name + state ONLY: the state
// string IS the settled figure record (e.g. "SETTLED — … $149 …").
// Notes are internal operations history and are never projected —
// the same projection law as src/lib/codex.js.
function codexPrices(book) {
  const entries = (book.prices && book.prices.entries) || [];
  return entries.map((p) => ({
    name: p.name,
    kind: p.kind || 'price',
    state: p.state != null ? p.state : null,
  }));
}

// Which settled price entry prices which plug — display metadata for
// the root view, written here next to the computation it feeds. The
// charge text always comes from the price entry's own state string,
// never from a figure restated in this file.
const PLUG_PRICE_ENTRY = {
  'Affiliate Rolodex plug': 'Affiliate Rolodex + FillMyList Profile Plug',
  'FillMyList pool': 'Affiliate Rolodex + FillMyList Profile Plug',
  'Universal Affiliate Plug contract': 'Affiliate Rolodex + FillMyList Profile Plug',
  'Profile Plug': 'Affiliate Rolodex + FillMyList Profile Plug',
  'Email Keeper': 'Connection Doctor / Email Keeper watch',
  'AI API Service Plug': 'AI API Service Plug (standard tier)',
  'Root AI API': 'Root AI API (root tier)',
  'RoboSweeper': 'Penny Toolbox (RoboSweeper · RoboScraper · contained Toolbox)',
  'RoboScraper': 'Penny Toolbox (RoboSweeper · RoboScraper · contained Toolbox)',
  'Money Watch': 'Money Watch',
};

// ---- the plug-in charge (the Price of the Plug, computed) -------------
const PLUG_CLASSES = new Set(['fleet', 'outside_subscription', 'outside_no_subscription']);

function chargeFor(plugClass, rec) {
  if (plugClass === 'outside_subscription') {
    return {
      model: 'outside_subscription',
      plug_in: rec && rec.subscription_price
        ? `${rec.subscription_price} — the maker's own subscription price, carried in the bundle (no invented plug fee)`
        : "the maker's own subscription price, carried in the bundle (no invented plug fee)",
      toll: 'the toll on the flow across the plug',
    };
  }
  if (plugClass === 'outside_no_subscription') {
    return {
      model: 'outside_no_subscription',
      plug_in: 'pays in people — plugging in ties its users to the table',
      toll: 'the toll on the flow across the plug',
    };
  }
  // fleet — the owner's own fleet: house into house (Codex law 3).
  return {
    model: 'fleet_zero',
    plug_in: "zero — house into house (the owner's own fleet plugs in for zero)",
    toll: "none — no toll is charged on the house's own plugs",
  };
}

// ---- registries: the Codex book + this lane's registrations -----------
function codexSeats(book) {
  return (book.seats || []).map((s) => ({
    slug: slugify(s.name),
    name: s.name,
    kind: s.kind || 'seat',
    state: s.state != null ? s.state : null,
    liveness: livenessOf(s),
    source: 'codex',
  }));
}

function codexPlugPoints(book, prices) {
  return (book.plugs || []).map((p) => {
    const entryName = PLUG_PRICE_ENTRY[p.name];
    const price = entryName ? prices.find((x) => x.name === entryName) : null;
    return {
      slug: slugify(p.name),
      name: p.name,
      kind: p.kind || 'plug',
      state: p.state != null ? p.state : null,
      liveness: livenessOf(p),
      plug_class: 'fleet',
      charge: chargeFor('fleet', null),
      settled_price: price ? { name: price.name, state: price.state } : null,
      source: 'codex',
    };
  });
}

async function seatRegistry(book) {
  const bySlug = new Map();
  for (const s of codexSeats(book)) bySlug.set(s.slug, s);
  const overlay = await kvJson(SEATS_KV, {});
  for (const rec of Object.values(overlay)) {
    if (!rec || !rec.name) continue;
    const slug = slugify(rec.name);
    bySlug.set(slug, {
      slug,
      name: rec.name,
      kind: 'seat',
      seat_ai: rec.seat_ai || null,
      state: rec.state || null,
      about: rec.about || null,
      availability: rec.availability || null,
      liveness: { how_checked: 'registered on the OneMind Root lane', last_verified: rec.last_verified || null },
      source: 'root',
      updated_at: rec.updated_at || null,
    });
  }
  return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function plugPointRegistry(book, prices) {
  const bySlug = new Map();
  for (const p of codexPlugPoints(book, prices)) bySlug.set(p.slug, p);
  const overlay = await kvJson(PLUGPOINTS_KV, {});
  for (const rec of Object.values(overlay)) {
    if (!rec || !rec.name) continue;
    const slug = slugify(rec.name);
    const prev = bySlug.get(slug);
    bySlug.set(slug, {
      slug,
      name: rec.name,
      kind: 'plug',
      state: rec.state || (prev && prev.state) || null,
      liveness: { how_checked: 'registered on the OneMind Root lane', last_verified: rec.last_verified || null },
      plug_class: rec.plug_class || 'fleet',
      charge: chargeFor(rec.plug_class || 'fleet', rec),
      price_label: rec.price_label || null,
      settled_price: (prev && prev.settled_price) || null,
      source: 'root',
      updated_at: rec.updated_at || null,
    });
  }
  return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---- registration discipline -------------------------------------------
// Same registrar law as the root lane and the vault: the raw body is
// material-scanned FIRST (credential material is a hard refusal, never
// a silent strip), then a strict flat whitelist is applied field by
// field. A registry record is a description — it never carries a key.
function sanitizeFlat(body, fields, required, caps) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  if (servicePlug.containsMaterial(body, 0)) {
    return { ok: false, error: 'credential material is never accepted here — metadata only' };
  }
  for (const k of Object.keys(body)) {
    if (!fields.has(k)) return { ok: false, error: `unknown field: ${k}` };
    if (typeof body[k] !== 'string') return { ok: false, error: `field must be a string: ${k}` };
  }
  for (const f of required) {
    if (!body[f] || !body[f].trim()) return { ok: false, error: `missing field: ${f}` };
  }
  for (const [f, cap] of Object.entries(caps)) {
    if (body[f] !== undefined && body[f].length > cap) {
      return { ok: false, error: `field too long: ${f}` };
    }
  }
  if (body.last_verified !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(body.last_verified)) {
    return { ok: false, error: 'last_verified must be YYYY-MM-DD' };
  }
  return { ok: true };
}

const SEAT_FIELDS = new Set(['name', 'seat_ai', 'state', 'about', 'availability', 'last_verified', 'actor']);
const SEAT_CAPS = { name: 160, seat_ai: 120, state: 300, about: 600, availability: 120, last_verified: 10, actor: 60 };

async function registerSeat(body) {
  const s = sanitizeFlat(body, SEAT_FIELDS, ['name'], SEAT_CAPS);
  if (!s.ok) {
    await logOp(actorOf(body), body && body.name, 'seat_register', 'rejected');
    return s;
  }
  const record = {};
  for (const f of SEAT_FIELDS) {
    if (f === 'actor') continue;
    record[f] = body[f] !== undefined ? body[f] : '';
  }
  const overlay = await kvJson(SEATS_KV, {});
  const now = new Date().toISOString();
  const existing = overlay[record.name];
  record.registered_at = (existing && existing.registered_at) || now;
  record.updated_at = now;
  overlay[record.name] = record;
  await kvSet(SEATS_KV, JSON.stringify(overlay));
  await logOp(actorOf(body), record.name, 'seat_register', 'ok');
  return { ok: true, registered: record.name, actor: actorOf(body) };
}

const PLUGPOINT_FIELDS = new Set([
  'name', 'plug_class', 'subscription_price', 'price_label', 'state', 'last_verified', 'actor',
]);
const PLUGPOINT_CAPS = {
  name: 160, plug_class: 40, subscription_price: 120, price_label: 200, state: 300, last_verified: 10, actor: 60,
};

async function registerPlugPoint(body) {
  const s = sanitizeFlat(body, PLUGPOINT_FIELDS, ['name'], PLUGPOINT_CAPS);
  if (!s.ok) {
    await logOp(actorOf(body), body && body.name, 'plugpoint_register', 'rejected');
    return s;
  }
  if (body.plug_class !== undefined && !PLUG_CLASSES.has(body.plug_class)) {
    await logOp(actorOf(body), body.name, 'plugpoint_register', 'rejected');
    return { ok: false, error: 'unknown plug_class' };
  }
  const record = {};
  for (const f of PLUGPOINT_FIELDS) {
    if (f === 'actor') continue;
    record[f] = body[f] !== undefined ? body[f] : '';
  }
  if (!record.plug_class) record.plug_class = 'fleet';
  const overlay = await kvJson(PLUGPOINTS_KV, {});
  const now = new Date().toISOString();
  const existing = overlay[record.name];
  record.registered_at = (existing && existing.registered_at) || now;
  record.updated_at = now;
  overlay[record.name] = record;
  await kvSet(PLUGPOINTS_KV, JSON.stringify(overlay));
  await logOp(actorOf(body), record.name, 'plugpoint_register', 'ok');
  return { ok: true, registered: record.name, actor: actorOf(body) };
}

// ---- credential seats: fingerprint-only, through the vault -------------
async function seatIndexUpsert(entry) {
  const seats = await kvJson(SEAT_INDEX_KV, {});
  const prev = seats[entry.name] || {};
  seats[entry.name] = { ...prev, ...entry, updated_at: new Date().toISOString() };
  await kvSet(SEAT_INDEX_KV, JSON.stringify(seats));
}

// Register (or rotate) a table seat's credential. The sanitizer and
// the store are the Service Plug vault's own — inherited, not
// re-implemented. `actor` and the optional `seat` association (which
// table seat this credential belongs to) are this lane's own control
// fields and are stripped before the vault sanitizer sees the body.
async function registerCredential(body, operation) {
  const actor = actorOf(body);
  const seat = body && typeof body.seat === 'string' ? body.seat.trim().slice(0, 160) : '';
  const vaultBody = body && typeof body === 'object' ? { ...body } : body;
  if (vaultBody && typeof vaultBody === 'object') {
    delete vaultBody.actor;
    delete vaultBody.seat;
  }
  const s = servicePlug.sanitizeRegister(vaultBody);
  if (!s.ok) {
    await logOp(actor, (body && (body.seat || body.name)) || '', operation, 'rejected');
    return s;
  }
  const ack = await servicePlug.registerRecord(s.record);
  await seatIndexUpsert({
    name: ack.registered,
    seat: seat || null,
    fingerprint_sha256: ack.fingerprint_sha256,
    credential_class: s.record.credential_class,
    platform: s.record.platform,
    status: operation === 'credential_rotate' ? 'rotated' : 'seated',
  });
  await logOp(actor, seat || ack.registered, operation, 'ok');
  return { ok: true, registered: ack.registered, fingerprint_sha256: ack.fingerprint_sha256, actor };
}

// Revoke a seat credential: a status flip on the vault record
// (custody paper §4 — revocation is a normal event, respected
// instantly). Unknown seat = reported as unknown_seat (route: 404).
async function revokeCredential(body) {
  const actor = actorOf(body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  if (servicePlug.containsMaterial(body, 0)) {
    await logOp(actor, body.name, 'credential_revoke', 'rejected');
    return { ok: false, error: 'credential material is never accepted here — metadata only' };
  }
  for (const k of Object.keys(body)) {
    if (k !== 'name' && k !== 'actor' && k !== 'seat') return { ok: false, error: `unknown field: ${k}` };
    if (typeof body[k] !== 'string') return { ok: false, error: `field must be a string: ${k}` };
  }
  const name = (body.name || '').trim();
  if (!name) return { ok: false, error: 'missing field: name' };
  const seat = typeof body.seat === 'string' ? body.seat.trim().slice(0, 160) : '';
  const ack = await servicePlug.markCredentialStatus(name, `revoked — OneMind Root lane ${new Date().toISOString().slice(0, 10)}`);
  if (!ack) {
    await logOp(actor, seat || name, 'credential_revoke', 'unknown_seat');
    return { ok: false, error_class: 'unknown_seat', error: 'unknown credential seat' };
  }
  await seatIndexUpsert({ name, seat: seat || null, fingerprint_sha256: ack.fingerprint_sha256, status: 'revoked' });
  await logOp(actor, seat || name, 'credential_revoke', 'ok');
  return { ok: true, revoked: name, fingerprint_sha256: ack.fingerprint_sha256, actor };
}

// ---- state: the table's root view ---------------------------------------
async function getState() {
  const book = codexBook();
  const prices = codexPrices(book);
  const seats = await seatRegistry(book);
  const plugPoints = await plugPointRegistry(book, prices);
  const seatIndex = await kvJson(SEAT_INDEX_KV, {});
  const log = await kvJson(OPLOG_KV, []);
  return {
    table: 'OneMind',
    seats,
    seat_count: seats.length,
    plug_points: plugPoints,
    plug_point_count: plugPoints.length,
    prices,
    plug_law: (book.prices && book.prices.law) || null,
    seat_index: Object.values(seatIndex).sort((a, b) => a.name.localeCompare(b.name)),
    oplog: (Array.isArray(log) ? log : []).slice(-OPLOG_SERVED),
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  registerSeat, registerPlugPoint,
  registerCredential, revokeCredential,
  getState, slugify, chargeFor,
};
