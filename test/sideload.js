// Little Inkers free sideload door (repair 2026-10-29): the download
// route 404'd for weeks because the verified APK could never be stored
// on the (full) production uploads disk, while the page kept promising
// "early November". The door now also serves from a hosted URL
// (LITTLE_INKERS_APK_URL, e.g. the house R2 public host). run.js sets
// that env var for the spawned app to a known test URL, so below:
//   - Android page shows the real download button (not coming-soon)
//   - Android /download 302-redirects to the hosted URL
//   - iOS (no URL configured, no stored file) keeps the honest
//     coming-soon card and its /download still answers 404
// Plus pure unit checks of hostedUrl() against this process's env.

async function runHttpTests(ok, req) {
  console.log('sideload (Little Inkers door):');

  let r = await req('GET', '/little-inkers-android');
  ok(r.status === 200, 'LI android sideload page renders 200');
  ok(r.text.includes('/little-inkers-android/download') && !r.text.includes('Coming early November'),
    'LI android page shows the download button when a hosted URL is configured');

  r = await req('GET', '/little-inkers-android/download', { follow: false });
  ok(r.status === 302 && r.location === 'https://example.test/little-inkers.apk',
    'LI android /download redirects to the hosted APK URL');

  r = await req('GET', '/little-inkers-ios');
  ok(r.status === 200 && r.text.includes('Coming early November'),
    'LI ios page keeps the honest coming-soon card when nothing is servable');

  r = await req('GET', '/little-inkers-ios/download', { follow: false });
  ok(r.status === 404, 'LI ios /download is 404 while no file or hosted URL exists');
}

function runUnitTests(ok) {
  console.log('sideload hostedUrl (unit):');
  const { FREE_APPS, hostedUrl } = require('../src/routes/sideload');
  const cfg = FREE_APPS['little-inkers-android'];
  const saved = process.env.LITTLE_INKERS_APK_URL;
  try {
    process.env.LITTLE_INKERS_APK_URL = 'https://example.test/little-inkers.apk';
    ok(hostedUrl(cfg) === 'https://example.test/little-inkers.apk', 'hostedUrl returns the configured https URL');
    process.env.LITTLE_INKERS_APK_URL = 'http://example.test/little-inkers.apk';
    ok(hostedUrl(cfg) === null, 'hostedUrl refuses a non-https URL');
    delete process.env.LITTLE_INKERS_APK_URL;
    ok(hostedUrl(cfg) === null, 'hostedUrl is null when the env var is unset');
    ok(hostedUrl(FREE_APPS['tac-android']) === null, 'hostedUrl is null for apps without a urlEnv');
  } finally {
    if (saved === undefined) delete process.env.LITTLE_INKERS_APK_URL;
    else process.env.LITTLE_INKERS_APK_URL = saved;
  }
}

module.exports = { runHttpTests, runUnitTests };
