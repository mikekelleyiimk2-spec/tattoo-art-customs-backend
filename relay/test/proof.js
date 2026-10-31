/* brambleforce-relay local proof battery.
   Stands up: a stub seat-check server (token "good-token" -> 200
   {ok:true, display_name:"Proof Seat"}, anything else -> 401), relay A
   with RELAY_SEAT_CHECK_URL pointed at the stub, and relay B with NO
   seat check configured (safe mode). Then exercises: /health modes,
   pool-closed in safe mode, pool seat-required / seat-invalid, pool
   pairing (first waiter hosts, partner info from the seat), build
   separation in the pool, code-join pairing + input/snapshot
   forwarding + last-snapshot replay on reconnect, the build gate
   (version-mismatch naming both builds), dead-peer termination, and
   graceful SIGTERM shutdown. Exit 0 only if every check passes.     */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const PORT_A = 8796, PORT_B = 8797, PORT_STUB = 8798;
const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra ? ' :: ' + extra : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, body: d }); } });
    }).on('error', reject);
  });
}

function startRelay(port, env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'relay.js')], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('[relay:' + port + '] ' + d));
  child.stderr.on('data', (d) => process.stdout.write('[relay:' + port + '!] ' + d));
  return child;
}
async function waitHealth(port) {
  for (let i = 0; i < 60; i++) {
    try { const r = await getJSON(port, '/health'); if (r.status === 200) return r.body; } catch (e) {}
    await sleep(200);
  }
  throw new Error('relay on ' + port + ' never became healthy');
}

class Client {
  constructor(port, { ping = true } = {}) {
    this.ws = new WebSocket('ws://127.0.0.1:' + port);
    this.msgs = []; this.waiters = [];
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => !w(m));
    });
    this.open = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    if (ping) this.pinger = setInterval(() => { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ k: 'ping', t: Date.now() })); }, 1000);
    this.closed = new Promise((res) => this.ws.on('close', (c) => { clearInterval(this.pinger); res(c); }));
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  waitFor(pred, label, timeout = 5000) {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((res, rej) => {
      this.waiters.push((m) => { if (pred(m)) { res(m); return true; } return false; });
      setTimeout(() => rej(new Error('timeout waiting for ' + label + '; got [' + this.msgs.map((x) => x.k + (x.code ? ':' + x.code : '')).join(', ') + ']')), timeout);
    });
  }
  close() { clearInterval(this.pinger); try { this.ws.close(); } catch (e) {} }
}

async function main() {
  // stub seat check
  const stub = http.createServer((req, res) => {
    if (req.headers['x-api-token'] === 'good-token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, display_name: 'Proof Seat' }));
    } else {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not linked' }));
    }
  });
  await new Promise((r) => stub.listen(PORT_STUB, '127.0.0.1', r));

  const relayA = startRelay(PORT_A, { RELAY_SEAT_CHECK_URL: `http://127.0.0.1:${PORT_STUB}/api/onemind/seat` });
  const relayB = startRelay(PORT_B, { RELAY_DEAD_PEER_MS: '1500' });
  const clients = [];
  const C = (port, opts) => { const c = new Client(port, opts); clients.push(c); return c; };

  try {
    const hA = await waitHealth(PORT_A);
    const hB = await waitHealth(PORT_B);
    check('health A: ok + version + seatCheck=configured', hA.ok === true && typeof hA.version === 'string' && hA.seatCheck === 'configured', JSON.stringify(hA));
    check('health B: seatCheck=disabled-code-join-only (safe mode)', hB.ok === true && hB.seatCheck === 'disabled-code-join-only');

    // --- safe mode: pool closed even with a token presented
    const sb = C(PORT_B); await sb.open;
    sb.send({ k: 'hello', room: 'POOL', role: 'any', build: 'vc15', seatToken: 'good-token' });
    const sbErr = await sb.waitFor((m) => m.k === 'error', 'pool-closed error');
    check('safe mode: pool hello refused with pool-closed', sbErr.code === 'pool-closed', sbErr.code);
    sb.close();

    // --- pool seat gates (relay A)
    const noTok = C(PORT_A); await noTok.open;
    noTok.send({ k: 'hello', room: 'POOL', role: 'any', build: 'vc15' });
    const ntErr = await noTok.waitFor((m) => m.k === 'error', 'seat-required');
    check('pool: no token -> seat-required', ntErr.code === 'seat-required', ntErr.code);
    noTok.close();

    const badTok = C(PORT_A); await badTok.open;
    badTok.send({ k: 'hello', room: 'POOL', role: 'any', build: 'vc15', seatToken: 'bad-token' });
    const btErr = await badTok.waitFor((m) => m.k === 'error', 'seat-invalid');
    check('pool: bad token -> seat-invalid (fail closed)', btErr.code === 'seat-invalid', btErr.code);
    badTok.close();

    // --- pool pairing: first waiter hosts; input/snap forwarding
    const p1 = C(PORT_A); await p1.open;
    p1.send({ k: 'hello', room: 'POOL', role: 'any', build: 'vc15', seatToken: 'good-token', fighter: 'tor', skins: { tor: 'crt' } });
    const wait = await p1.waitFor((m) => m.k === 'pool-waiting', 'pool-waiting');
    check('pool: first validated client waits', wait.k === 'pool-waiting');
    const p2 = C(PORT_A); await p2.open;
    p2.send({ k: 'hello', room: 'POOL', role: 'any', build: 'vc15', seatToken: 'good-token', fighter: 'mara' });
    const pair1 = await p1.waitFor((m) => m.k === 'paired', 'p1 paired');
    const pair2 = await p2.waitFor((m) => m.k === 'paired', 'p2 paired');
    check('pool: paired, first waiter is host', pair1.role === 'host' && pair2.role === 'guest' && pair1.room === pair2.room, pair1.room);
    check('pool: partner info rides (seat name + fighter + skins)', pair2.partner && pair2.partner.name === 'Proof Seat' && pair2.partner.fighter === 'tor' && pair2.partner.skins && pair2.partner.skins.tor === 'crt', JSON.stringify(pair2.partner));
    p2.send({ k: 'input', seq: 1, v: { x: 1, fire: true } });
    const inp = await p1.waitFor((m) => m.k === 'input', 'input forwarded');
    check('pool: guest input forwarded to host', inp.seq === 1 && inp.v.x === 1);
    p1.send({ k: 'snap', tick: 7, p1: { x: 10 }, p2: { x: 20 } });
    const snap = await p2.waitFor((m) => m.k === 'snap', 'snap forwarded');
    check('pool: host snapshot forwarded to guest', snap.tick === 7);
    p1.close(); p2.close();

    // --- pool build separation: different builds never pair
    const w1 = C(PORT_A); await w1.open;
    w1.send({ k: 'hello', room: 'POOL', role: 'any', build: 'buildA', seatToken: 'good-token' });
    await w1.waitFor((m) => m.k === 'pool-waiting', 'w1 waiting');
    const w2 = C(PORT_A); await w2.open;
    w2.send({ k: 'hello', room: 'POOL', role: 'any', build: 'buildB', seatToken: 'good-token' });
    const w2msg = await w2.waitFor((m) => m.k === 'pool-waiting', 'w2 waiting (not paired across builds)');
    check('pool: different build waits instead of pairing', w2msg.k === 'pool-waiting' && !w1.msgs.some((m) => m.k === 'paired'));
    const w3 = C(PORT_A); await w3.open;
    w3.send({ k: 'hello', room: 'POOL', role: 'any', build: 'buildA', seatToken: 'good-token' });
    const w1pair = await w1.waitFor((m) => m.k === 'paired', 'w1 paired with same build');
    check('pool: same-build arrival pairs with the earlier waiter', w1pair.role === 'host');
    w1.close(); w2.close(); w3.close();

    // --- code-join (relay B, safe mode): pairing + forwarding + reconnect replay
    const host = C(PORT_B); await host.open;
    host.send({ k: 'hello', room: 'PROOF1', role: 'host', build: 'vc15', fighter: 'tor', name: 'Hosty' });
    const guest = C(PORT_B); await guest.open;
    guest.send({ k: 'hello', room: 'PROOF1', role: 'guest', build: 'vc15', fighter: 'mara' });
    const hp = await host.waitFor((m) => m.k === 'paired', 'host paired');
    const gp = await guest.waitFor((m) => m.k === 'paired', 'guest paired');
    check('code-join: paired without any seat (host vouches)', hp.role === 'host' && gp.role === 'guest');
    check('code-join: anonymous guest is "Player 2" with base skins', hp.partner && hp.partner.name === 'Player 2' && hp.partner.skins === null, JSON.stringify(hp.partner));
    guest.send({ k: 'input', seq: 9, v: { y: -1 } });
    const ci = await host.waitFor((m) => m.k === 'input', 'code input forwarded');
    check('code-join: input forwarded', ci.seq === 9);
    host.send({ k: 'snap', tick: 42, p1: { x: 1 }, p2: { x: 2 } });
    await guest.waitFor((m) => m.k === 'snap' && m.tick === 42, 'code snap forwarded');
    guest.close();
    await host.waitFor((m) => m.k === 'peer-left', 'host told peer-left');
    check('code-join: host sees peer-left when guest drops', true);
    const guest2 = C(PORT_B); await guest2.open;
    guest2.send({ k: 'hello', room: 'PROOF1', role: 'guest', build: 'vc15' });
    await guest2.waitFor((m) => m.k === 'paired', 'guest2 paired (reconnect)');
    const replay = await guest2.waitFor((m) => m.k === 'snap', 'last snapshot replayed');
    check('code-join: reconnecting guest lands on the last snapshot', replay.tick === 42, 'tick=' + replay.tick);
    guest2.close(); host.close();

    // --- build gate on code-join
    const vh = C(PORT_B); await vh.open;
    vh.send({ k: 'hello', room: 'VERB1', role: 'host', build: 'vc15' });
    const vg = C(PORT_B); await vg.open;
    vg.send({ k: 'hello', room: 'VERB1', role: 'guest', build: 'vc99' });
    const vmErr = await vg.waitFor((m) => m.k === 'error', 'version-mismatch');
    check('build gate: mismatched code-join refused, both builds named', vmErr.code === 'version-mismatch' && vmErr.yourBuild === 'vc99' && vmErr.roomBuild === 'vc15', JSON.stringify(vmErr));
    vh.close(); vg.close();

    // --- dead peer: a silent client is terminated (relay B threshold 1.5s)
    const dead = C(PORT_B, { ping: false }); await dead.open;
    dead.send({ k: 'hello', room: 'DEAD1', role: 'host', build: 'vc15' });
    const closeCode = await Promise.race([dead.closed, sleep(6000).then(() => null)]);
    check('dead peer: silent socket terminated by the sweep', closeCode !== null && closeCode !== undefined, 'close=' + closeCode);

    const hEnd = await getJSON(PORT_B, '/health');
    check('health: stats count version mismatches + dead peers', hEnd.body.stats.versionMismatch >= 1 && hEnd.body.stats.deadPeers >= 1, JSON.stringify(hEnd.body.stats));
  } catch (e) {
    check('battery ran to completion', false, e.message);
  } finally {
    for (const c of clients) c.close();
    const exitA = new Promise((r) => relayA.on('exit', r));
    const exitB = new Promise((r) => relayB.on('exit', r));
    relayA.kill('SIGTERM'); relayB.kill('SIGTERM');
    const [codeA, codeB] = await Promise.race([
      Promise.all([exitA, exitB]),
      sleep(6000).then(() => [null, null]),
    ]);
    check('graceful shutdown: both relays exit 0 on SIGTERM', codeA === 0 && codeB === 0, 'A=' + codeA + ' B=' + codeB);
    stub.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log('\nPROOF: ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('proof crashed:', e); process.exit(1); });