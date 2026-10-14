// App auto-update service tests (/api/apps/:package/update + /apk).
// The coordinator (test/run.js) wires this in; do not run from here.
// The spawned server is pointed at a temp registry via
// APP_UPDATES_REGISTRY (set in run.js before the spawn), and the route
// reads the registry per request, so seeding it here — after the server
// is already up — is exactly the production flow (registry edit + APK
// file landing on disk).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'http://localhost:4137';

async function runHttpTests(ok) {
  console.log('app auto-update service:');

  // Unknown package -> 404 JSON on both routes.
  let res = await fetch(`${BASE}/api/apps/com.usefulappz.nope/update`);
  let json = await res.json();
  ok(res.status === 404 && json.ok === false && json.error === 'unknown package',
    'unknown package: /update -> 404 {ok:false, error:"unknown package"}');
  res = await fetch(`${BASE}/api/apps/com.usefulappz.nope/apk`);
  json = await res.json();
  ok(res.status === 404 && json.ok === false && json.error === 'unknown package',
    'unknown package: /apk -> 404 JSON');

  // Seed a temp registry entry + a temp APK file.
  const pkg = 'com.usefulappz.testapp';
  const apkBytes = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04, like a real APK
    Buffer.from('fake-apk-bytes-for-the-update-test'),
  ]);
  const sha256 = crypto.createHash('sha256').update(apkBytes).digest('hex');
  const entry = {
    versionCode: 42,
    versionName: '1.2.3',
    notes: 'Test release notes',
    sha256,
    sizeBytes: apkBytes.length,
    publishedAt: 1760000000000,
    apkFile: `${pkg}.apk`,
  };
  ok(!!process.env.APP_UPDATES_REGISTRY, 'APP_UPDATES_REGISTRY override is set for tests');
  fs.writeFileSync(process.env.APP_UPDATES_REGISTRY, JSON.stringify({ [pkg]: entry }, null, 2));
  // APK location mirrors the route: uploadDir/app-updates/<package>.apk
  // (with UPLOAD_DIR unset in tests, uploadDir === ASSET_DIR/uploads).
  const uploadDir = process.env.UPLOAD_DIR || path.join(process.env.ASSET_DIR, 'uploads');
  const apkDir = path.join(uploadDir, 'app-updates');
  fs.mkdirSync(apkDir, { recursive: true });
  fs.writeFileSync(path.join(apkDir, entry.apkFile), apkBytes);

  // /update returns the seeded entry with a correct apkUrl.
  res = await fetch(`${BASE}/api/apps/${pkg}/update`);
  json = await res.json();
  ok(res.status === 200 && json.ok === true && json.package === pkg,
    'known package: /update -> 200 ok:true with the package name');
  ok(json.versionCode === 42 && json.versionName === '1.2.3'
      && json.notes === 'Test release notes' && json.sha256 === sha256
      && json.sizeBytes === apkBytes.length && json.publishedAt === entry.publishedAt,
    '/update returns the seeded entry fields verbatim');
  ok(json.apkUrl === `${BASE}/api/apps/${pkg}/apk`,
    '/update apkUrl points at the /apk route');

  // /apk streams the exact bytes with the APK content type.
  res = await fetch(`${BASE}/api/apps/${pkg}/apk`);
  const body = Buffer.from(await res.arrayBuffer());
  ok(res.status === 200, 'known package: /apk -> 200');
  ok((res.headers.get('content-type') || '').includes('application/vnd.android.package-archive'),
    '/apk serves application/vnd.android.package-archive');
  ok(body.equals(apkBytes), '/apk streams the exact APK bytes');

  // --- Default file resolution (live defect 2026-10-14) ---
  // The production registry entries carry apkUrl, NOT apkFile, and the
  // upload route (POST /api/muse/upload-sideload) stores every auto-update
  // APK at <uploadDir>/app-updates/<package>.apk. Seed an entry WITHOUT
  // apkFile and the file exactly where the upload route writes it, then
  // the default resolution must serve it (before the fix this 404'd for
  // every package, free and paid alike).
  const defPkg = 'com.usefulappz.defaultapp';
  const defBytes = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('fake-apk-bytes-for-the-default-resolution-test'),
  ]);
  const defEntry = {
    versionCode: 7,
    versionName: '0.7.0',
    notes: 'Default resolution release',
    sha256: crypto.createHash('sha256').update(defBytes).digest('hex'),
    sizeBytes: defBytes.length,
    publishedAt: 1760000000000,
    // no apkFile on purpose — mirrors the real registry shape
  };
  fs.writeFileSync(path.join(apkDir, `${defPkg}.apk`), defBytes);

  // --- Paid gate (owner ruling 2026-10-14) ---
  const gatedPkg = 'com.usefulappz.paidapp';
  const gatedBytes = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('fake-apk-bytes-for-the-gated-test'),
  ]);
  const gatedEntry = {
    versionCode: 3,
    versionName: '3.0.0',
    notes: 'Gated release',
    sha256: crypto.createHash('sha256').update(gatedBytes).digest('hex'),
    sizeBytes: gatedBytes.length,
    publishedAt: 1760000000000,
    gated: true,
    // no apkFile either — gated packages resolve by the same default
  };
  fs.writeFileSync(path.join(apkDir, `${gatedPkg}.apk`), gatedBytes);

  fs.writeFileSync(process.env.APP_UPDATES_REGISTRY, JSON.stringify({
    [pkg]: entry, [defPkg]: defEntry, [gatedPkg]: gatedEntry,
  }, null, 2));

  // Default resolution: entry without apkFile serves the upload-route file.
  res = await fetch(`${BASE}/api/apps/${defPkg}/apk`);
  const defBody = Buffer.from(await res.arrayBuffer());
  ok(res.status === 200 && defBody.equals(defBytes),
    'default resolution: entry without apkFile -> /apk 200 with the upload-route file bytes');

  // Gated /update stays public and flags the gate.
  res = await fetch(`${BASE}/api/apps/${gatedPkg}/update`);
  json = await res.json();
  ok(res.status === 200 && json.ok === true && json.gated === true,
    'gated package: /update -> 200 with gated:true');

  // Gated /apk without a token -> 401.
  res = await fetch(`${BASE}/api/apps/${gatedPkg}/apk`);
  json = await res.json();
  ok(res.status === 401 && json.ok === false && json.error === 'purchase token required',
    'gated package: /apk without token -> 401 {error:"purchase token required"}');

  // Gated /apk with a garbage token -> 401.
  res = await fetch(`${BASE}/api/apps/${gatedPkg}/apk?t=garbage.tokenvalue0000000000000000`);
  json = await res.json();
  ok(res.status === 401 && json.ok === false && json.error === 'purchase token required',
    'gated package: /apk with garbage token -> 401');

  // Seed orders straight into the test DB (sdb pattern: the harness's own
  // db handle is closed before the HTTP phase, so open the file directly).
  const Database = require('better-sqlite3');
  const sdb = new Database(process.env.SQLITE_PATH);
  const anyUser = sdb.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get();
  const buyerId = anyUser.id;
  const insOrder = sdb.prepare(`INSERT INTO orders
    (id, buyer_id, order_type, amount_cents, fee_cents, status, payment_method, created_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  insOrder.run('test-gated-order-1', buyerId, `sideload:${gatedPkg}`, 99, 52, 'paid', 'paypal', Date.now());
  insOrder.run('test-other-order-1', buyerId, 'sideload:com.usefulappz.otherpaid', 99, 52, 'paid', 'paypal', Date.now());
  insOrder.run('test-pending-order-1', buyerId, `sideload:${gatedPkg}`, 99, 52, 'pending', 'paypal', Date.now());
  sdb.close();

  const updateTokens = require('../src/lib/updateTokens');
  const goodToken = updateTokens.issue('test-gated-order-1', gatedPkg);

  // Valid token (query param) -> 200 with the exact bytes.
  res = await fetch(`${BASE}/api/apps/${gatedPkg}/apk?t=${goodToken}`);
  const gatedBody = Buffer.from(await res.arrayBuffer());
  ok(res.status === 200 && gatedBody.equals(gatedBytes),
    'gated package: /apk with a paid-order token (?t=) -> 200 with exact bytes');

  // Valid token (header) -> 200 too.
  res = await fetch(`${BASE}/api/apps/${gatedPkg}/apk`, { headers: { 'x-update-token': goodToken } });
  const gatedBody2 = Buffer.from(await res.arrayBuffer());
  ok(res.status === 200 && gatedBody2.equals(gatedBytes),
    'gated package: /apk with a paid-order token (x-update-token header) -> 200');

  // Token issued for a different package -> 401 (HMAC is package-bound).
  const otherPkgToken = updateTokens.issue('test-gated-order-1', 'com.usefulappz.otherpaid');
  res = await fetch(`${BASE}/api/apps/${gatedPkg}/apk?t=${otherPkgToken}`);
  json = await res.json();
  ok(res.status === 401 && json.error === 'purchase token required',
    'gated package: token issued for a different package -> 401');

  // Token whose order is paid but for a different package's order_type -> 401
  // (HMAC passes for this package; the DB order_type check must reject it).
  const wrongTypeToken = updateTokens.issue('test-other-order-1', gatedPkg);
  res = await fetch(`${BASE}/api/apps/${gatedPkg}/apk?t=${wrongTypeToken}`);
  json = await res.json();
  ok(res.status === 401 && json.error === 'purchase token required',
    'gated package: token for an order of a different order_type -> 401');

  // Token whose order is not paid -> 401.
  const pendingToken = updateTokens.issue('test-pending-order-1', gatedPkg);
  res = await fetch(`${BASE}/api/apps/${gatedPkg}/apk?t=${pendingToken}`);
  json = await res.json();
  ok(res.status === 401 && json.error === 'purchase token required',
    'gated package: token for a pending (unpaid) order -> 401');

  // Free entry still serves publicly without any token.
  res = await fetch(`${BASE}/api/apps/${pkg}/apk`);
  const freeBody = Buffer.from(await res.arrayBuffer());
  ok(res.status === 200 && freeBody.equals(apkBytes),
    'free package: /apk still 200 without a token');
}

module.exports = { runHttpTests };
