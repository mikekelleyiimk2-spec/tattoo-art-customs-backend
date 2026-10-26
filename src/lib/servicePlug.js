// AI API Service Plug — vault registrar + Play executor (Slice 1, 2026-10-26).
//
// CANONICAL PROJECT: ~/workspace/app/service-plug/ — the design
// (~/workspace/your_files/ai-api-service-plug-design-2026-10-26.md)
// productizes unit #1, our own Google Play doorway, as the reference
// implementation. This module is the server-side machinery:
//
// THE VAULT IS WRITE-ONLY. registerRecord() accepts METADATA ONLY —
// which door, which platform account, the credential class, a storage
// reference (where the secret lives), and the credential file's
// sha256 fingerprint. Secret bytes are never accepted, stored, or
// returned: sanitizeRegister() enforces a strict flat whitelist and
// rejects any payload carrying key material (PEM blocks, private_key
// fields, secret-shaped keys), and NO function in this module returns
// a vault record to any caller. There is no read/export path — that
// absence is a product law, not a missing feature (see the project
// README, plug laws 1–3). Records persist in site_kv (migration 033),
// the same store the Email Keeper status uses.
//
// THE EXECUTOR performs platform OPERATIONS for agents — never key
// requests. playTracks() runs Playbook #1's proof read (a tracks read
// via the Play Developer API edits flow) server-side, using the
// backend's own env-seated Play credential through playverify.js's
// publisher client. The agent sees track data; it never sees, holds,
// or transmits the credential. Failures return an honest error_class
// (claim -> run -> post; never a silent swallow, never limbo).
const db = require('../db');
const { getPublisher } = require('./playverify');

const KV_KEY = 'service_plug_vault';

const CREDENTIAL_CLASSES = new Set([
  'service_account_json_key',
  'long_lived_api_key',
  'oauth_grant_with_refresh',
  'developer_token',
]);

const ALLOWED_FIELDS = new Set([
  'name', 'platform', 'account', 'credential_class', 'fingerprint_sha256',
  'storage_ref', 'scope_granted', 'scope_not_granted', 'seated_at',
  'playbook', 'status',
]);

const REQUIRED_FIELDS = [
  'name', 'platform', 'account', 'credential_class', 'fingerprint_sha256',
  'storage_ref', 'seated_at',
];

const FIELD_CAPS = {
  name: 120, platform: 60, account: 200, credential_class: 60,
  fingerprint_sha256: 64, storage_ref: 300, scope_granted: 600,
  scope_not_granted: 600, seated_at: 10, playbook: 120, status: 200,
};

// Key material must never enter the vault — not in a value, not
// smuggled in a field name. These patterns are checked against the RAW
// serialized body before any field validation, so a rejection can
// never be bypassed by nesting or renaming.
const MATERIAL_PATTERNS = [
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /"private_key"\s*:/,
  /-----BEGIN/,
];

const FORBIDDEN_KEY = /private_?key|client_?secret|pass(word|wd)|secret|api_?key|access_?token|refresh_?token|key_?json|credential_?material/i;

function containsMaterial(value, depth) {
  if (depth > 4) return true; // records are flat; depth is itself a smell
  if (typeof value === 'string') {
    return MATERIAL_PATTERNS.some((re) => re.test(value));
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) return true;
      if (containsMaterial(v, depth + 1)) return true;
    }
  }
  return false;
}

// Validate a vault registration body and rebuild it as the exact stored
// record. Returns { ok: true, record } or { ok: false, error }. The
// record is constructed field-by-field from the whitelist; anything
// else in the body — above all, credential material — is a hard 400,
// never a silent strip: a registrar that quietly dropped a secret
// would still have RECEIVED it, and receiving is the failure.
function sanitizeRegister(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  if (containsMaterial(body, 0)) {
    return { ok: false, error: 'credential material is never accepted here — metadata only' };
  }
  for (const k of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(k)) return { ok: false, error: `unknown field: ${k}` };
    if (typeof body[k] !== 'string') return { ok: false, error: `field must be a string: ${k}` };
  }
  for (const f of REQUIRED_FIELDS) {
    if (!body[f] || !body[f].trim()) return { ok: false, error: `missing field: ${f}` };
  }
  for (const [f, cap] of Object.entries(FIELD_CAPS)) {
    if (body[f] !== undefined && body[f].length > cap) {
      return { ok: false, error: `field too long: ${f}` };
    }
  }
  if (!CREDENTIAL_CLASSES.has(body.credential_class)) {
    return { ok: false, error: 'unknown credential_class' };
  }
  if (!/^[0-9a-f]{64}$/.test(body.fingerprint_sha256)) {
    return { ok: false, error: 'fingerprint_sha256 must be 64 lowercase hex chars' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.seated_at)) {
    return { ok: false, error: 'seated_at must be YYYY-MM-DD' };
  }
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(body.platform)) {
    return { ok: false, error: 'bad platform slug' };
  }
  const record = {};
  for (const f of ALLOWED_FIELDS) record[f] = body[f] !== undefined ? body[f] : '';
  record.registered_at = new Date().toISOString();
  return { ok: true, record };
}

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

// Store one record, upserted by door name. Deliberately returns ONLY
// the record's name + fingerprint for the ack — never the record, and
// there is no companion read function. Write-only means write-only.
async function registerRecord(record) {
  let vault = { records: {} };
  const raw = await kvGet(KV_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.records && typeof parsed.records === 'object') vault = parsed;
    } catch { /* a corrupt vault blob restarts empty rather than crashing the registrar */ }
  }
  vault.records[record.name] = record;
  await kvSet(KV_KEY, JSON.stringify(vault));
  return { registered: record.name, fingerprint_sha256: record.fingerprint_sha256 };
}

// Reduce a googleapis failure to the playbook's error classes. The raw
// error text stays in the server log; the agent gets the class only.
function classifyPlayError(e) {
  const status = (e && e.response && e.response.status) || (typeof (e && e.code) === 'number' ? e.code : null);
  if (status === 401) return 'credential_rejected';
  if (status === 403) return 'permission_denied';
  if (status && status >= 500) return 'platform_unreachable';
  const code = (e && e.code) || '';
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/.test(String(code))) {
    return 'platform_unreachable';
  }
  return 'platform_error';
}

const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

// Playbook #1's proof read, as an agent operation: the tracks of one
// package, read server-side with the vault-referenced door's
// credential. Uses a throwaway edit that is deleted in the same flow;
// the app itself is never modified.
async function playTracks(packageName) {
  if (typeof packageName !== 'string' || packageName.length > 255 || !PACKAGE_RE.test(packageName)) {
    return { ok: false, error_class: 'bad_package' };
  }
  const publisher = await getPublisher();
  if (!publisher) return { ok: false, error_class: 'not_configured' };
  let editId = null;
  try {
    const edit = await publisher.edits.insert({ packageName, requestBody: {} });
    editId = edit.data && edit.data.id;
    const res = await publisher.edits.tracks.list({ packageName, editId });
    const tracks = ((res.data && res.data.tracks) || []).map((t) => ({
      track: t.track,
      releases: (t.releases || []).map((r) => ({
        name: r.name || null,
        versionCodes: r.versionCodes || [],
        status: r.status || null,
      })),
    }));
    return { ok: true, package: packageName, tracks };
  } catch (e) {
    console.error('[service-plug] play tracks failed:', e.message);
    return { ok: false, error_class: classifyPlayError(e) };
  } finally {
    if (editId) {
      try { await publisher.edits.delete({ packageName, editId }); } catch { /* expires on its own */ }
    }
  }
}

module.exports = { sanitizeRegister, registerRecord, playTracks };
