// Link Rolodex family tests (2026-10-26).
// The coordinator (test/run.js) wires this in; do not run from here.
async function runHttpTests(ok, req) {
  console.log('links (per-family rolodexes + master index):');
  const get = async (p) => {
    const r = await req('GET', p);
    let json = null;
    try { json = JSON.parse(r.text); } catch (e) {}
    return { status: r.status, json };
  };

  // Master index: families as sections, affiliates point at their own
  // untouched endpoint — never blended into a family file.
  const idx = await get('/api/links');
  ok(idx.status === 200 && idx.json && idx.json.ok === true, 'links index responds ok');
  const fams = (idx.json && idx.json.families) || {};
  ok(fams.affiliates && fams.affiliates.endpoint === '/api/rolodex', 'index keeps affiliates on /api/rolodex (separate product)');
  ok(fams.affiliates && fams.affiliates.count === 46 && fams.affiliates.live === 15, 'index reports affiliate counts (46 total / 15 live)');
  ok(fams.socials && fams.socials.endpoint === '/api/social-links' && fams.socials.count === 10, 'index lists the socials family (10)');
  ok(fams.web_pages && fams.web_pages.count === 35, 'index lists web pages (35 public)');
  ok(fams.channels && fams.channels.count === 4, 'index lists channels (4)');
  ok(fams.storefronts && fams.storefronts.count === 11, 'index lists storefronts (11)');
  ok(fams.app_links && fams.app_links.count === 23, 'index lists app links (23 public)');
  ok(fams.money && fams.money.count === 1, 'index lists money links (1)');

  // Socials family: independently pullable, internal-free.
  const soc = await get('/api/social-links');
  ok(soc.status === 200 && soc.json.count === 10, 'social-links returns all 10 socials');
  const socUrls = (soc.json.entries || []).map((e) => e.url);
  ok(socUrls.includes('https://www.instagram.com/mikeyii.mk2_/'), 'socials include the main Instagram');
  ok(socUrls.includes('https://www.instagram.com/littleinkersapp/'), 'socials include the Little Inkers Instagram');

  // Kid-safe pull: kid surfaces get kid entries ONLY — structurally no
  // tattoo/21+ socials in the response.
  const kids = await get('/api/social-links?kid_safe=1');
  const kidEntries = (kids.json && kids.json.entries) || [];
  ok(kidEntries.length > 0 && kidEntries.every((e) => e.kid_safe === true), 'social kid_safe=1 returns kid-safe entries only');
  ok(kidEntries.some((e) => e.url === 'https://www.instagram.com/littleinkersapp/'), 'social kid_safe=1 includes Little Inkers');
  ok(!kidEntries.some((e) => String(e.url || '').includes('mikeyii.mk2_')), 'social kid_safe=1 excludes the tattoo-side Instagram');

  // Web family: the internal repo entry is never served publicly.
  const web = await get('/api/web-links');
  ok(web.status === 200 && web.json.count === 35, 'web-links returns 35 public pages');
  ok(!(web.json.entries || []).some((e) => String(e.url || '').includes('github.com')), 'web-links never serves the internal repo entry');
  const cd = (web.json.entries || []).find((e) => String(e.url || '').endsWith('/cannadash'));
  ok(cd && cd.state === 'building', 'web-links carries /cannadash with its honest building state');

  // Play family: testing links served, the internal console entry is not.
  const play = await get('/api/play-links');
  ok(play.status === 200 && play.json.count === 23, 'play-links returns 23 public entries');
  ok((play.json.entries || []).some((e) => e.url === 'https://play.google.com/apps/testing/com.usefulappz.screenqr'), 'play-links include the ScreenQR testing opt-in');
  ok(!(play.json.entries || []).some((e) => String(e.url || '').includes('play.google.com/console')), 'play-links never serves the internal console entry');

  // Money family: exactly the business PayPal link — never a personal one.
  const money = await get('/api/money-links');
  ok(money.status === 200 && money.json.count === 1
    && money.json.entries[0].url === 'https://www.paypal.com/ncp/payment/WA9DS6J8ERSHW',
    'money-links serves only the business PayPal (mk4) payment link');

  // Storefronts: state records with url:null stay honest (never invented).
  const stores = await get('/api/storefront-links');
  const tee = (stores.json.entries || []).find((e) => e.name.startsWith('TeePublic'));
  ok(tee && tee.url === null && String(tee.verified || '').startsWith('UNVERIFIED'), 'storefront state records keep url:null + UNVERIFIED instead of an invented URL');
}

module.exports = { runHttpTests };
