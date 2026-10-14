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
}

module.exports = { runHttpTests };
