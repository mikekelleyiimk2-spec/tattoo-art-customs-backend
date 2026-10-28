// Console-session prep — per-app privacy pages (2026-10-28).
// The coordinator (test/run.js) wires this in; do not run from here.
// Covers the privacy-policy pages the Play Console App-content step
// points at for Ghost Box, Loophole Ciphers, FillMyList, Kids' Wing,
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

  // FillMyList — free with AdMob ads; sends only what its forms carry.
  // RENAMED 2026-10-28 (was Tester Hub): canonical slug is fill-my-list;
  // the pre-rename slugs (brand + package-name alias) 301 to it.
  await check('fill-my-list', 'FillMyList', 'com.usefulappz.testerhub', 'AdMob', 'discloses AdMob ads');
  for (const old of ['tester-hub', 'testerhub']) {
    const r = await req('GET', `/privacy/${old}`, { follow: false });
    ok(r.status === 301 && r.location === '/privacy/fill-my-list',
      `privacy page /privacy/${old} 301-redirects to /privacy/fill-my-list`);
  }

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
