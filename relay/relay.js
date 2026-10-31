/* BRAMBLEFORCE ONLINE CO-OP — RELAY (production build)
   Dedicated always-on service (design doc §2: its own Render Starter,
   $7/mo, owner-approved 2026-10-31) — sessions and the cash register
   never share a fate.

   Deliberately dumb transport: it pairs two sockets into a room and
   forwards bytes. The HOST's game is the authority; the relay holds no
   game state beyond each room's last snapshot (kept so a reconnecting
   guest lands on the current picture, not a void, and so the relay can
   checkpoint a run's last known state — design doc §5.1).

   Pairing:
   - PLAYER POOL (room: "POOL"): FIFO, first waiter hosts. Seat-only:
     the hello's seat token is validated against the store backend
     (RELAY_SEAT_CHECK_URL -> GET /api/onemind/seat, x-api-token).
     If RELAY_SEAT_CHECK_URL is unset the pool is CLOSED (code-join
     only) — a validation that cannot run is never faked as a pass.
   - ROOM CODES: host creates a code room, guest joins by code. A guest
     may join a code room without a seat (host vouches; name is forced
     to "Player 2", skins to base — design doc §5.4). If a code-join
     hello PRESENTS a seat token and the check is configured, the token
     must validate or the join is refused.
   - BUILD GATE (§5.3, non-negotiable): pool pairs only equal builds;
     a code-join with a different build gets a plain version-mismatch
     naming both builds. One differing physics constant is a desync
     farm, so there is no override.

   Liveness: every inbound message refreshes the peer clock; 3s of
   silence (RELAY_DEAD_PEER_MS) = dead peer — terminated, partner told.
   Clients ping at 1 Hz (the game's session traffic is far denser).

   HTTP: GET /health -> version + room/pool counts + seat-check mode.
   Graceful shutdown on SIGTERM/SIGINT: partners are told, sockets
   close, process exits.                                        */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const VERSION = PKG.version;

const PORT = +(process.env.PORT || process.env.RELAY_PORT || 8791);
const SEAT_CHECK_URL = String(process.env.RELAY_SEAT_CHECK_URL || '').trim();
const SEAT_CHECK_TIMEOUT_MS = +(process.env.RELAY_SEAT_CHECK_TIMEOUT_MS || 3000);
const DEAD_PEER_MS = +(process.env.RELAY_DEAD_PEER_MS || 3000);
const HELLO_TIMEOUT_MS = +(process.env.RELAY_HELLO_TIMEOUT_MS || 10000);
const SEAT_CHECK_CONFIGURED = SEAT_CHECK_URL.length > 0;

const rooms = new Map(); // code -> {host, guest, lastSnap, build, createdAt}
const pool = [];         // validated sockets waiting for a partner (FIFO)
const stats = {
  paired: 0, inputs: 0, snaps: 0, pings: 0, sessions: 0,
  seatOk: 0, seatRejected: 0, seatCheckDown: 0,
  versionMismatch: 0, deadPeers: 0, started: Date.now(),
};

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* socket dying; close handler cleans up */ }
  }
}
function peerOf(ws) {
  const r = ws._room ? rooms.get(ws._room) : null;
  if (!r) return null;
  return ws._role === 'host' ? r.guest : r.host;
}
function partnerInfo(ws) {
  if (!ws) return null;
  return { name: ws._name || 'Player', fighter: ws._fighter || null, skins: ws._skins || null };
}

/* --- Seat validation -------------------------------------------------
   GET <RELAY_SEAT_CHECK_URL> with header x-api-token: <token>.
   200 + {ok:true} = a real seat. Anything else — 401, 500, timeout,
   network error — is NOT a pass; the two failure flavours are kept
   apart so a backend outage reads as "unavailable", not "invalid".  */
async function validateSeat(token) {
  if (!SEAT_CHECK_CONFIGURED) return { ok: false, reason: 'unconfigured' };
  if (!token) return { ok: false, reason: 'invalid' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEAT_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(SEAT_CHECK_URL, {
      method: 'GET',
      headers: { 'x-api-token': token, accept: 'application/json' },
      signal: ctl.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'invalid' };
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    const body = await res.json().catch(() => null);
    if (!body || body.ok !== true) return { ok: false, reason: 'invalid' };
    const s = body.seat || body;
    const name = s.display_name || s.name || s.username || null;
    return { ok: true, seatName: name };
  } catch (e) {
    return { ok: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

function seatError(ws, reason) {
  if (reason === 'unavailable') { stats.seatCheckDown++; return send(ws, { k: 'error', code: 'seat-check-unavailable', message: 'Seat check did not answer — try again in a moment.' }); }
  stats.seatRejected++;
  return send(ws, { k: 'error', code: 'seat-invalid', message: 'That seat did not check out. Sign in again and retry.' });
}

/* --- Pairing -------------------------------------------------------- */
function pairUp(host, guest, roomCode) {
  const room = { host, guest, lastSnap: null, build: host._build, createdAt: Date.now() };
  rooms.set(roomCode, room);
  host._room = roomCode; host._role = 'host';
  guest._room = roomCode; guest._role = 'guest';
  stats.paired++;
  send(host, { k: 'paired', room: roomCode, role: 'host', build: room.build, partner: partnerInfo(guest) });
  send(guest, { k: 'paired', room: roomCode, role: 'guest', build: room.build, partner: partnerInfo(host) });
  console.log(`[relay] paired room=${roomCode} build=${room.build} rooms=${rooms.size}`);
}

function tryPoolPair(newcomer) {
  // FIFO: the earliest waiter with the SAME build takes the host seat.
  const idx = pool.findIndex((s) => s.readyState === WebSocket.OPEN && s._build === newcomer._build);
  if (idx >= 0) {
    const waiter = pool.splice(idx, 1)[0];
    const roomCode = 'POOL-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    pairUp(waiter, newcomer, roomCode);
    return true;
  }
  pool.push(newcomer);
  send(newcomer, { k: 'pool-waiting' });
  return false;
}

async function handleHello(ws, m) {
  if (ws._helloDone) return; // one hello per socket
  const build = m.build == null ? '' : String(m.build).slice(0, 32);
  if (!build) {
    return send(ws, { k: 'error', code: 'bad-hello', message: 'hello must carry your game build — versions pair only with themselves.' });
  }
  ws._helloDone = true;
  ws._build = build;
  ws._fighter = m.fighter == null ? null : String(m.fighter).slice(0, 64);
  ws._skins = (m.skins && typeof m.skins === 'object') ? m.skins : null;
  ws._name = m.name == null ? null : String(m.name).slice(0, 48);
  const seatToken = typeof m.seatToken === 'string' ? m.seatToken : null;

  /* PLAYER POOL — seat-only (§5.4: the pool stays seat-only so a bad
     actor costs a real account). Unconfigured check = pool closed. */
  if (m.room === 'POOL') {
    if (!SEAT_CHECK_CONFIGURED) {
      console.warn('[relay] pool hello refused — seat check not configured (pool closed, code-join only)');
      return send(ws, { k: 'error', code: 'pool-closed', message: 'The player pool is closed right now — play together with a room code instead.' });
    }
    if (!seatToken) {
      return send(ws, { k: 'error', code: 'seat-required', message: 'The player pool needs a signed-in seat. Sign in, or join a friend with a room code.' });
    }
    const v = await validateSeat(seatToken);
    if (!v.ok) return seatError(ws, v.reason);
    stats.seatOk++;
    if (v.seatName) ws._name = v.seatName;
    if (ws.readyState !== WebSocket.OPEN) return; // died while validating
    tryPoolPair(ws);
    return;
  }

  /* ROOM CODE — host creates, guest joins. */
  const code = String(m.room || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
  if (!code) return send(ws, { k: 'error', code: 'bad-hello', message: 'hello needs a room code (or POOL).' });

  // A presented seat must prove itself when the check is configured;
  // no seat at all is fine by code (the host vouches — §5.4).
  if (seatToken && SEAT_CHECK_CONFIGURED) {
    const v = await validateSeat(seatToken);
    if (!v.ok) return seatError(ws, v.reason);
    stats.seatOk++;
    if (v.seatName) ws._name = v.seatName;
    if (ws.readyState !== WebSocket.OPEN) return;
  }
  if (!seatToken) { ws._name = null; ws._skins = null; } // anonymous: "Player 2", base skins

  let room = rooms.get(code);
  if (!room) {
    room = { host: null, guest: null, lastSnap: null, build, createdAt: Date.now() };
    rooms.set(code, room);
  }
  // Build gate: the room's build is set by whoever created it.
  if (room.build !== build) {
    stats.versionMismatch++;
    return send(ws, { k: 'error', code: 'version-mismatch', yourBuild: build, roomBuild: room.build, message: `Your game versions differ — yours is ${build}, the room is ${room.build}. Both update to the same build.` });
  }
  const wantHost = m.role === 'host' || (m.role !== 'guest' && !room.host);
  if (wantHost) {
    if (room.host && room.host !== ws) return send(ws, { k: 'error', code: 'room-full', seat: 'host', message: 'That room already has a host.' });
    room.host = ws; ws._room = code; ws._role = 'host';
  } else {
    if (room.guest && room.guest !== ws) return send(ws, { k: 'error', code: 'room-full', seat: 'guest', message: 'That room already has a second player.' });
    room.guest = ws; ws._room = code; ws._role = 'guest';
  }
  if (!ws._name) ws._name = ws._role === 'guest' ? 'Player 2' : 'Player 1';
  if (room.host && room.guest) {
    stats.paired++;
    send(room.host, { k: 'paired', room: code, role: 'host', build: room.build, partner: partnerInfo(room.guest) });
    send(room.guest, { k: 'paired', room: code, role: 'guest', build: room.build, partner: partnerInfo(room.host) });
    if (room.lastSnap) send(room.guest, room.lastSnap); // reconnect lands on the current picture
    console.log(`[relay] paired room=${code} build=${room.build} rooms=${rooms.size}`);
  }
}

/* --- Departure ------------------------------------------------------- */
function depart(ws, reason) {
  const pi = pool.indexOf(ws);
  if (pi >= 0) pool.splice(pi, 1);
  if (!ws._room) return;
  const code = ws._room;
  const room = rooms.get(code);
  const wasHost = ws._role === 'host';
  ws._room = null; ws._role = null;
  if (!room) return;
  if (room.host === ws) room.host = null;
  if (room.guest === ws) room.guest = null;
  const survivor = room.host || room.guest;
  if (survivor) send(survivor, { k: 'peer-left', reason: reason || 'left' });
  // Host gone = the run's authority is gone: dissolve the room (the
  // guest keeps its socket and may hello again). Guest gone = keep the
  // room + last snapshot so a reconnect lands mid-mission (§5.1).
  if (wasHost || !survivor) {
    if (survivor) { survivor._room = null; survivor._role = null; }
    rooms.delete(code);
  }
}

/* --- HTTP + WS servers ----------------------------------------------- */
const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (req.method === 'GET' && url === '/health') {
    const body = {
      ok: true,
      service: 'brambleforce-relay',
      version: VERSION,
      uptime_s: Math.round((Date.now() - stats.started) / 1000),
      rooms: rooms.size,
      poolWaiting: pool.length,
      seatCheck: SEAT_CHECK_CONFIGURED ? 'configured' : 'disabled-code-join-only',
      stats: {
        paired: stats.paired, inputs: stats.inputs, snaps: stats.snaps,
        seatOk: stats.seatOk, seatRejected: stats.seatRejected,
        versionMismatch: stats.versionMismatch, deadPeers: stats.deadPeers,
      },
      now: Date.now(),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('brambleforce-relay — Brambleforce online co-op relay. Connect a game client over WebSocket.\n');
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

const wss = new WebSocket.Server({ server, maxPayload: 256 * 1024 });

wss.on('connection', (ws) => {
  ws._room = null; ws._role = null; ws._helloDone = false;
  ws._build = null; ws._name = null; ws._fighter = null; ws._skins = null;
  ws._lastSeen = Date.now();
  ws._helloTimer = setTimeout(() => {
    if (!ws._helloDone) { try { ws.terminate(); } catch (e) {} }
  }, HELLO_TIMEOUT_MS);

  ws.on('message', (raw) => {
    ws._lastSeen = Date.now();
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.k !== 'string') return;
    if (m.k === 'hello') { handleHello(ws, m).catch((e) => console.error('[relay] hello failed:', e.message)); return; }
    if (m.k === 'ping') {
      stats.pings++;
      const peer = peerOf(ws);
      if (peer) send(peer, m); else send(ws, { k: 'pong', t: m.t }); // waiting alone: the relay itself answers
      return;
    }
    if (m.k === 'pong') { const peer = peerOf(ws); if (peer) send(peer, m); return; }
    if (m.k === 'quit') { depart(ws, 'quit'); try { ws.close(1000, 'quit'); } catch (e) {} return; }
    if (!ws._room) return;
    const room = rooms.get(ws._room);
    if (!room) return;
    if (m.k === 'input') {
      if (ws._role !== 'guest') return; // inputs flow guest -> host only
      stats.inputs++; send(room.host, m);
    } else if (m.k === 'snap') {
      if (ws._role !== 'host') return; // snapshots flow host -> guest only
      stats.snaps++; room.lastSnap = m; send(room.guest, m);
    } else if (m.k === 'session') {
      stats.sessions++; const peer = peerOf(ws); if (peer) send(peer, m);
    }
  });
  ws.on('pong', () => { ws._lastSeen = Date.now(); });
  ws.on('close', () => { clearTimeout(ws._helloTimer); depart(ws, 'disconnected'); });
  ws.on('error', () => { /* close handler follows */ });
});

/* Dead-peer sweep: 3s of silence = dead (§5.1 detection rule). */
const sweep = setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (now - (ws._lastSeen || now) > DEAD_PEER_MS) {
      stats.deadPeers++;
      depart(ws, 'timeout');
      try { ws.terminate(); } catch (e) {}
    }
  }
}, 1000);

/* Graceful shutdown: tell everyone, close clean, exit promptly. */
let closing = false;
function shutdown(signal) {
  if (closing) return; closing = true;
  console.log(`[relay] ${signal} — shutting down gracefully (${wss.clients.size} sockets, ${rooms.size} rooms)`);
  clearInterval(sweep);
  for (const ws of wss.clients) {
    send(ws, { k: 'error', code: 'server-closing', message: 'The relay is restarting — reconnect in a few seconds.' });
    try { ws.close(1001, 'server closing'); } catch (e) {}
  }
  wss.close(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[relay] brambleforce-relay v${VERSION} listening on :${PORT} (ws + /health)`);
  if (SEAT_CHECK_CONFIGURED) {
    console.log(`[relay] seat check CONFIGURED -> ${SEAT_CHECK_URL} (pool open to validated seats)`);
  } else {
    console.warn('[relay] *** RELAY_SEAT_CHECK_URL IS NOT SET — PLAYER POOL IS CLOSED (code-join only). Set RELAY_SEAT_CHECK_URL to the backend seat endpoint to open the pool. ***');
  }
});
