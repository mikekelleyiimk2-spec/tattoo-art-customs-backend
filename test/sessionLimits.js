// Concurrent-session (device) limit tests.
// DB phase (runDbTests) runs before db.close(); HTTP phase (runHttpTests)
// runs against the spawned server with separate cookie jars per "device".
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const limits = require('../src/lib/sessionLimits');
const mail = require('../src/lib/mail');

const BASE = 'http://localhost:4137';

async function mkUser(email, role = 'customer', extra = {}) {
  return db.insert('users', {
    email, password_hash: bcrypt.hashSync('password123', 4), role,
    display_name: email.split('@')[0], created_at: db.now(), email_verified: 1,
    ...extra,
  });
}

function mkSession(userId, sid, expiresInMs, device) {
  return db.insert('sessions', {
    id: sid, user_id: userId,
    data: JSON.stringify({ userId, device: device || { ua: 'TestAgent', ip: '1.2.3.4', at: Date.now() } }),
    expires_at: Date.now() + expiresInMs,
  });
}

function fakeReq(userId, sid) {
  return {
    session: { userId },
    sessionID: sid,
    ip: '9.9.9.9',
    headers: { 'user-agent': 'FakeDevice/1.0' },
    get(name) { return this.headers[String(name).toLowerCase()]; },
  };
}

async function runDbTests(ok) {
  console.log('session limits:');

  // --- caps per plan ---
  const shop = await mkUser('slshop@test.local', 'tattoo_shop');
  const artist = await mkUser('slartist@test.local', 'design_artist');
  const customer = await mkUser('slcust@test.local', 'customer');
  const admin = await mkUser('sladmin@test.local', 'admin');
  const head = await mkUser('slhead@test.local', 'head_admin');
  const pop = await mkUser('slpop@test.local', 'design_artist', { population_admin: 1 });
  // Fixture admins must not leak: later tests count per-admin notification
  // fanout against the original admin set, so every admin-role fixture is
  // removed in the finally block below.
  const adminish = [admin, head];
  ok((await limits.capForUserId(shop)).cap === 3, 'tattoo_shop cap is 3');
  ok((await limits.capForUserId(artist)).cap === 2, 'design_artist cap is 2');
  ok((await limits.capForUserId(customer)).cap === 2, 'customer/member cap is 2');
  ok((await limits.capForUserId(admin)).cap === 3, 'staff admin cap is 3');
  ok((await limits.capForUserId(head)).exempt === true, 'head_admin is exempt');
  ok((await limits.capForUserId(pop)).exempt === true, 'population_admin is exempt');

  // --- user-agent parsing ---
  ok(limits.parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1') === 'Safari on iPhone', 'UA parses to Safari on iPhone');
  ok(limits.parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36') === 'Chrome on Windows', 'UA parses to Chrome on Windows');
  ok(limits.parseUserAgent('') === 'Unknown device', 'empty UA is Unknown device');

  // --- eviction: oldest-first, alert email fires ---
  const sent = [];
  mail.__setTransporter({ sendMail: async (m) => { sent.push(m); return { messageId: 'stub' }; } });
  try {
    const u = await mkUser('slevict@test.local', 'design_artist'); // cap 2
    await mkSession(u, 'oldest-sid', 10 * 86400000); // expires soonest = oldest
    await mkSession(u, 'newer-sid', 13 * 86400000);
    const res = await limits.enforceSessionCap(fakeReq(u, 'brand-new-sid'));
    ok(res.enforced && res.evicted.length === 1, 'at cap (2 existing, cap 2): one session evicted for the new login');
    ok(!(await db.get('SELECT id FROM sessions WHERE id = ?', ['oldest-sid'])), 'oldest session evicted first');
    ok(await db.get('SELECT id FROM sessions WHERE id = ?', ['newer-sid']), 'newer session kept');
    ok(sent.length === 1 && /oldest session was signed out/i.test(sent[0].text),
      'eviction fires the "new sign-in — oldest session signed out" email alert');

    // under cap: nothing evicted, no email
    sent.length = 0;
    const u2 = await mkUser('slunder@test.local', 'design_artist');
    await mkSession(u2, 'only-sid', 13 * 86400000);
    const res2 = await limits.enforceSessionCap(fakeReq(u2, 'fresh-sid'));
    ok(res2.enforced && res2.evicted.length === 0, 'under cap: no eviction');
    ok(sent.length === 0, 'no alert email when nothing was evicted');

    // eviction order with several over the cap: strict oldest-first
    const u3 = await mkUser('slorder@test.local', 'design_artist'); // cap 2
    await mkSession(u3, 's1', 5 * 86400000);
    await mkSession(u3, 's2', 6 * 86400000);
    await mkSession(u3, 's3', 7 * 86400000);
    await mkSession(u3, 's4', 8 * 86400000);
    const res3 = await limits.enforceSessionCap(fakeReq(u3, 's-new'));
    ok(res3.evicted.length === 3, '4 existing over cap 2: three evicted');
    ok(!(await db.get('SELECT id FROM sessions WHERE id IN (?, ?, ?)', ['s1', 's2', 's3'])) &&
       (await db.get('SELECT id FROM sessions WHERE id = ?', ['s4'])),
      'eviction order is oldest-first (expires_at ASC)');

    // current session is never evicted even if it is the oldest row
    const u4 = await mkUser('slcur@test.local', 'design_artist');
    await mkSession(u4, 'cur-sid', 1 * 86400000); // the current session, oldest expires_at
    await mkSession(u4, 'other1', 10 * 86400000);
    await mkSession(u4, 'other2', 11 * 86400000);
    const res4 = await limits.enforceSessionCap(fakeReq(u4, 'cur-sid'));
    ok(await db.get('SELECT id FROM sessions WHERE id = ?', ['cur-sid']), 'current session never evicted');
    ok(res4.evicted.length === 1 && !(await db.get('SELECT id FROM sessions WHERE id = ?', ['other1'])),
      'eviction skips the current session and takes the next-oldest');

    // expired sessions are not counted
    const u5 = await mkUser('slexp@test.local', 'design_artist');
    await mkSession(u5, 'dead-sid', -1000);
    await mkSession(u5, 'live-sid', 13 * 86400000);
    const res5 = await limits.enforceSessionCap(fakeReq(u5, 'newbie'));
    ok(res5.evicted.length === 0, 'expired sessions do not count toward the cap');

    // --- exemptions: no eviction, no email ---
    sent.length = 0;
    const hu = await mkUser('slhead2@test.local', 'head_admin');
    adminish.push(hu);
    for (let i = 0; i < 5; i++) await mkSession(hu, `hs${i}`, 13 * 86400000);
    const hr = await limits.enforceSessionCap(fakeReq(hu, 'hs-new'));
    ok(hr.exempt && (await db.all('SELECT id FROM sessions WHERE user_id = ?', [hu])).length === 5,
      'head_admin: 5 sessions untouched');
    const pu = await mkUser('slpop2@test.local', 'design_artist', { population_admin: 1 });
    for (let i = 0; i < 5; i++) await mkSession(pu, `ps${i}`, 13 * 86400000);
    const pr = await limits.enforceSessionCap(fakeReq(pu, 'ps-new'));
    ok(pr.exempt && (await db.all('SELECT id FROM sessions WHERE user_id = ?', [pu])).length === 5,
      'population_admin: 5 sessions untouched');
    ok(sent.length === 0, 'no alert email for exempt accounts');

    // --- revoke helpers ---
    const ru = await mkUser('slrev@test.local', 'customer');
    await mkSession(ru, 'keep-me', 13 * 86400000);
    await mkSession(ru, 'drop-me', 13 * 86400000);
    const noSelf = await limits.revokeSession(ru, 'keep-me', 'keep-me');
    ok(!noSelf.revoked && (await db.get('SELECT id FROM sessions WHERE id = ?', ['keep-me'])),
      'revoke refuses the current session');
    const one = await limits.revokeSession(ru, 'drop-me', 'keep-me');
    ok(one.revoked && !(await db.get('SELECT id FROM sessions WHERE id = ?', ['drop-me'])),
      'revoke deletes one other session');
    await mkSession(ru, 'drop2', 13 * 86400000);
    await mkSession(ru, 'drop3', 13 * 86400000);
    const all = await limits.revokeOtherSessions(ru, 'keep-me');
    ok(all.revoked === 2 && (await db.get('SELECT id FROM sessions WHERE id = ?', ['keep-me'])) &&
       (await db.all('SELECT id FROM sessions WHERE user_id = ?', [ru])).length === 1,
      'sign-out-everywhere deletes all but the current session');
  } finally {
    mail.__setTransporter(null);
    // Restore the admin roster for later fanout-counting tests.
    for (const uid of adminish) {
      await db.query('DELETE FROM sessions WHERE user_id = ?', [uid]);
      await db.query('DELETE FROM users WHERE id = ?', [uid]);
    }
  }
}

// One fetch client per simulated device (own cookie jar, own user-agent).
function deviceClient(ua) {
  const jar = {};
  return async function (method, p, { body } = {}) {
    const h = { 'user-agent': ua };
    const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) h.cookie = cookies;
    let payload;
    if (body && typeof body === 'object') {
      payload = new URLSearchParams(body);
      h['content-type'] = 'application/x-www-form-urlencoded';
    } else payload = body;
    const res = await fetch(`${BASE}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [k, v] = c.split(';')[0].split('=');
      jar[k.trim()] = (v || '').trim();
    }
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  };
}

async function runHttpTests(ok) {
  console.log('session limits (http):');
  const Database = require('better-sqlite3');
  const sdb = new Database(process.env.SQLITE_PATH);
  try {
    const pw = bcrypt.hashSync('password123', 4);
    const mkLoginUser = (email, role, extra = {}) => {
      const cols = ['id', 'email', 'password_hash', 'role', 'display_name', 'created_at', 'email_verified'];
      const vals = [require('crypto').randomUUID(), email, pw, role, email.split('@')[0], Date.now(), 1];
      if (extra.population_admin) { cols.push('population_admin'); vals.push(1); }
      sdb.prepare(`INSERT INTO users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
      return vals[0];
    };
    const sessionIdsFor = (uid) =>
      sdb.prepare('SELECT id, data FROM sessions WHERE user_id = ? AND expires_at > ?').all(uid, Date.now());
    const uaFor = (uid, label) =>
      sessionIdsFor(uid).find((s) => String(s.data).includes(label));

    // --- design_artist (cap 2): third login evicts the oldest ---
    const artistId = mkLoginUser('httpartist@test.local', 'design_artist');
    const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    const UA_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
    const devA = deviceClient(UA_IPHONE);
    const devB = deviceClient(UA_WINDOWS);
    const devC = deviceClient(UA_ANDROID);
    let r = await devA('POST', '/login', { body: { email: 'httpartist@test.local', password: 'password123' } });
    ok(r.status === 302, 'device A login ok');
    r = await devB('POST', '/login', { body: { email: 'httpartist@test.local', password: 'password123' } });
    ok(r.status === 302, 'device B login ok (at cap, no eviction)');
    ok(sessionIdsFor(artistId).length === 2, 'two active sessions at cap');
    // NOTE: no requests on A/B between logins — any request would touch the
    // session and refresh its expires_at, changing the eviction order.
    r = await devC('POST', '/login', { body: { email: 'httpartist@test.local', password: 'password123' } });
    ok(r.status === 302, 'device C login ok (over cap: oldest evicted)');
    ok(!uaFor(artistId, 'iPhone'), 'oldest session (device A) evicted on third login');
    ok(uaFor(artistId, 'Windows') && uaFor(artistId, 'Android'), 'newer sessions kept');
    r = await devA('GET', '/account');
    ok(r.status === 302 && (r.location || '').includes('/login'), 'evicted device A is signed out');
    r = await devC('GET', '/account');
    ok(r.status === 200, 'newest session (device C) still signed in');
    ok(r.text.includes('Signed-in devices') && r.text.includes('this device'),
      'account page lists signed-in devices and marks the current one');
    ok(r.text.includes('Chrome on Windows') && r.text.includes('Chrome on Android'),
      'account page parses device/browser from the user-agent');

    // --- sign out all other devices ---
    r = await devC('POST', '/account/sessions/revoke-others', { body: {} });
    ok(r.status === 302, 'sign-out-everywhere redirects');
    ok(sessionIdsFor(artistId).length === 1 && uaFor(artistId, 'Android'),
      'sign-out-everywhere leaves only the current session');
    r = await devC('GET', '/account');
    ok(r.status === 200, 'current session survives sign-out-everywhere');
    r = await devB('GET', '/account');
    ok(r.status === 302, 'other device signed out by sign-out-everywhere');

    // --- per-session revoke ---
    const devD = deviceClient('DeviceD/1.0');
    const devE = deviceClient('DeviceE/1.0');
    await devD('POST', '/login', { body: { email: 'httpartist@test.local', password: 'password123' } });
    await devE('POST', '/login', { body: { email: 'httpartist@test.local', password: 'password123' } });
    const target = uaFor(artistId, 'DeviceD');
    ok(!!target, 'device D session found for revoke test');
    r = await devE('POST', `/account/sessions/revoke/${encodeURIComponent(target.id)}`, { body: {} });
    ok(r.status === 302, 'per-session revoke redirects');
    ok(!uaFor(artistId, 'DeviceD') && uaFor(artistId, 'DeviceE'), 'per-session revoke deletes only that session');
    const own = uaFor(artistId, 'DeviceE');
    r = await devE('POST', `/account/sessions/revoke/${encodeURIComponent(own.id)}`, { body: {} });
    ok(r.status === 302 && uaFor(artistId, 'DeviceE'), 'cannot revoke your own current session');

    // --- head_admin exemption over HTTP ---
    const headId = mkLoginUser('httphead@test.local', 'head_admin');
    const heads = [deviceClient('Head1/1.0'), deviceClient('Head2/1.0'), deviceClient('Head3/1.0'), deviceClient('Head4/1.0')];
    for (const h of heads) {
      r = await h('POST', '/login', { body: { email: 'httphead@test.local', password: 'password123' } });
      ok(r.status === 302, 'head_admin login ok');
    }
    ok(sessionIdsFor(headId).length === 4, 'head_admin exempt: 4 sessions, none evicted');
    r = await heads[0]('GET', '/account');
    ok(r.status === 200 && !r.text.includes('Signed-in devices'), 'exempt account page hides the device section');

    // --- population_admin exemption over HTTP ---
    const popId = mkLoginUser('httppop@test.local', 'design_artist', { population_admin: 1 });
    const pops = [deviceClient('Pop1/1.0'), deviceClient('Pop2/1.0'), deviceClient('Pop3/1.0')];
    for (const p of pops) {
      r = await p('POST', '/login', { body: { email: 'httppop@test.local', password: 'password123' } });
      ok(r.status === 302, 'population_admin login ok');
    }
    ok(sessionIdsFor(popId).length === 3, 'population_admin exempt: 3 sessions, none evicted');

    // Restore the admin roster (head_admin fixture) for any later fanout counts.
    for (const uid of [headId]) {
      sdb.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);
      sdb.prepare('DELETE FROM users WHERE id = ?').run(uid);
    }
  } finally {
    sdb.close();
  }
}

module.exports = { runDbTests, runHttpTests };
