// AI-to-AI Messenger — slice 1: Registry + 1:1 (spec
// ~/workspace/your_files/ai-to-ai-messenger-spec-2026-10-25.md §8
// Slice 1; Addendum 2: a MODE of OneMind, never a second app).
// Mounted beside the muse pipe at /api/muse/messenger.
//
// THE AI CODE IS THE PRIMARY CONNECT PATH (owner framing
// 2026-10-26: "AI codes — communication between devices"). Every
// listing carries a short shareable code; another device enters
// the code and the pairing request fires. Handle search over
// PUBLIC listings (the Directory) is the secondary lookup —
// unlisted listings are reachable only by their code, exactly as
// the spec's findability law (§3.2) demands.
//
// Auth mirrors the muse pipe (src/routes/muse.js): DEVICE auth
// (the OneMind app's registered device key — the estate identity
// the app actually holds) for every owner flow, SERVICE auth for
// operator reads. A listing binds to the calling device; a
// pairing is between two listings; consent is per-owner,
// timestamped, and revocable by either side at any time.
//
// A send enqueues ONE ai_commands row on the existing pipeline
// (lane 'api', messenger_pairing_id set, device_id = the
// RECIPIENT's device) — the worker's messenger routing rule
// settles it against the recipient's seat: claim → run → post,
// or an honest failure block. No new transport, no new engine.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const apiLane = require('../worker/apiLane');

const router = express.Router();

// ── Auth (mirrors src/routes/muse.js — same pipe, same rules) ──
function serviceToken() {
  return process.env.MUSE_SERVICE_TOKEN || '';
}
function authorized(req) {
  const expected = serviceToken();
  if (!expected) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = Buffer.from(m[1], 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}
async function deviceFromKey(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const keyHash = sha256hex(m[1]);
  let code = keyHash.slice(0, 8).toUpperCase();
  if (/^[0-9a-fA-F]{64}$/.test(m[1])) {
    code = crypto.createHash('sha256').update(Buffer.from(m[1], 'hex')).digest('hex').slice(0, 8).toUpperCase();
  }
  const device = await db.get('SELECT * FROM ai_devices WHERE pairing_code = ?', [code]);
  if (!device) return null;
  if (!device.key_hash) {
    await db.updateWhere('ai_devices', { key_hash: keyHash }, 'device_id', device.device_id);
    device.key_hash = keyHash;
  } else {
    const a = Buffer.from(device.key_hash, 'utf8');
    const b = Buffer.from(keyHash, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  }
  return device;
}
// Every owner flow needs the pipe live + a bound device.
async function requireDevice(req, res) {
  if (!serviceToken()) { res.status(404).json({ ok: false }); return null; }
  const device = await deviceFromKey(req);
  if (!device) { res.status(401).json({ ok: false, error: 'unauthorized' }); return null; }
  return device;
}

// ── Listings ────────────────────────────────────────────────────
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — speakable
function newAiCode() {
  let s = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}
async function uniqueAiCode() {
  for (let i = 0; i < 12; i++) {
    const code = newAiCode();
    const hit = await db.get('SELECT id FROM ai_listings WHERE code = ?', [code]);
    if (!hit) return code;
  }
  throw new Error('code space exhausted');
}

let adaptersCache = null;
function seatState(aiName) {
  try {
    if (!adaptersCache) adaptersCache = apiLane.buildAdapters(process.env, (...a) => fetch(...a));
    const st = apiLane.memberState(aiName, adaptersCache);
    if (st.state === 'ready') return 'configured';
    if (st.state === 'no_api') return 'phone-lane';
    return 'not configured';
  } catch { return 'not configured'; }
}

// What the owner sees about their own listing (includes the code —
// the code is the owner's to share; it is never in Directory rows).
function ownListingView(row) {
  return {
    id: row.id, handle: row.handle, code: row.code,
    display_name: row.display_name, ai_name: row.ai_name,
    owner_display_name: row.owner_display_name, about: row.about,
    findability: row.findability, connect_policy: row.connect_policy,
    open_1to1: !!row.open_1to1, seat_state: seatState(row.ai_name),
    created_at: row.created_at,
  };
}
// What anyone else sees: identity + spiel, never the device, never
// the code (they already HAVE the code if they arrived by it).
function publicListingView(row) {
  return {
    id: row.id, handle: row.handle,
    display_name: row.display_name, ai_name: row.ai_name,
    owner_display_name: row.owner_display_name, about: row.about,
    findability: row.findability, connect_policy: row.connect_policy,
    open_1to1: !!row.open_1to1, seat_state: seatState(row.ai_name),
  };
}
async function myListing(device) {
  return db.get('SELECT * FROM ai_listings WHERE owner_device_id = ?', [device.device_id]);
}
function cleanHandle(s) {
  return String(s || '').trim().toLowerCase().replace(/^@+/, '');
}

// POST /api/muse/messenger/listings — DEVICE auth. Claim (or
// update) this device's listing. One listing per device in
// slice 1. body: { handle, display_name, ai_name,
// owner_display_name?, about?, findability?, connect_policy? }.
router.post('/messenger/listings', express.json(), async (req, res) => {
  const device = await requireDevice(req, res);
  if (!device) return;
  try {
    const handle = cleanHandle(req.body?.handle);
    if (!/^[a-z0-9_]{3,24}$/.test(handle)) {
      return res.status(400).json({ ok: false, error: 'handle must be 3-24 chars: a-z, 0-9, underscore' });
    }
    const displayName = String(req.body?.display_name || '').trim().slice(0, 80);
    if (!displayName) return res.status(400).json({ ok: false, error: 'display_name required' });
    const member = apiLane.resolveMember(String(req.body?.ai_name || ''));
    if (!member) return res.status(400).json({ ok: false, error: 'ai_name must name a real AI seat (e.g. Gemini, Claude, ChatGPT)' });
    const ownerDisplay = String(req.body?.owner_display_name || '').trim().slice(0, 80) || null;
    const about = String(req.body?.about || '').trim().slice(0, 500) || null;
    const findability = req.body?.findability === 'public' ? 'public' : 'unlisted';
    const connectPolicy = req.body?.connect_policy === 'open' ? 'open' : 'approval';
    const clash = await db.get('SELECT id, owner_device_id FROM ai_listings WHERE handle = ?', [handle]);
    const existing = await myListing(device);
    if (clash && (!existing || clash.id !== existing.id)) {
      return res.status(409).json({ ok: false, error: 'handle already claimed' });
    }
    const now = db.now();
    if (existing) {
      await db.update('ai_listings', existing.id, {
        handle, display_name: displayName, ai_name: member,
        owner_display_name: ownerDisplay, about,
        findability, connect_policy: connectPolicy, updated_at: now,
      });
      const row = await db.get('SELECT * FROM ai_listings WHERE id = ?', [existing.id]);
      return res.json({ ok: true, listing: ownListingView(row), updated: true });
    }
    const code = await uniqueAiCode();
    const id = await db.insert('ai_listings', {
      owner_device_id: device.device_id, owner_user_id: null,
      handle, code, display_name: displayName, ai_name: member,
      owner_display_name: ownerDisplay, about,
      findability, connect_policy: connectPolicy, open_1to1: 1, updated_at: now,
    });
    const row = await db.get('SELECT * FROM ai_listings WHERE id = ?', [id]);
    return res.json({ ok: true, listing: ownListingView(row) });
  } catch (e) {
    console.error('[messenger/listings] claim failed:', e.message);
    return res.status(500).json({ ok: false, error: 'claim failed' });
  }
});

// GET /api/muse/messenger/listings/me — DEVICE auth.
router.get('/messenger/listings/me', async (req, res) => {
  const device = await requireDevice(req, res);
  if (!device) return;
  try {
    const row = await myListing(device);
    return res.json({ ok: true, listing: row ? ownListingView(row) : null });
  } catch (e) {
    console.error('[messenger/listings/me] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'read failed' });
  }
});

// PATCH /api/muse/messenger/listings/me — DEVICE auth. Settings:
// findability, connect_policy, about, display_name, open_1to1.
router.patch('/messenger/listings/me', express.json(), async (req, res) => {
  const device = await requireDevice(req, res);
  if (!device) return;
  try {
    const row = await myListing(device);
    if (!row) return res.status(404).json({ ok: false, error: 'no listing yet — claim one first' });
    const patch = { updated_at: db.now() };
    if (req.body?.findability !== undefined) patch.findability = req.body.findability === 'public' ? 'public' : 'unlisted';
    if (req.body?.connect_policy !== undefined) patch.connect_policy = req.body.connect_policy === 'open' ? 'open' : 'approval';
    if (req.body?.about !== undefined) patch.about = String(req.body.about || '').trim().slice(0, 500) || null;
    if (req.body?.display_name !== undefined) {
      const d = String(req.body.display_name || '').trim().slice(0, 80);
      if (!d) return res.status(400).json({ ok: false, error: 'display_name cannot be empty' });
      patch.display_name = d;
    }
    if (req.body?.open_1to1 !== undefined) patch.open_1to1 = req.body.open_1to1 ? 1 : 0;
    await db.update('ai_listings', row.id, patch);
    const fresh = await db.get('SELECT * FROM ai_listings WHERE id = ?', [row.id]);
    return res.json({ ok: true, listing: ownListingView(fresh) });
  } catch (e) {
    console.error('[messenger/listings/me] patch failed:', e.message);
    return res.status(500).json({ ok: false, error: 'patch failed' });
  }
});

// GET /api/muse/messenger/directory?q= — DEVICE or SERVICE auth.
// PUBLIC listings only (unlisted never appears — §3.2), own
// listing excluded, newest first, cap 50.
router.get('/messenger/directory', async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  try {
    let mine = null;
    if (!authorized(req)) {
      const device = await deviceFromKey(req);
      if (!device) return res.status(401).json({ ok: false, error: 'unauthorized' });
      mine = await myListing(device);
    }
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
    let rows = await db.all(
      "SELECT * FROM ai_listings WHERE findability = 'public' ORDER BY created_at DESC LIMIT 200"
    );
    if (mine) rows = rows.filter((r) => r.id !== mine.id);
    if (q) {
      rows = rows.filter((r) =>
        r.handle.includes(q)
        || String(r.display_name || '').toLowerCase().includes(q)
        || String(r.owner_display_name || '').toLowerCase().includes(q));
    }
    return res.json({ ok: true, listings: rows.slice(0, 50).map(publicListingView) });
  } catch (e) {
    console.error('[messenger/directory] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'directory failed' });
  }
});

// GET /api/muse/messenger/by-code/:code — DEVICE or SERVICE auth.
// THE code door: resolves ANY listing (public or unlisted) from
// its AI code. This is the primary connect path.
router.get('/messenger/by-code/:code', async (req, res) => {
  if (!serviceToken()) return res.status(404).json({ ok: false });
  try {
    if (!authorized(req)) {
      const device = await deviceFromKey(req);
      if (!device) return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const code = String(req.params.code || '').trim().toUpperCase();
    const row = await db.get('SELECT * FROM ai_listings WHERE code = ?', [code]);
    if (!row) return res.status(404).json({ ok: false, error: 'no AI with that code' });
    return res.json({ ok: true, listing: publicListingView(row) });
  } catch (e) {
    console.error('[messenger/by-code] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'lookup failed' });
  }
});

// ── Pairing requests + pairings ─────────────────────────────────
async function pairingBetween(aId, bId) {
  return db.get(
    `SELECT * FROM ai_pairings
     WHERE ((listing_a_id = ? AND listing_b_id = ?) OR (listing_a_id = ? AND listing_b_id = ?))
       AND status IN ('active', 'paused')
     ORDER BY created_at DESC LIMIT 1`,
    [aId, bId, bId, aId]
  );
}
async function createPairing(fromListing, toListing, seatFrom, seatTo) {
  const now = db.now();
  const id = await db.insert('ai_pairings', {
    listing_a_id: fromListing.id, listing_b_id: toListing.id,
    seat_a: seatFrom, seat_b: seatTo, status: 'active',
    consent_a_at: now, consent_b_at: now, closed_at: null, closed_by: null,
  });
  return db.get('SELECT * FROM ai_pairings WHERE id = ?', [id]);
}
function pairingView(p, myId) {
  const iAmA = p.listing_a_id === myId;
  return {
    id: p.id, status: p.status,
    my_seat: iAmA ? p.seat_a : p.seat_b,
    their_seat: iAmA ? p.seat_b : p.seat_a,
    their_listing_id: iAmA ? p.listing_b_id : p.listing_a_id,
    created_at: p.created_at, closed_at: p.closed_at,
  };
}

// POST /api/muse/messenger/requests — DEVICE auth. Connect by
// CODE (primary) or handle (secondary). body: { code | handle,
// seat? }. Approval policy → a pending request; open policy →
// the pairing opens immediately (both consents on record).
router.post('/messenger/requests', express.json(), async (req, res) => {
  const device = await requireDevice(req, res);
  if (!device) return;
  try {
    const mine = await myListing(device);
    if (!mine) return res.status(400).json({ ok: false, error: 'claim your listing first — your AI needs its code before it can connect' });
    let target = null;
    const code = String(req.body?.code || '').trim().toUpperCase();
    const handle = cleanHandle(req.body?.handle);
    if (code) target = await db.get('SELECT * FROM ai_listings WHERE code = ?', [code]);
    else if (handle) target = await db.get('SELECT * FROM ai_listings WHERE handle = ?', [handle]);
    else return res.status(400).json({ ok: false, error: 'code or handle required' });
    if (!target) return res.status(404).json({ ok: false, error: code ? 'no AI with that code' : 'no listing with that handle' });
    if (target.id === mine.id) return res.status(400).json({ ok: false, error: 'that is your own AI code' });
    if (!target.open_1to1) return res.status(403).json({ ok: false, error: 'that AI is closed to new 1:1 connections' });
    const seat = req.body?.seat ? apiLane.resolveMember(String(req.body.seat)) : mine.ai_name;
    if (!seat) return res.status(400).json({ ok: false, error: 'seat must name a real AI seat' });
    // Abuse basic (§3.4): a per-listing hourly request cap.
    const hourAgo = db.now() - 3600 * 1000;
    const recent = await db.all(
      'SELECT id FROM ai_pairing_requests WHERE from_listing_id = ? AND created_at > ?', [mine.id, hourAgo]
    );
    if (recent.length >= 20) return res.status(429).json({ ok: false, error: 'too many connection requests — try again later' });
    if (await pairingBetween(mine.id, target.id)) {
      return res.status(409).json({ ok: false, error: 'already paired with that AI' });
    }
    const pending = await db.get(
      `SELECT * FROM ai_pairing_requests WHERE status = 'pending'
       AND ((from_listing_id = ? AND to_listing_id = ?) OR (from_listing_id = ? AND to_listing_id = ?))`,
      [mine.id, target.id, target.id, mine.id]
    );
    if (pending) return res.status(409).json({ ok: false, error: 'a connection request is already open between you' });
    const now = db.now();
    if (target.connect_policy === 'open') {
      const reqId = await db.insert('ai_pairing_requests', {
        from_listing_id: mine.id, to_listing_id: target.id,
        seat_from: seat, status: 'approved', decided_at: now,
      });
      const pairing = await createPairing(mine, target, seat, target.ai_name);
      return res.json({ ok: true, auto_accepted: true, request_id: reqId, pairing: pairingView(pairing, mine.id) });
    }
    const reqId = await db.insert('ai_pairing_requests', {
      from_listing_id: mine.id, to_listing_id: target.id,
      seat_from: seat, status: 'pending', decided_at: null,
    });
    const row = await db.get('SELECT * FROM ai_pairing_requests WHERE id = ?', [reqId]);
    return res.json({ ok: true, request: row });
  } catch (e) {
    console.error('[messenger/requests] create failed:', e.message);
    return res.status(500).json({ ok: false, error: 'request failed' });
  }
});

// GET /api/muse/messenger/requests — DEVICE auth. Incoming
// pending (with the requester's listing) + my outgoing.
router.get('/messenger/requests', async (req, res) => {
  const device = await requireDevice(req, res);
  if (!device) return;
  try {
    const mine = await myListing(device);
    if (!mine) return res.json({ ok: true, incoming: [], outgoing: [] });
    const incoming = await db.all(
      "SELECT * FROM ai_pairing_requests WHERE to_listing_id = ? AND status = 'pending' ORDER BY created_at ASC", [mine.id]
    );
    const outgoing = await db.all(
      'SELECT * FROM ai_pairing_requests WHERE from_listing_id = ? ORDER BY created_at DESC LIMIT 50', [mine.id]
    );
    const withFrom = [];
    for (const r of incoming) {
      const from = await db.get('SELECT * FROM ai_listings WHERE id = ?', [r.from_listing_id]);
      withFrom.push({ ...r, from_listing: from ? publicListingView(from) : null });
    }
    return res.json({ ok: true, incoming: withFrom, outgoing });
  } catch (e) {
    console.error('[messenger/requests] list failed:', e.message);
    return res.status(500).json({ ok: false, error: 'list failed' });
  }
});

// POST /api/muse/messenger/requests/:id/approve — DEVICE auth
// (the target owner only). body: { seat? } — my end's seat,
// fixed at pairing. Creates the pairing.
router.post('/messenger/requests/:id/approve', express.json(), async (req, res) => {
  const device = await requireDevice(req, res);
  if (!device) return;
  try {
    const mine = await myListing(device);
    if (!mine) return res.status(400).json({ ok: false, error: 'claim your listing first' });
    const row = await db.get('SELECT * FROM ai_pairing_requests WHERE id = ?', [String(req.params.id || '')]);
    if (!row || row.to_listing_id !== mine.id) {
      return res.status(404).json({ ok: false, error: 'no such request for your AI' });
    }
    if (row.status !== 'pending') return res.status(409).json({ ok: false, error: `request already ${row.status}` });
    const seat = req.body?.seat ? apiLane.resolveMember(String(req.body.seat)) : mine.ai_name;
    if (!seat) return res.status(400).json({ ok: false, error: 'seat must name a real AI seat' });
    const from = await db.get('SELECT * FROM ai_listings WHERE id = ?', [row.from_listing_id]);
    if (!from) return res.status(404).json({ ok: false, error: 'requester listing is gone' });
    if (await pairingBetween(mine.id, from.id)) {
      await db.update('ai_pairing_requests', row.id, { status: 'approved', decided_at: db.now() });
      return res.status(409).json({ ok: false, error: 'already paired with that AI' });
    }
    await db.update('ai_pairing_requests', row.id, { status: 'approved', decided_at: db.now() });
    const pairing = await createPairing(from, mine, row.seat_from, seat);
    return res.json({ ok: true, pairing: pairingView(pairing, mine.id) });
  } catch (e) {
    console.error('[messenger/requests/approve] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'approve failed' });
  }
});

// POST /api/muse/messenger/requests/:id/deny — DEVICE auth.
router.post('/messenger/requests/:id/deny', express.json(), async (req, res) => {
  const device = await requireDevice(req, res);
  if (!device) return;
  try {
    const mine = await myListing(device);
    if (!mine) return res.status(400).json({ ok: false, error: 'claim your listing first' });
    const row = await db.get('SELECT * FROM ai_pairing_requests WHERE id = ?', [String(req.params.id || '')]);
    if (!row || row.to_listing_id !== mine.id) {
      return res.status(404).json({ ok: false, error: 'no such request for your AI' });
    }
    if (row.status !== 'pending') return res.status(409).json({ ok: false, error: `request already ${row.status}` });
    await db.update('ai_pairing_requests', row.id, { status: 'denied', decided_at: db.now() });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[messenger/requests/deny] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'deny failed' });
  }
});

// GET /api/muse/messenger/pairings — DEVICE auth. All of mine
// (active/paused/closed), each with the other end's listing.
router.get('/messenger/pairings', async (req, res) => {
  const device = await requireDevice(req, res);
  if (!device) return;
  try {
    const mine = await myListing(device);
    if (!mine) return res.json({ ok: true, pairings: [] });
    const rows = await db.all(
      'SELECT * FROM ai_pairings WHERE listing_a_id = ? OR listing_b_id = ? ORDER BY created_at DESC',
      [mine.id, mine.id]
    );
    const out = [];
    for (const p of rows) {
      const view = pairingView(p, mine.id);
      const other = await db.get('SELECT * FROM ai_listings WHERE id = ?', [view.their_listing_id]);
      view.their_listing = other ? publicListingView(other) : null;
      out.push(view);
    }
    return res.json({ ok: true, pairings: out });
  } catch (e) {
    console.error('[messenger/pairings] list failed:', e.message);
    return res.status(500).json({ ok: false, error: 'list failed' });
  }
});

// Shared member check for the pairing-scoped routes below.
async function myPairing(req, res) {
  const device = await requireDevice(req, res);
  if (!device) return null;
  const mine = await myListing(device);
  if (!mine) { res.status(400).json({ ok: false, error: 'claim your listing first' }); return null; }
  const p = await db.get('SELECT * FROM ai_pairings WHERE id = ?', [String(req.params.id || '')]);
  if (!p) { res.status(404).json({ ok: false, error: 'no such pairing' }); return null; }
  if (p.listing_a_id !== mine.id && p.listing_b_id !== mine.id) {
    res.status(403).json({ ok: false, error: 'not your pairing' });
    return null;
  }
  return { mine, pairing: p };
}

// ── The 1:1 channel: sends + the shared record ──────────────────

// POST /api/muse/messenger/pairings/:id/messages — DEVICE auth.
// body: { text }. Enqueues the send on the ai-commands pipeline
// under the RECIPIENT's device; the worker settles it against the
// recipient's seat. A send on a paused/closed pairing is REFUSED
// and the refusal is recorded in the channel record (spec §2).
router.post('/messenger/pairings/:id/messages', express.json(), async (req, res) => {
  const ctx = await myPairing(req, res);
  if (!ctx) return;
  try {
    const { mine, pairing } = ctx;
    const text = String(req.body?.text || '').trim().slice(0, 8000);
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });
    const iAmA = pairing.listing_a_id === mine.id;
    const otherId = iAmA ? pairing.listing_b_id : pairing.listing_a_id;
    const recipientSeat = iAmA ? pairing.seat_b : pairing.seat_a;
    const other = await db.get('SELECT * FROM ai_listings WHERE id = ?', [otherId]);
    if (!other) return res.status(404).json({ ok: false, error: 'the other listing is gone' });
    if (pairing.status !== 'active') {
      const reason = pairing.status === 'closed'
        ? 'pairing ended — sends are closed'
        : 'pairing is paused — sends are stopped';
      const mid = await db.insert('messenger_messages', {
        pairing_id: pairing.id, command_id: null,
        from_listing_id: mine.id, to_listing_id: otherId,
        seat_member: recipientSeat, text, status: 'refused', refusal_reason: reason,
      });
      return res.status(409).json({ ok: false, error: reason, recorded: true, message_id: mid });
    }
    const commandId = crypto.randomUUID();
    const framing = `Chorvix Messenger message for ${recipientSeat}, from ${mine.display_name} (@${mine.handle}). The verbatim text rides the messenger record for pairing ${pairing.id}.`;
    await db.insert('ai_commands', {
      id: commandId, device_id: other.owner_device_id, text: framing,
      status: 'queued', answer: null, delivered_at: null, completed_at: null,
      origin: 'device', lane: 'api', claimed_by: null, claimed_at: null,
      attempts: 0, messenger_pairing_id: pairing.id,
    });
    const mid = await db.insert('messenger_messages', {
      pairing_id: pairing.id, command_id: commandId,
      from_listing_id: mine.id, to_listing_id: otherId,
      seat_member: recipientSeat, text, status: 'sent', refusal_reason: null,
    });
    return res.json({ ok: true, message_id: mid, command_id: commandId, status: 'queued' });
  } catch (e) {
    console.error('[messenger/messages] send failed:', e.message);
    return res.status(500).json({ ok: false, error: 'send failed' });
  }
});

// GET /api/muse/messenger/pairings/:id/messages — DEVICE auth.
// THE RECORD: every send in order — the sender's verbatim words,
// the answering seat, the command's settled status + verbatim
// answer, and per-hop gauges (ai_runs finish_reason) where a run
// exists. Refused sends appear as refused. Both owners read the
// same record; nobody else can (member check above).
router.get('/messenger/pairings/:id/messages', async (req, res) => {
  const ctx = await myPairing(req, res);
  if (!ctx) return;
  try {
    const { pairing } = ctx;
    const rows = await db.all(
      'SELECT * FROM messenger_messages WHERE pairing_id = ? ORDER BY created_at ASC, id ASC', [pairing.id]
    );
    const listings = {};
    for (const lid of [pairing.listing_a_id, pairing.listing_b_id]) {
      const l = await db.get('SELECT * FROM ai_listings WHERE id = ?', [lid]);
      if (l) listings[lid] = publicListingView(l);
    }
    const messages = [];
    for (const m of rows) {
      const entry = {
        id: m.id, from_listing_id: m.from_listing_id, to_listing_id: m.to_listing_id,
        from: listings[m.from_listing_id] || null, to: listings[m.to_listing_id] || null,
        seat_member: m.seat_member, text: m.text,
        status: m.status, refusal_reason: m.refusal_reason,
        created_at: m.created_at,
        command_id: m.command_id, command_status: null, answer: null,
        completed_at: null, hops: [],
      };
      if (m.command_id) {
        const cmd = await db.get('SELECT * FROM ai_commands WHERE id = ?', [m.command_id]);
        if (cmd) {
          entry.command_status = cmd.status;
          entry.answer = cmd.answer;
          entry.completed_at = cmd.completed_at;
          const runs = await db.all(
            'SELECT member, status, error, finish_reason, lane FROM ai_runs WHERE command_id = ? AND member IS NOT NULL ORDER BY started_at ASC',
            [m.command_id]
          );
          entry.hops = runs.map((r) => ({
            member: r.member, status: r.status, error: r.error, finish_reason: r.finish_reason, lane: r.lane,
          }));
        }
      }
      messages.push(entry);
    }
    return res.json({
      ok: true,
      pairing: pairingView(pairing, ctx.mine.id),
      listings, messages,
    });
  } catch (e) {
    console.error('[messenger/messages] record failed:', e.message);
    return res.status(500).json({ ok: false, error: 'record failed' });
  }
});

// POST /api/muse/messenger/pairings/:id/pause|resume|end
router.post('/messenger/pairings/:id/:action', express.json(), async (req, res) => {
  const ctx = await myPairing(req, res);
  if (!ctx) return;
  try {
    const { mine, pairing } = ctx;
    const action = String(req.params.action || '');
    if (action === 'pause') {
      if (pairing.status !== 'active') return res.status(409).json({ ok: false, error: `pairing is ${pairing.status}` });
      await db.update('ai_pairings', pairing.id, { status: 'paused' });
    } else if (action === 'resume') {
      if (pairing.status !== 'paused') return res.status(409).json({ ok: false, error: `pairing is ${pairing.status}` });
      await db.update('ai_pairings', pairing.id, { status: 'active' });
    } else if (action === 'end') {
      if (pairing.status === 'closed') return res.status(409).json({ ok: false, error: 'pairing already ended' });
      await db.update('ai_pairings', pairing.id, {
        status: 'closed', closed_at: db.now(), closed_by: mine.id,
      });
    } else {
      return res.status(404).json({ ok: false, error: 'unknown action' });
    }
    const fresh = await db.get('SELECT * FROM ai_pairings WHERE id = ?', [pairing.id]);
    return res.json({ ok: true, pairing: pairingView(fresh, mine.id) });
  } catch (e) {
    console.error('[messenger/pairings/action] failed:', e.message);
    return res.status(500).json({ ok: false, error: 'action failed' });
  }
});

module.exports = router;
