// Folder Scan phone-home tests (2026-10-26).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers the contract: POST /api/folder-scan validates + whitelists
// the phone's report (device label, timestamp, installed[] package /
// versionCode / versionName, missing[] package) and stores the latest
// scan per device; GET /api/folder-scan sits behind the Muse service
// token and serves ONLY the whitelisted shape back.
const BASE = 'http://localhost:4137';

async function runHttpTests(ok, req) {
  console.log('folder scan (phone-home endpoint):');
  const TOKEN = process.env.MUSE_SERVICE_TOKEN;
  const call = async (method, p, body, token) => {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, text, json };
  };

  // GET is token-guarded from the start: 401 without / with a wrong
  // token, and an empty scans list behind the right one.
  const getNoTok = await call('GET', '/api/folder-scan');
  ok(getNoTok.status === 401, 'folder-scan GET rejects a missing Bearer token');
  const getBadTok = await call('GET', '/api/folder-scan', undefined, 'wrong-token');
  ok(getBadTok.status === 401, 'folder-scan GET rejects a wrong Bearer token');
  const getEmpty = await call('GET', '/api/folder-scan', undefined, TOKEN);
  ok(getEmpty.status === 200 && getEmpty.json && getEmpty.json.ok === true
    && Array.isArray(getEmpty.json.scans) && getEmpty.json.scans.length === 0,
    'folder-scan GET before any POST returns an empty scans list');

  // POST validation: malformed payloads are 400, never stored.
  const junk1 = await call('POST', '/api/folder-scan', {});
  ok(junk1.status === 400, 'POST rejects an empty body');
  const junk2 = await call('POST', '/api/folder-scan',
    { device: 'Galaxy Note9', timestamp: '2026-10-26T15:53:00.000Z', installed: 'nope', missing: [] });
  ok(junk2.status === 400, 'POST rejects non-array installed');
  const junk3 = await call('POST', '/api/folder-scan',
    { device: 'Galaxy Note9', timestamp: '2026-10-26T15:53:00.000Z', installed: [], missing: 'nope' });
  ok(junk3.status === 400, 'POST rejects non-array missing');
  const junk4 = await call('POST', '/api/folder-scan',
    { device: 'Galaxy Note9', timestamp: 'not-a-date', installed: [], missing: [] });
  ok(junk4.status === 400, 'POST rejects a bad timestamp');
  const junk5 = await call('POST', '/api/folder-scan',
    { device: '', timestamp: '2026-10-26T15:53:00.000Z', installed: [], missing: [] });
  ok(junk5.status === 400, 'POST rejects an empty device label');
  const junk6 = await call('POST', '/api/folder-scan',
    { device: 'Galaxy Note9', timestamp: '2026-10-26T15:53:00.000Z',
      installed: [{ package: 'not a package', versionCode: 1, versionName: '1.0' }], missing: [] });
  ok(junk6.status === 400, 'POST rejects a malformed installed package name');
  const junk7 = await call('POST', '/api/folder-scan',
    { device: 'Galaxy Note9', timestamp: '2026-10-26T15:53:00.000Z',
      installed: [{ package: 'com.usefulappz.folder', versionCode: 'two', versionName: '1.1.0' }], missing: [] });
  ok(junk7.status === 400, 'POST rejects a non-integer versionCode');
  const junk8 = await call('POST', '/api/folder-scan',
    { device: 'Galaxy Note9', timestamp: '2026-10-26T15:53:00.000Z',
      installed: [
        { package: 'com.usefulappz.folder', versionCode: 2, versionName: '1.1.0' },
        { package: 'com.usefulappz.folder', versionCode: 2, versionName: '1.1.0' },
      ], missing: [] });
  ok(junk8.status === 400, 'POST rejects duplicate installed packages');
  const junk9 = await call('POST', '/api/folder-scan',
    { device: 'Galaxy Note9', timestamp: '2026-10-26T15:53:00.000Z',
      installed: [], missing: [{ package: 'com.usefulappz.robosweeper' }, { package: 'com.usefulappz.robosweeper' }] });
  ok(junk9.status === 400, 'POST rejects duplicate missing packages');
  const stillEmpty = await call('GET', '/api/folder-scan', undefined, TOKEN);
  ok(stillEmpty.json && stillEmpty.json.scans.length === 0, 'rejected POSTs stored nothing');

  // Valid POST: stored latest-per-device. Extra junk fields ride
  // along in the body and entries — the whitelist must strip them.
  const scan1 = {
    device: 'Galaxy Note9',
    timestamp: '2026-10-26T15:53:00.000Z',
    installed: [
      { package: 'com.usefulappz.folder', versionCode: 2, versionName: '1.1.0', serial: 'STRIP-ME-1' },
      { package: 'com.usefulappz.robosweeper', versionCode: 2, versionName: '1.0.1' },
      { package: 'com.tattooartcustoms.app', versionCode: 13, versionName: '1.1.0' },
    ],
    missing: [
      { package: 'com.usefulappz.moneywatch', note: 'STRIP-ME-2' },
    ],
    imei: 'STRIP-ME-3',
    owner_email: 'strip-me@example.com',
  };
  const post1 = await call('POST', '/api/folder-scan', scan1);
  ok(post1.status === 200 && post1.json && post1.json.ok === true
    && post1.json.stored && post1.json.stored.installed === 3 && post1.json.stored.missing === 1,
    'valid POST stores the scan and reports its counts');

  const get1 = await call('GET', '/api/folder-scan', undefined, TOKEN);
  const scans1 = (get1.json && get1.json.scans) || [];
  ok(get1.status === 200 && scans1.length === 1, 'GET after POST returns one device scan');
  const s1 = scans1[0] || {};
  ok(s1.device === 'Galaxy Note9' && s1.slug === 'galaxy-note9'
    && s1.timestamp === '2026-10-26T15:53:00.000Z'
    && typeof s1.received_at === 'string' && s1.received_at.length > 0,
    'the stored scan carries device, slug, phone timestamp, and a server received_at');
  ok(Array.isArray(s1.installed) && s1.installed.length === 3
    && s1.installed.every((e) => Object.keys(e).sort().join(',') === 'package,versionCode,versionName'),
    'installed entries carry ONLY package, versionCode, versionName');
  const folderEntry = (s1.installed || []).find((e) => e.package === 'com.usefulappz.folder');
  ok(!!folderEntry && folderEntry.versionCode === 2 && folderEntry.versionName === '1.1.0',
    'the folder app entry round-trips with its version');
  ok(Array.isArray(s1.missing) && s1.missing.length === 1
    && s1.missing[0].package === 'com.usefulappz.moneywatch'
    && Object.keys(s1.missing[0]).join(',') === 'package',
    'missing entries carry ONLY the package');
  ok(s1.counts && s1.counts.installed === 3 && s1.counts.missing === 1, 'counts ride along');
  ok(!get1.text.includes('STRIP-ME') && !get1.text.includes('strip-me@example.com')
    && !get1.text.includes('imei') && !get1.text.includes(TOKEN),
    'GET response leaks no stripped junk fields or the token');

  // ?device=<slug> narrows to one device; unknown slug is a 404.
  const getOne = await call('GET', '/api/folder-scan?device=galaxy-note9', undefined, TOKEN);
  ok(getOne.status === 200 && getOne.json && getOne.json.scan
    && getOne.json.scan.device === 'Galaxy Note9', 'GET ?device= returns that device scan');
  const getNone = await call('GET', '/api/folder-scan?device=nope', undefined, TOKEN);
  ok(getNone.status === 404, 'GET ?device= with an unknown slug is a 404');

  // A newer scan from the SAME device replaces the old one (latest
  // per device), and a second device gets its own slot.
  const scan2 = {
    device: 'Galaxy Note9',
    timestamp: '2026-10-26T16:05:00.000Z',
    installed: [
      { package: 'com.usefulappz.folder', versionCode: 2, versionName: '1.1.0' },
      { package: 'com.usefulappz.moneywatch', versionCode: 1, versionName: '1.0.0' },
    ],
    missing: [],
  };
  const post2 = await call('POST', '/api/folder-scan', scan2);
  ok(post2.status === 200 && post2.json && post2.json.ok === true, 'a second POST from the same device stores');
  const scanOther = {
    device: 'TEST Tablet',
    timestamp: '2026-10-26T16:06:00.000Z',
    installed: [{ package: 'com.usefulappz.folder', versionCode: 2, versionName: '1.1.0' }],
    missing: [{ package: 'com.usefulappz.robosweeper' }],
  };
  const post3 = await call('POST', '/api/folder-scan', scanOther);
  ok(post3.status === 200, 'a scan from a second device stores');
  const get2 = await call('GET', '/api/folder-scan', undefined, TOKEN);
  const scans2 = (get2.json && get2.json.scans) || [];
  ok(scans2.length === 2, 'GET now returns one latest scan per device (two devices)');
  const note9 = scans2.find((s) => s.slug === 'galaxy-note9') || {};
  ok(note9.timestamp === '2026-10-26T16:05:00.000Z'
    && note9.counts && note9.counts.installed === 2 && note9.counts.missing === 0,
    'the same-device scan was REPLACED by the newer report, not appended');
  const tablet = scans2.find((s) => s.slug === 'test-tablet') || {};
  ok(tablet.device === 'TEST Tablet' && tablet.counts && tablet.counts.missing === 1,
    'the second device keeps its own scan slot');
}

module.exports = { runHttpTests };
