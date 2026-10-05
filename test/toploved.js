// Top-loved leaderboard tests ([toploved]).
// The coordinator (test/run.js) wires this in; do not run from here.
const { randomUUID } = require('crypto');

async function runHttpTests(ok, req) {
  console.log('toploved (leaderboard):');
  const Database = require('better-sqlite3');
  const tdb = new Database(process.env.SQLITE_PATH);

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
  const jdel = (creq, p, obj) => creq('DELETE', p, {
    body: JSON.stringify(obj || {}), headers: { 'content-type': 'application/json' },
  });
  const form = (obj) => ({
    body: new URLSearchParams(obj), headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });

  // Seed three approved gallery designs.
  const d1 = 'love-test-' + randomUUID().slice(0, 8);
  const d2 = 'love-test-' + randomUUID().slice(0, 8);
  const d3 = 'love-test-' + randomUUID().slice(0, 8);
  const ins = tdb.prepare(`INSERT INTO designs
    (id, title, description, style, categories, status, listing_type, listing_scope, price_cents, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run(d1, 'Love Test One', 'desc', 'blackwork', '[]', 'approved', 'predesign', 'gallery', 7500, Date.now());
  ins.run(d2, 'Love Test Two', 'desc', 'blackwork', '[]', 'approved', 'predesign', 'gallery', 7500, Date.now());
  ins.run(d3, 'Love Test Three', 'desc', 'blackwork', '[]', 'approved', 'predesign', 'gallery', 7500, Date.now());

  const guest = makeClient();
  const vk1 = randomUUID();
  const vk2 = randomUUID();

  // Guest like ping increments.
  let r = await jpost(guest, '/api/likes/' + d1, { voter_key: vk1 });
  ok(r.status === 200 && r.json && r.json.liked === true && r.json.like_count === 1,
    'guest POST like -> 200, count 1');
  // Same voter_key again: dedupe, count stays 1.
  r = await jpost(guest, '/api/likes/' + d1, { voter_key: vk1 });
  ok(r.status === 200 && r.json.like_count === 1, 'repeat like from same voter_key dedupes');
  // Second voter: count 2.
  r = await jpost(guest, '/api/likes/' + d1, { voter_key: vk2 });
  ok(r.status === 200 && r.json.like_count === 2, 'second voter increments to 2');

  // Unlike decrements; second unlike floors at the true count.
  r = await jdel(guest, '/api/likes/' + d1, { voter_key: vk1 });
  ok(r.status === 200 && r.json.liked === false && r.json.like_count === 1,
    'DELETE unlike decrements to 1');
  r = await jdel(guest, '/api/likes/' + d1, { voter_key: vk1 });
  ok(r.status === 200 && r.json.like_count === 1, 'repeat unlike does not go below true count');
  r = await jdel(guest, '/api/likes/' + d1, { voter_key: vk2 });
  ok(r.status === 200 && r.json.like_count === 0, 'last unlike floors at 0');

  // Validation.
  r = await jpost(guest, '/api/likes/no-such-design', { voter_key: vk1 });
  ok(r.status === 404, 'liking a missing design -> 404');
  r = await jpost(guest, '/api/likes/' + d2, {});
  ok(r.status === 400, 'guest like without voter_key -> 400');
  r = await jpost(guest, '/api/likes/' + d2, { voter_key: 'x' });
  ok(r.status === 400, 'guest like with junk voter_key -> 400');

  // Logged-in user: voter_key comes from the session, body not needed.
  const user = makeClient();
  r = await user('POST', '/signup', { ...form({ display_name: 'Lover', email: 'lover@test.local', password: 'password123' }), follow: false });
  ok(r.status === 302, 'signup redirects');
  r = await jpost(user, '/api/likes/' + d2, {});
  ok(r.status === 200 && r.json.like_count === 1, 'logged-in like works without voter_key');
  const likeRow = tdb.prepare('SELECT voter_key FROM design_likes WHERE design_id = ?').get(d2);
  ok(likeRow && likeRow.voter_key.indexOf('user:') === 0, 'logged-in vote keyed by user id');

  // Backfill: existing wishlist favorites become likes (same SQL as migration 055).
  const u1 = tdb.prepare('SELECT id FROM users WHERE email = ?').get('lover@test.local').id;
  const u2 = 'user-' + randomUUID().slice(0, 8);
  tdb.prepare('INSERT INTO users (id, email, password_hash, role, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(u2, 'lover2@test.local', 'x', 'customer', 'Lover2', Date.now());
  tdb.prepare('INSERT INTO user_favorites (user_id, design_id, created_at) VALUES (?, ?, ?)')
    .run(u1, d3, Date.now());
  tdb.prepare('INSERT INTO user_favorites (user_id, design_id, created_at) VALUES (?, ?, ?)')
    .run(u2, d3, Date.now());
  tdb.exec(`INSERT INTO design_likes (design_id, voter_key, created_at)
    SELECT design_id, 'user:' || user_id, created_at FROM user_favorites uf
    WHERE NOT EXISTS (
      SELECT 1 FROM design_likes dl
      WHERE dl.design_id = uf.design_id AND dl.voter_key = 'user:' || uf.user_id
    )`);
  tdb.exec(`DELETE FROM design_like_counts`);
  tdb.exec(`INSERT INTO design_like_counts (design_id, like_count)
    SELECT design_id, COUNT(*) FROM design_likes GROUP BY design_id`);
  const bf = tdb.prepare('SELECT like_count FROM design_like_counts WHERE design_id = ?').get(d3);
  ok(bf && bf.like_count === 2, 'backfill: 2 favorites -> like_count 2');

  // Leaderboard page: ranked most-loved first, counts shown, zero-like designs trail.
  r = await guest('GET', '/top-loved');
  ok(r.status === 200 && r.text.includes('design-card'), 'top-loved page renders');
  const i3 = r.text.indexOf(d3);
  const i2 = r.text.indexOf(d2);
  const i1 = r.text.indexOf(d1);
  ok(i3 >= 0 && i2 >= 0 && i1 >= 0 && i3 < i2 && i2 < i1,
    'top-loved orders d3 (2) > d2 (1) > d1 (0)');
  ok(r.text.includes('♥ 2') && r.text.includes('♥ 1'), 'like counts shown on cards');
  // Nav carries the top-loved link.
  r = await guest('GET', '/gallery');
  ok(r.text.includes('href="/top-loved"'), 'nav has top-loved link');
  // Hearts on the leaderboard page also toggle favorites.
  r = await guest('GET', '/top-loved');
  ok(r.text.includes('data-fav-id'), 'top-loved cards carry heart buttons');

  // Urgency badges: earned by real activity only, never faked.
  const NOW = Date.now();
  const OLD = NOW - 10 * 24 * 3600 * 1000; // outside the 7-day velocity window
  const dA = 'love-test-' + randomUUID().slice(0, 8);
  const dB = 'love-test-' + randomUUID().slice(0, 8);
  const dC = 'love-test-' + randomUUID().slice(0, 8);
  const dD = 'love-test-' + randomUUID().slice(0, 8);
  const dE = 'love-test-' + randomUUID().slice(0, 8);
  [dA, dB, dC, dD, dE].forEach((id, k) =>
    ins.run(id, 'Love Test Badge ' + k, 'desc', 'blackwork', '[]', 'approved', 'predesign', 'gallery', 7500, NOW));
  const likeIns = tdb.prepare('INSERT INTO design_likes (design_id, voter_key, created_at) VALUES (?, ?, ?)');
  const addLikes = (id, n, ts) => { for (let k = 0; k < n; k++) likeIns.run(id, 'guest:' + randomUUID(), ts); };
  addLikes(dA, 10, OLD); // rank 1 -> Most loved
  addLikes(dB, 9, OLD);  // rank 2 -> Most wanted
  addLikes(dC, 8, OLD);  // rank 3 -> Most wanted
  addLikes(dD, 5, NOW);  // rank 4, hot this week -> Trending
  addLikes(dE, 1, NOW);  // selling fast via real paid orders below
  tdb.exec('DELETE FROM design_like_counts');
  tdb.exec('INSERT INTO design_like_counts (design_id, like_count) SELECT design_id, COUNT(*) FROM design_likes GROUP BY design_id');
  const ordIns = tdb.prepare(`INSERT INTO orders (id, buyer_id, design_id, order_type, amount_cents, status, created_at, paid_at)
    VALUES (?, ?, ?, 'premade', 7500, 'paid', ?, ?)`);
  ordIns.run('ord-' + randomUUID().slice(0, 8), 'buyer-x', dE, NOW, NOW);
  ordIns.run('ord-' + randomUUID().slice(0, 8), 'buyer-y', dE, NOW, NOW);

  r = await guest('GET', '/top-loved');
  const cards = r.text.split('<article class="design-card">').slice(1);
  ok(cards.length >= 5, 'leaderboard renders badge-test cards');
  ok(cards[0].includes(dA) && cards[0].includes('Most loved'), 'rank 1 earns Most loved');
  ok(cards[1].includes(dB) && cards[1].includes('Most wanted'), 'rank 2 earns Most wanted');
  ok(cards[2].includes(dC) && cards[2].includes('Most wanted'), 'rank 3 earns Most wanted');
  ok(cards[3].includes(dD) && cards[3].includes('Trending'), 'hot-this-week design earns Trending');
  const dEcard = cards.find(c => c.includes(dE));
  ok(dEcard && dEcard.includes('Selling fast'), '2 paid orders in 7 days earns Selling fast');
  ok(!cards[cards.length - 1].includes('Most loved') && !cards[cards.length - 1].includes('Trending'),
    'trailing zero-like design gets no badge');

  tdb.close();
}

module.exports = { runHttpTests };
