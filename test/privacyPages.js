// Console-session prep — per-app privacy pages (2026-10-28).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers the privacy-policy pages the Play Console App-content step
// points at for Ghost Box, Loophole Ciphers, Tester Hub, Kids' Wing,
// The Library, and Habit Dot — each at BOTH its canonical slug and its
// package-name alias slug (same page, same policy, house precedent:
// /privacy/onemind aliasing the AI Bar page). Assertions check the page
// names the app + package and states its true data posture.
async function runHttpTests(ok, req) {
  console.log('privacyPages (per-app privacy pages + package-name aliases):');
  const get = async (p) => {
    const r = await req('GET', p);
    return { status: r.status, text: r.text || '' };
  };

  const check = async (slug, appName, pkg, marker, markerLabel) => {
    const page = await get(`/privacy/${slug}`);
    ok(page.status === 200, `privacy page /privacy/${slug} responds 200`);
    ok(page.text.includes(appName), `privacy page /privacy/${slug} names the app`);
    ok(page.text.includes(pkg), `privacy page /privacy/${slug} names the package`);
    ok(page.text.includes(marker), `privacy page /privacy/${slug} ${markerLabel}`);
  };

  // Ghost Box — zero permissions, no microphone, nothing collected.
  await check('ghost-box', 'Ghost Box', 'com.usefulappz.ghostbox', 'no microphone', 'states the no-microphone rule');
  await check('ghostbox', 'Ghost Box', 'com.usefulappz.ghostbox', 'no microphone', 'states the no-microphone rule');

  // Loophole Ciphers — zero permissions, no internet, nothing collected.
  await check('loophole-ciphers', 'Loophole Ciphers', 'com.usefulappz.ciphertoy', 'no internet permission', 'states the no-internet rule');
  await check('ciphertoy', 'Loophole Ciphers', 'com.usefulappz.ciphertoy', 'no internet permission', 'states the no-internet rule');

  // Tester Hub — free with AdMob ads; sends only what its forms carry.
  await check('tester-hub', 'Tester Hub', 'com.usefulappz.testerhub', 'AdMob', 'discloses AdMob ads');
  await check('testerhub', 'Tester Hub', 'com.usefulappz.testerhub', 'AdMob', 'discloses AdMob ads');

  // Kids' Wing — child-directed; collects no data from children or anyone.
  await check('kids-wing', "Kids' Wing", 'com.usefulappz.librarykids', 'no data at all', 'states nothing is collected');
  await check('librarykids', "Kids' Wing", 'com.usefulappz.librarykids', 'no data at all', 'states nothing is collected');

  // The Library — no permissions, bundled books read fully offline.
  await check('library', 'The Library', 'com.usefulappz.library', 'no data', 'states no data is collected');

  // Habit Dot — honestly declares Google AdMob collection in the free version.
  await check('habit-dot', 'Habit Dot', 'com.usefulappz.habitdot', 'AdMob', 'discloses AdMob ads');
  await check('habitdot', 'Habit Dot', 'com.usefulappz.habitdot', 'AdMob', 'discloses AdMob ads');
}

module.exports = { runHttpTests };
