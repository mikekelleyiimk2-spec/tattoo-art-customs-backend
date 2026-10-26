// Email Keeper — live status store (2026-10-26).
//
// CANONICAL SOURCE: ~/workspace/app/email-keeper/ — keeper-check.py writes
// status.json there after read-testing all six mailboxes, and
// verification-routes.json holds the lockout-proofing registry (the
// computed EXPOSED flags). keeper-sync.py POSTs both to
// /api/email-keeper/ingest (Muse service-token auth, src/routes/api.js);
// this module validates the payload, WHITELISTS it down to the public
// field set, and stores the latest snapshot in site_kv (migration 033 —
// the same key-value store storageWatch uses for its alert watermarks;
// a single "latest state" blob is exactly what site_kv is for, so no new
// table is warranted).
//
// PUBLIC CONTRACT — GET /api/email-keeper serves ONLY, per mailbox:
//   key, address, state, checked_at, last_success_at, down_since,
//   error_class, exposed
// The ingest payload is rebuilt through sanitizeIngest() before storage,
// so connector account ids, doorway URLs, fix text, or anything else the
// keeper happens to carry in status.json can never reach storage, let
// alone a response. Addresses are public contact points and the server
// owns the address book: the stored address is the canonical one for the
// key, whatever the payload claimed. States are the product.
const db = require('../db');

const KV_KEY = 'email_keeper_status';

// The six mailboxes, in board order (canonical — see the Email Keeper
// README's mailbox table).
const MAILBOXES = [
  { key: 'mk2', address: 'mikekelleyii.mk2@gmail.com' },
  { key: 'mk', address: 'mikekelleyii.mk@gmail.com' },
  { key: 'mk4', address: 'mikekelleyii.mk4@gmail.com' },
  { key: 'littleinkersstudio', address: 'littleinkersstudio@gmail.com' },
  { key: 'mk5', address: 'mikekelleyii.mk5@gmail.com' },
  { key: 'tac', address: 'tattoo.art.customs@gmail.com' },
];
const KEYS = new Set(MAILBOXES.map((m) => m.key));

function unknownEntry(m) {
  return {
    key: m.key,
    address: m.address,
    state: 'unknown',
    checked_at: null,
    last_success_at: null,
    down_since: null,
    error_class: null,
    exposed: null,
  };
}

function baseline() {
  return { generated_at: null, ingested_at: null, accounts: MAILBOXES.map(unknownEntry) };
}

// A timestamp field: null stays null, a short string passes, anything
// else is a validation failure (undefined sentinel).
function tsField(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || v.length === 0 || v.length > 40) return undefined;
  return v;
}

// Validate an ingest body and rebuild it as the exact public payload.
// Returns { ok: true, payload } or { ok: false, error }. The payload is
// constructed field-by-field from the whitelist — nothing else in the
// body (account ids, doorway data, stray keys) survives this function.
function sanitizeIngest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  if (!Array.isArray(body.accounts) || body.accounts.length === 0 || body.accounts.length > MAILBOXES.length) {
    return { ok: false, error: 'accounts must be an array of 1..6 mailboxes' };
  }
  const generatedAt = tsField(body.generated_at);
  if (generatedAt === undefined) return { ok: false, error: 'bad generated_at' };

  // exposed: optional map of mailbox key -> boolean (the lockout-proofing
  // summary from verification-routes.json). Junk here is still junk.
  const exposed = {};
  if (body.exposed !== undefined && body.exposed !== null) {
    if (typeof body.exposed !== 'object' || Array.isArray(body.exposed)) {
      return { ok: false, error: 'exposed must be an object' };
    }
    for (const [k, v] of Object.entries(body.exposed)) {
      if (!KEYS.has(k) || typeof v !== 'boolean') {
        return { ok: false, error: 'bad exposed entry' };
      }
      exposed[k] = v;
    }
  }

  const byKey = new Map();
  for (const a of body.accounts) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      return { ok: false, error: 'account entries must be objects' };
    }
    if (!KEYS.has(a.key)) return { ok: false, error: 'unknown mailbox key' };
    if (byKey.has(a.key)) return { ok: false, error: 'duplicate mailbox key' };
    if (typeof a.address !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.address) || a.address.length > 200) {
      return { ok: false, error: 'bad address' };
    }
    if (a.state !== 'up' && a.state !== 'down') {
      return { ok: false, error: 'bad state' };
    }
    const checkedAt = tsField(a.checked_at);
    const lastSuccessAt = tsField(a.last_success_at);
    const downSince = tsField(a.down_since);
    if (checkedAt === undefined || lastSuccessAt === undefined || downSince === undefined) {
      return { ok: false, error: 'bad timestamp field' };
    }
    let errorClass = null;
    if (a.error_class !== null && a.error_class !== undefined) {
      if (typeof a.error_class !== 'string' || !/^[a-z0-9_]{1,64}$/.test(a.error_class)) {
        return { ok: false, error: 'bad error_class' };
      }
      errorClass = a.error_class;
    }
    byKey.set(a.key, {
      state: a.state,
      checked_at: checkedAt,
      last_success_at: lastSuccessAt,
      down_since: downSince,
      error_class: errorClass,
    });
  }

  // Project in canonical order; mailboxes the payload omitted stay
  // 'unknown' rather than vanishing from the board.
  const accounts = MAILBOXES.map((m) => {
    const hit = byKey.get(m.key);
    if (!hit) return unknownEntry(m);
    return {
      key: m.key,
      address: m.address,
      state: hit.state,
      checked_at: hit.checked_at,
      last_success_at: hit.last_success_at,
      down_since: hit.down_since,
      error_class: hit.error_class,
      exposed: Object.prototype.hasOwnProperty.call(exposed, m.key) ? exposed[m.key] : null,
    };
  });

  return {
    ok: true,
    payload: {
      generated_at: generatedAt,
      ingested_at: new Date().toISOString(),
      accounts,
    },
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

// Latest stored status, merged over the all-unknown baseline so the GET
// response always carries all six mailboxes — even before the first
// ingest (or if a stored blob is somehow partial/corrupt).
async function getStatus() {
  const raw = await kvGet(KV_KEY);
  if (!raw) return baseline();
  try {
    const stored = JSON.parse(raw);
    if (!stored || !Array.isArray(stored.accounts)) return baseline();
    const byKey = new Map(stored.accounts.map((a) => [a && a.key, a]));
    return {
      generated_at: typeof stored.generated_at === 'string' ? stored.generated_at : null,
      ingested_at: typeof stored.ingested_at === 'string' ? stored.ingested_at : null,
      accounts: MAILBOXES.map((m) => {
        const a = byKey.get(m.key);
        if (!a) return unknownEntry(m);
        // Re-project through the whitelist on the way out too: stored
        // data was sanitized on the way in, and this keeps the public
        // contract true even against a hand-edited kv row.
        return {
          key: m.key,
          address: m.address,
          state: a.state === 'up' || a.state === 'down' ? a.state : 'unknown',
          checked_at: typeof a.checked_at === 'string' ? a.checked_at : null,
          last_success_at: typeof a.last_success_at === 'string' ? a.last_success_at : null,
          down_since: typeof a.down_since === 'string' ? a.down_since : null,
          error_class: typeof a.error_class === 'string' ? a.error_class : null,
          exposed: typeof a.exposed === 'boolean' ? a.exposed : null,
        };
      }),
    };
  } catch {
    return baseline();
  }
}

async function saveStatus(payload) {
  await kvSet(KV_KEY, JSON.stringify(payload));
}

module.exports = { MAILBOXES, baseline, sanitizeIngest, getStatus, saveStatus };
