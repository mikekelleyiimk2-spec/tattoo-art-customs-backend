// Root AI API — the root tier of the Service Plug (Slice 1, 2026-10-26).
//
// CANONICAL PROJECT: ~/workspace/app/root-api/ — the estate's own root
// doorway: ONE operations surface over every door in the Codex (the
// Play doorway, PayPal, the six Gmail doors, the Meta connector doors,
// and the rest of the book), for root-level work:
//   - list doors with state (the Codex registry + root registrations),
//   - register / update a door entry,
//   - register, rotate, or revoke a door's credential seat — by sha256
//     FINGERPRINT ONLY, through the Service Plug's write-only vault
//     (src/lib/servicePlug.js). The custody law is identical to slice 1:
//     the registrar rejects raw credential material with a hard error;
//     no function here accepts, stores, or returns secret bytes.
//   - run a door's documented proof read where a backend lane exists
//     (Play tracks read; PayPal balances read; the Email Keeper's
//     recorded read-test state for the Gmail doors). Doors whose proof
//     runs on another lane (the Meta connector CLIs) answer honestly
//     with error_class no_backend_lane + their documented proof text.
//   - the OPERATION LOG (Root Checker posture): every root operation
//     appends { ts, actor, door, operation, result } — who/what
//     operated, on which door, what happened. No secrets, ever: the log
//     records operations and outcomes, never payloads or material.
//
// ESTATE-INTERNAL ONLY. This lane serves the estate's own doors. NO
// outside/customer keys: the custody paper gate (Approval Batch #1) is
// absolute — no outside credential is accepted before the paper is
// approved and signed. There is deliberately no customer onboarding
// surface here.
//
// State lives in site_kv, the estate's service store (the vault, the
// Email Keeper status, and Money Watch watermarks all live there):
//   root_api_doors  — door registrations made through the root lane
//   root_api_seats  — the root lane's own seat index (metadata only:
//                     name, fingerprint, class, status — written on
//                     every root credential operation)
//   root_api_oplog  — the operation log (capped)
const fs = require('fs');
const path = require('path');
const db = require('../db');
const servicePlug = require('./servicePlug');
const paypalPlug = require('./paypalPlug');
const emailKeeper = require('./emailKeeper');

const DOORS_KV = 'root_api_doors';
const SEATS_KV = 'root_api_seats';
const OPLOG_KV = 'root_api_oplog';
const OPLOG_CAP = 200;
const OPLOG_SERVED = 50;
const CODEX_PATH = path.join(__dirname, '..', 'data', 'codex.json');
const DEFAULT_PLAY_PACKAGE = 'com.tattooartcustoms.app';

// ---- site_kv plumbing (same pattern as servicePlug / emailKeeper) --
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
  return a || 'root-lane';
}

// ---- the operation log ----------------------------------------------
async function logOp(actor, door, operation, result) {
  const log = await kvJson(OPLOG_KV, []);
  const entries = Array.isArray(log) ? log : [];
  entries.push({
    ts: new Date().toISOString(),
    actor: String(actor || 'root-lane').slice(0, 60),
    door: String(door || '').slice(0, 160),
    operation,
    result: String(result || '').slice(0, 120),
  });
  await kvSet(OPLOG_KV, JSON.stringify(entries.slice(-OPLOG_CAP)));
}

// ---- the door catalog: the Codex book + root-lane registrations -----
function codexDoors() {
  try {
    const book = JSON.parse(fs.readFileSync(CODEX_PATH, 'utf8'));
    return (book.doors || []).map((d) => ({
      slug: slugify(d.name),
      name: d.name,
      kind: d.kind || 'door',
      state: d.state != null ? d.state : null,
      liveness: {
        how_checked: (d.liveness && d.liveness.how_checked) || null,
        last_verified: (d.liveness && d.liveness.last_verified) || null,
      },
      source: 'codex',
    }));
  } catch (e) {
    console.error('[root-api] codex read failed:', e.message);
    return [];
  }
}

async function catalog() {
  const bySlug = new Map();
  for (const d of codexDoors()) bySlug.set(d.slug, d);
  const overlay = await kvJson(DOORS_KV, {});
  for (const rec of Object.values(overlay)) {
    if (!rec || !rec.name) continue;
    const slug = slugify(rec.name);
    bySlug.set(slug, {
      slug,
      name: rec.name,
      kind: rec.kind || 'door',
      platform: rec.platform || null,
      account: rec.account || null,
      state: rec.state || null,
      playbook: rec.playbook || null,
      proof_read: rec.proof_read || null,
      liveness: { how_checked: rec.proof_read || null, last_verified: rec.last_verified || null },
      source: 'root',
      updated_at: rec.updated_at || null,
    });
  }
  return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---- door registration ----------------------------------------------
const DOOR_FIELDS = new Set([
  'name', 'kind', 'platform', 'account', 'state', 'playbook',
  'proof_read', 'last_verified', 'actor',
]);
const DOOR_REQUIRED = ['name'];
const DOOR_CAPS = {
  name: 160, kind: 40, platform: 60, account: 200, state: 300,
  playbook: 120, proof_read: 600, last_verified: 10, actor: 60,
};

// Validate a door registration body and rebuild it as the stored
// record. Same registrar discipline as the vault: the raw body is
// material-scanned FIRST (credential material is a hard refusal, never
// a silent strip), then a strict flat whitelist is applied field by
// field. A door record is a description — it never carries a key.
function sanitizeDoorRegister(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  if (servicePlug.containsMaterial(body, 0)) {
    return { ok: false, error: 'credential material is never accepted here — metadata only' };
  }
  for (const k of Object.keys(body)) {
    if (!DOOR_FIELDS.has(k)) return { ok: false, error: `unknown field: ${k}` };
    if (typeof body[k] !== 'string') return { ok: false, error: `field must be a string: ${k}` };
  }
  for (const f of DOOR_REQUIRED) {
    if (!body[f] || !body[f].trim()) return { ok: false, error: `missing field: ${f}` };
  }
  for (const [f, cap] of Object.entries(DOOR_CAPS)) {
    if (body[f] !== undefined && body[f].length > cap) {
      return { ok: false, error: `field too long: ${f}` };
    }
  }
  if (body.kind !== undefined && body.kind !== 'door') {
    return { ok: false, error: 'kind must be "door"' };
  }
  if (body.platform !== undefined && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(body.platform)) {
    return { ok: false, error: 'bad platform slug' };
  }
  if (body.last_verified !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(body.last_verified)) {
    return { ok: false, error: 'last_verified must be YYYY-MM-DD' };
  }
  const record = {};
  for (const f of DOOR_FIELDS) {
    if (f === 'actor') continue;
    record[f] = body[f] !== undefined ? body[f] : '';
  }
  if (!record.kind) record.kind = 'door';
  return { ok: true, record, actor: actorOf(body) };
}

async function registerDoor(body) {
  const s = sanitizeDoorRegister(body);
  if (!s.ok) {
    await logOp(actorOf(body), body && body.name, 'door_register', 'rejected');
    return s;
  }
  const overlay = await kvJson(DOORS_KV, {});
  const now = new Date().toISOString();
  const existing = overlay[s.record.name];
  s.record.registered_at = (existing && existing.registered_at) || now;
  s.record.updated_at = now;
  overlay[s.record.name] = s.record;
  await kvSet(DOORS_KV, JSON.stringify(overlay));
  await logOp(s.actor, s.record.name, 'door_register', 'ok');
  return { ok: true, registered: s.record.name, actor: s.actor };
}

// ---- credential seats: fingerprint-only, through the vault ---------
async function seatIndexUpsert(entry) {
  const seats = await kvJson(SEATS_KV, {});
  const prev = seats[entry.name] || {};
  seats[entry.name] = { ...prev, ...entry, updated_at: new Date().toISOString() };
  await kvSet(SEATS_KV, JSON.stringify(seats));
}

// Register (or rotate) a door's credential seat. The sanitizer and the
// store are the Service Plug vault's own — the write-only law is not
// re-implemented here, it is inherited. Rotation IS re-registration
// with the new fingerprint: the vault record is upserted by door name,
// so the old fingerprint is replaced, never accumulated.
async function registerCredential(body, operation) {
  const actor = actorOf(body);
  // `actor` is the root lane's own control field — strip it before the
  // vault sanitizer sees the body (its whitelist is the vault's alone).
  const vaultBody = body && typeof body === 'object' ? { ...body } : body;
  if (vaultBody && typeof vaultBody === 'object') delete vaultBody.actor;
  const s = servicePlug.sanitizeRegister(vaultBody);
  if (!s.ok) {
    await logOp(actor, body && body.name, operation, 'rejected');
    return s;
  }
  const ack = await servicePlug.registerRecord(s.record);
  await seatIndexUpsert({
    name: ack.registered,
    fingerprint_sha256: ack.fingerprint_sha256,
    credential_class: s.record.credential_class,
    platform: s.record.platform,
    status: operation === 'credential_rotate' ? 'rotated' : 'seated',
  });
  await logOp(actor, ack.registered, operation, 'ok');
  return { ok: true, registered: ack.registered, fingerprint_sha256: ack.fingerprint_sha256, actor };
}

// Revoke a door's credential seat: a status flip on the vault record
// (custody paper §4 — revocation is a normal event). The seat index
// mirrors the revocation; the record itself holds no material, so
// retaining it as the damage record risks nothing.
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
    if (k !== 'name' && k !== 'actor') return { ok: false, error: `unknown field: ${k}` };
    if (typeof body[k] !== 'string') return { ok: false, error: `field must be a string: ${k}` };
  }
  const name = (body.name || '').trim();
  if (!name) return { ok: false, error: 'missing field: name' };
  const ack = await servicePlug.markCredentialStatus(name, `revoked — root lane ${new Date().toISOString().slice(0, 10)}`);
  if (!ack) {
    await logOp(actor, name, 'credential_revoke', 'unknown_seat');
    return { ok: false, error_class: 'unknown_seat', error: 'unknown credential seat' };
  }
  await seatIndexUpsert({ name, fingerprint_sha256: ack.fingerprint_sha256, status: 'revoked' });
  await logOp(actor, name, 'credential_revoke', 'ok');
  return { ok: true, revoked: name, fingerprint_sha256: ack.fingerprint_sha256, actor };
}

// ---- proof reads ------------------------------------------------------
// Run the door's documented proof read on the lane that can run it.
// Every outcome is honest: a completed read with its result, or an
// error_class naming why this lane cannot run that door's proof.
async function runProof(body) {
  const actor = actorOf(body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  if (servicePlug.containsMaterial(body, 0)) {
    await logOp(actor, body.door, 'proof', 'rejected');
    return { ok: false, error: 'credential material is never accepted here — metadata only' };
  }
  const doorName = typeof body.door === 'string' ? body.door.trim() : '';
  if (!doorName) return { ok: false, error: 'missing field: door' };
  const doors = await catalog();
  const door = doors.find((d) => d.name === doorName || d.slug === slugify(doorName));
  if (!door) {
    await logOp(actor, doorName, 'proof', 'unknown_door');
    return { ok: false, error_class: 'unknown_door', error: 'unknown door' };
  }

  let result;
  if (door.platform === 'google-play' || door.name === 'Google Play Developer API doorway') {
    const pkg = typeof body.package === 'string' && body.package ? body.package : DEFAULT_PLAY_PACKAGE;
    const r = await servicePlug.playTracks(pkg);
    result = r.ok
      ? { ok: true, door: door.name, proof: 'play-tracks', package: r.package, tracks: r.tracks }
      : { ok: false, door: door.name, proof: 'play-tracks', error_class: r.error_class };
  } else if (door.platform === 'paypal' || door.name.startsWith('PayPal REST API')) {
    if (!paypalPlug.configured()) {
      result = { ok: false, door: door.name, proof: 'paypal-balances', error_class: 'awaiting_credential_registration' };
    } else {
      try {
        const balances = await paypalPlug.fetchBalances();
        result = { ok: true, door: door.name, proof: 'paypal-balances', balances_count: balances.length };
      } catch (e) {
        result = { ok: false, door: door.name, proof: 'paypal-balances', error_class: (e && e.paypalClass) || 'read_failed' };
      }
    }
  } else if (door.name.startsWith('Gmail — ')) {
    const key = door.name.slice('Gmail — '.length).split(' ')[0].toLowerCase();
    const status = await emailKeeper.getStatus();
    const acct = (status.accounts || []).find((a) => a.key === key);
    result = acct
      ? {
        ok: acct.state === 'up', door: door.name, proof: 'email-keeper-read-test',
        state: acct.state, checked_at: acct.checked_at || null,
        last_success_at: acct.last_success_at || null,
        error_class: acct.state === 'up' ? null : (acct.error_class || 'down'),
      }
      : { ok: false, door: door.name, proof: 'email-keeper-read-test', error_class: 'unknown_mailbox' };
  } else {
    result = {
      ok: false, door: door.name, error_class: 'no_backend_lane',
      proof: door.proof_read || (door.liveness && door.liveness.how_checked) || '',
    };
  }
  await logOp(actor, door.name, 'proof', result.ok ? 'ok' : (result.error_class || 'failed'));
  return result;
}

// ---- state ------------------------------------------------------------
async function getState() {
  const doors = await catalog();
  const seats = await kvJson(SEATS_KV, {});
  const log = await kvJson(OPLOG_KV, []);
  return {
    doors,
    door_count: doors.length,
    seats: Object.values(seats).sort((a, b) => a.name.localeCompare(b.name)),
    oplog: (Array.isArray(log) ? log : []).slice(-OPLOG_SERVED),
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  sanitizeDoorRegister, registerDoor,
  registerCredential, revokeCredential,
  runProof, getState, slugify,
};
