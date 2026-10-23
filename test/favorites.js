// Wishlist/favorites feature tests ([wishlist]).
// The coordinator (test/run.js) wires this in; do not run from here.
const { randomUUID } = require('crypto');

async function runHttpTests(ok, req) {
  console.log('favorites (wishlist):');
  const Database = require('better-sqlite3');
  const wdb = new Database(process.env.SQLITE_PATH);

  // Per-user cookie jar (mirrors the suite's req helper).
  function makeClient() {
    const jar = {};
    return async function creq(method, p, { body, headers = {}, follow = true } = {}) {
      const h = { ...headers };
      const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) h.cookie = cookies;
      const res = await fetch(`http://localhost:4137${p}`, {
        method, headers: h, body,
        redirect: follow ? 'follow' : 'manual',
      });
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of setCookies) {
        const [pair] = c.split(';');
        const [k, v] = pair.split('=');
        jar[k.trim()] = (v || '').trim();
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      return { status: res.status, text, json };
    };
  }
  const jpost = (creq, p, obj) => creq('POST', p, {
    body: JSON.stringify(obj || {}), headers: { 'content-type': 'application/json' },
  });
  const form = (obj) => ({
    body: new URLSearchParams(obj), headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });

  // Seed two approved gallery designs.
  const d1 = 'fav-test-' + randomUUID().slice(0, 8);
  const d2 = 'fav-test-' + randomUUID().slice(0, 8);
  const ins = wdb.prepare(`INSERT INTO designs
    (id, title, description, style, categories, status, listing_type, listing_scope, price_cents, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run(d1, 'Fav Test Rose', 'desc', 'blackwork', '[]', 'approved', 'predesign', 'gallery', 7500, Date.now());
  ins.run(d2, 'Fav Test Two', 'desc', 'blackwork', '[]', 'approved', 'predesign', 'gallery', 7500, Date.now());

  // Guests: writes and merge 401 (localStorage only), reads 401.
  const guest = makeClient();
  let r = await jpost(guest, '/api/favorites/' + d1);
  ok(r.status === 401, 'guest POST favorite -> 401');
  r = await guest('GET', '/api/favorites');
  ok(r.status === 401, 'guest GET favorites -> 401');
  r = await jpost(guest, '/api/favorites/merge', { ids: [d1] });
  ok(r.status === 401, 'guest merge -> 401');
  r = await guest('DELETE', '/api/favorites/' + d1);
  ok(r.status === 401, 'guest DELETE favorite -> 401');

  // Sign up a user (form-encoded, like the suite).
  const user = makeClient();
  r = await user('POST', '/signup', { ...form({ display_name: 'Fav', email: 'favuser@test.local', password: 'password123' }), follow: false });
  ok(r.status === 302, 'signup redirects');

  r = await user('GET', '/api/favorites');
  ok(r.status === 200 && r.json && r.json.ok && Array.isArray(r.json.ids) && r.json.ids.length === 0,
    'fresh user has no favorites');

  r = await jpost(user, '/api/favorites/' + d1);
  ok(r.status === 200 && r.json && r.json.favorited === true, 'POST favorite adds');

  r = await jpost(user, '/api/favorites/' + d1);
  ok(r.status === 200, 're-adding a favorite is idempotent');

  r = await user('GET', '/api/favorites');
  ok(r.json.ids.length === 1 && r.json.ids[0] === d1, 'favorites list contains the design');

  r = await jpost(user, '/api/favorites/no-such-design');
  ok(r.status === 404, 'favoriting a missing design -> 404');

  r = await jpost(user, '/api/favorites/merge', { ids: [d1, d2, 'bogus-id', d2] });
  ok(r.status === 200 && r.json.ids.length === 2, 'merge dedupes and skips invalid ids');

  r = await user('DELETE', '/api/favorites/' + d1);
  ok(r.status === 200 && r.json && r.json.favorited === false, 'DELETE removes the favorite');
  r = await user('GET', '/api/favorites');
  ok(r.json.ids.length === 1 && r.json.ids[0] === d2, 'one favorite remains after delete');

  // Wishlist page: renders for guests; embeds server favorites when logged in.
  r = await guest('GET', '/wishlist');
  ok(r.status === 200 && r.text.includes('wishlist-grid'), 'wishlist page renders for guests');
  r = await user('GET', '/wishlist');
  ok(r.status === 200 && r.text.includes('Fav Test Two'), 'wishlist embeds server favorites for logged-in user');

  // Heart buttons are present on gallery cards and the design detail page.
  r = await guest('GET', '/gallery');
  ok(r.status === 200 && r.text.includes('data-fav-id'), 'gallery cards carry heart buttons');
  r = await guest('GET', '/design/' + d2);
  ok(r.status === 200 && r.text.includes('data-fav-id'), 'design page carries a heart button');

  // Nav carries the wishlist link with count badge.
  ok(r.text.includes('/wishlist') && r.text.includes('data-fav-count'), 'nav has wishlist link + count badge');

  // --- [merchhearts] typed merch favorites + product likes ---
  const jdel = (creq, p, obj) => creq('DELETE', p, {
    body: JSON.stringify(obj || {}), headers: { 'content-type': 'application/json' },
  });
  const mw = 'pf-tee-realism-wolf'; // live POD product in merchCatalog

  r = await jpost(guest, '/api/favorites/' + mw, { type: 'merch' });
  ok(r.status === 401, 'guest POST merch favorite -> 401');

  r = await jpost(user, '/api/favorites/' + mw, { type: 'merch' });
  ok(r.status === 200 && r.json && r.json.favorited === true && r.json.type === 'merch',
    'POST merch favorite adds (typed)');

  r = await user('GET', '/api/favorites');
  ok(r.json.ids.includes(mw) && r.json.items.some((i) => i.id === mw && i.type === 'merch'),
    'favorites list carries the merch item with type merch');
  ok(r.json.items.some((i) => i.id === d2 && i.type === 'design'),
    'design favorites still report type design');

  const favRow = wdb.prepare('SELECT item_type FROM user_favorites WHERE design_id = ?').get(mw);
  ok(favRow && favRow.item_type === 'merch', 'user_favorites row stores item_type merch');

  r = await jpost(user, '/api/favorites/no-such-product', { type: 'merch' });
  ok(r.status === 404, 'favoriting a missing merch product -> 404');

  r = await jpost(user, '/api/favorites/' + mw);
  ok(r.status === 404, 'merch id without type=merch is not a design -> 404');

  r = await jpost(user, '/api/favorites/merge', {
    items: [{ id: 'amazon-saniderm', type: 'merch' }, { id: 'bogus-merch', type: 'merch' }, { id: mw, type: 'merch' }],
  });
  ok(r.status === 200 && r.json.ids.includes('amazon-saniderm') && !r.json.ids.includes('bogus-merch'),
    'typed merge adds merch, skips invalid, dedupes');

  r = await jdel(user, '/api/favorites/' + mw, { type: 'merch' });
  ok(r.status === 200 && r.json.favorited === false, 'DELETE merch favorite removes');
  r = await user('GET', '/api/favorites');
  ok(!r.json.ids.includes(mw) && r.json.ids.includes(d2) && r.json.ids.includes('amazon-saniderm'),
    'merch delete leaves design + other merch favorites intact');

  // Product likes: signed-in vote moves the public count, dedupes, unlikes.
  const koi = 'pf-tee-koi-fish';
  r = await jpost(user, '/api/likes/' + koi, { type: 'merch' });
  ok(r.status === 200 && r.json && r.json.liked === true && r.json.type === 'merch' && r.json.like_count === 1,
    'signed-in merch like -> count 1');
  r = await jpost(user, '/api/likes/' + koi, { type: 'merch' });
  ok(r.status === 200 && r.json.like_count === 1, 'repeat merch like dedupes');
  r = await jdel(user, '/api/likes/' + koi, { type: 'merch' });
  ok(r.status === 200 && r.json.liked === false && r.json.like_count === 0, 'merch unlike decrements to 0');
  const mcRow = wdb.prepare('SELECT like_count FROM merch_like_counts WHERE merch_id = ?').get(koi);
  ok(mcRow && Number(mcRow.like_count) === 0, 'merch_like_counts rollup matches');

  r = await jpost(user, '/api/likes/no-such-product', { type: 'merch' });
  ok(r.status === 404, 'liking a missing merch product -> 404');

  // Design likes through the shared handler are unchanged (default type).
  r = await jpost(user, '/api/likes/' + d2, {});
  ok(r.status === 200 && r.json.liked === true && r.json.like_count === 1 && !('type' in r.json),
    'design like keeps its original response shape');
  r = await jdel(user, '/api/likes/' + d2, {});
  ok(r.status === 200 && r.json.like_count === 0, 'design unlike still works');

  // Merch page renders product hearts for guests; wishlist embeds the
  // merch display data so hearted products can render next to designs.
  r = await guest('GET', '/merch');
  ok(r.status === 200 && r.text.includes('data-fav-id="' + mw + '"') && r.text.includes('data-fav-type="merch"'),
    'merch cards carry merch heart buttons');
  ok(r.text.includes('data-like-count="' + mw + '"'), 'merch cards carry public like counts');
  r = await user('GET', '/wishlist');
  ok(r.status === 200 && r.text.includes('TAC_MERCH_ITEMS') && r.text.includes('amazon-saniderm'),
    'wishlist embeds merch display data');

  wdb.close();
}

module.exports = { runHttpTests };
