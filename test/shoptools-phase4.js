// Phase 4 shop toolset: social layer + customer journal tests.
// The coordinator (test/run.js) wires this in; do not run from here.
// Mirrors test/founding.js: runDbTests(ok) runs with the suite's db handle
// (before db.close()); runHttpTests(ok, req) runs against the suite's
// HTTP server on port 4137.
const db = require('../src/db');
const core = require('../src/lib/socialCore');
const { screenText } = require('../src/lib/screening');

async function mkUser(email, role = 'customer') {
  return db.insert('users', {
    email, password_hash: 'x', role, display_name: email.split('@')[0],
  });
}

async function mkBooking(customerId, shopId, status, artistId) {
  return db.insert('bookings', {
    shop_user_id: shopId,
    customer_user_id: customerId,
    staff_id: artistId || null,
    start_at: Date.now() - 86400000,
    end_at: Date.now() - 82800000,
    status,
    deposit_cents: 5000,
  });
}

async function mkPayment(bookingId, status = 'paid') {
  return db.insert('booking_payments', {
    booking_id: bookingId, kind: 'deposit',
    base_cents: 5000, platform_fee_cents: 250, processing_cents: 241,
    total_cents: 5491, status,
  });
}

async function runDbTests(ok) {
  console.log('social layer + journal:');
  const customer = await mkUser('p4customer@test.local');
  const other = await mkUser('p4other@test.local');
  const artist = await mkUser('p4artist@test.local', 'design_artist');
  const shop = await mkUser('p4shop@test.local', 'tattoo_shop');
  const design = await db.insert('designs', { title: 'P4 piece', artist_id: artist });

  // --- Healed-post likes: idempotent, likes_count correct ---
  const postId = await db.insert('healed_posts', {
    customer_user_id: customer, artist_user_id: artist,
    photo_path: 'uploads/photos/p4.jpg', caption: 'Healed great!', likes_count: 0,
  });
  let r = await core.likePost(postId, other);
  ok(r.liked && r.likes_count === 1, 'like: liked=true, count 1');
  r = await core.likePost(postId, other);
  ok(r.liked && r.likes_count === 1, 'second like idempotent: count stays 1');
  ok((await db.all('SELECT * FROM healed_likes WHERE post_id = ?', [postId])).length === 1,
    'exactly one like row after double like');
  r = await core.likePost(postId, customer);
  ok(r.likes_count === 2, 'second user likes: count 2');
  r = await core.unlikePost(postId, other);
  ok(!r.liked && r.likes_count === 1, 'unlike: liked=false, count 1');
  r = await core.unlikePost(postId, other);
  ok(r.likes_count === 1, 'second unlike idempotent: count stays 1');
  let notFound = '';
  try { await core.likePost('nope', other); } catch (e) { notFound = e.code; }
  ok(notFound === 'NOT_FOUND', 'liking a missing post throws NOT_FOUND');

  // --- Follows: composite-PK duplicate rejected ---
  await core.followUser(customer, artist);
  ok((await db.get('SELECT * FROM follows WHERE follower_user_id = ? AND followed_user_id = ?',
    [customer, artist])) !== null, 'follow row written');
  let dup = '';
  try { await core.followUser(customer, artist); } catch (e) { dup = e.code; }
  ok(dup === 'DUPLICATE', 'duplicate follow rejected (composite PK)');
  // The DB-level constraint itself fires, not just our guard:
  let dbLevel = '';
  try {
    await db.query('INSERT INTO follows (follower_user_id, followed_user_id, created_at) VALUES (?, ?, ?)',
      [customer, artist, Date.now()]);
  } catch (e) { dbLevel = e.message; }
  ok(/unique|duplicate/i.test(dbLevel), 'raw duplicate follow insert violates the composite PK');
  let self = '';
  try { await core.followUser(customer, customer); } catch (e) { self = e.code; }
  ok(self === 'SELF', 'cannot follow yourself');
  await core.unfollowUser(customer, artist);
  ok(!(await db.get('SELECT * FROM follows WHERE follower_user_id = ? AND followed_user_id = ?',
    [customer, artist])), 'unfollow removes the row');

  // --- Reviews: eligibility enforcement ---
  // 1. Not completed -> rejected.
  const bPending = await mkBooking(customer, shop, 'pending_deposit', artist);
  await mkPayment(bPending, 'paid');
  let chk = await core.reviewEligibility(customer, bPending);
  ok(!chk.ok && chk.reason === 'not_completed', 'review rejected for incomplete booking');
  // 2. Completed but unpaid -> rejected.
  const bUnpaid = await mkBooking(customer, shop, 'completed', artist);
  let chk2 = await core.reviewEligibility(customer, bUnpaid);
  ok(!chk2.ok && chk2.reason === 'unpaid', 'review rejected for completed-but-unpaid booking');
  // 3. Not the customer -> rejected.
  const bGood = await mkBooking(customer, shop, 'completed', artist);
  await mkPayment(bGood, 'paid');
  ok(!(await core.reviewEligibility(other, bGood)).ok, "cannot review someone else's booking");
  // 4. Completed + paid -> accepted.
  const reviewId = await core.createReview(customer, bGood, 5, 'Amazing work!');
  const review = await db.get('SELECT * FROM reviews WHERE id = ?', [reviewId]);
  ok(review && review.rating === 5 && review.shop_user_id === shop && review.artist_user_id === artist,
    'completed+paid booking accepts a review with shop+artist attribution');
  // 5. Second review for the same booking -> rejected (UNIQUE booking_id).
  let again = '';
  try { await core.createReview(customer, bGood, 4, 'Second try'); } catch (e) { again = e.code; }
  ok(again === 'already_reviewed', 'second review for the same booking rejected');
  // 6. Bad rating -> rejected.
  const bGood2 = await mkBooking(customer, shop, 'completed', artist);
  await mkPayment(bGood2, 'paid');
  let bad = '';
  try { await core.createReview(customer, bGood2, 6, 'x'); } catch (e) { bad = e.code; }
  ok(bad === 'BAD_RATING', 'rating outside 1-5 rejected');
  let missing = '';
  try { await core.createReview(customer, 'nope', 5, 'x'); } catch (e) { missing = e.code; }
  ok(missing === 'not_found', 'review for a missing booking rejected');

  // --- Design boards ---
  const boardId = await core.createBoard(customer, 'Dream sleeves');
  await core.addBoardItem(boardId, design);
  let bdup = '';
  try { await core.addBoardItem(boardId, design); } catch (e) { bdup = e.code; }
  ok(bdup === 'DUPLICATE', 'duplicate board add rejected (composite PK)');
  let full = await core.boardWithItems(boardId);
  ok(full.items.length === 1 && full.items[0].id === design, 'board detail lists the design');
  await core.removeBoardItem(boardId, design);
  full = await core.boardWithItems(boardId);
  ok(full.items.length === 0, 'board remove empties the board');
  await core.removeBoardItem(boardId, design); // idempotent
  ok(true, 'removing a non-member design is a no-op');

  // --- Journal entries ---
  const entryId = await db.insert('journal_entries', {
    customer_user_id: customer, booking_id: bGood, design_id: design,
    caption: 'Sitting went great.', happened_at: Date.now(),
  });
  ok((await db.get('SELECT * FROM journal_entries WHERE id = ?', [entryId])).booking_id === bGood,
    'journal entry links booking + design');

  // --- Trending: ranked by posts + likes in the last 30 days ---
  const artist2 = await mkUser('p4artist2@test.local', 'design_artist');
  const p1 = await db.insert('healed_posts', {
    customer_user_id: customer, artist_user_id: artist,
    photo_path: 'uploads/photos/t1.jpg', caption: 'one', likes_count: 0,
  });
  const p2 = await db.insert('healed_posts', {
    customer_user_id: customer, artist_user_id: artist,
    photo_path: 'uploads/photos/t2.jpg', caption: 'two', likes_count: 0,
  });
  const p3 = await db.insert('healed_posts', {
    customer_user_id: customer, artist_user_id: artist2,
    photo_path: 'uploads/photos/t3.jpg', caption: 'three', likes_count: 0,
  });
  // Old post: outside the 30-day window, must not count.
  await db.insert('healed_posts', {
    customer_user_id: customer, artist_user_id: artist2,
    photo_path: 'uploads/photos/t4.jpg', caption: 'old',
    likes_count: 50, created_at: Date.now() - 60 * 86400000,
  });
  await core.likePost(p1, other);     // artist: 2 recent posts + 2 likes
  await core.likePost(p2, other);
  await core.likePost(p3, other);     // artist2: 1 recent post + 1 like
  const trending = await core.trendingArtists(20, 30);
  ok(trending.length === 2, 'two trending artists');
  ok(trending[0].artist_id === artist && Number(trending[0].activity) === 6,
    'top artist: 3 posts + 3 likes = 6 activity');
  ok(trending[1].artist_id === artist2 && Number(trending[1].activity) === 2,
    'second artist: 1 post + 1 like = 2 (old post excluded)');
  ok((await core.trendingArtists(1, 30)).length === 1, 'trending limit respected');

  // --- Content screening gates captions/comments/reviews/announcements ---
  ok(!screenText('Email me at a@b.com about the tattoo').ok, 'email caption fails screening');
  ok(!screenText('DM me on instagram for details').ok, 'DM solicitation fails screening');
  ok(screenText('Healed perfectly, no regrets!').ok, 'clean caption passes screening');

  // HTTP fixtures: a real-password customer with a completed+paid booking,
  // and a shop with an active subscription (for POST /social/announce).
  const bcrypt = require('bcryptjs');
  const httpUser = await mkUser('p4http@test.local');
  await db.update('users', httpUser, { password_hash: await bcrypt.hash('P4Test123!', 10) });
  const httpBooking = await mkBooking(httpUser, shop, 'completed', artist);
  await mkPayment(httpBooking, 'paid');
  // Idempotent cleanup: a previous partial run may have left HTTP-phase
  // rows behind (follows, reviews). The suite runs each phase once, but
  // keep the fixtures clean anyway.
  await db.query('DELETE FROM follows WHERE follower_user_id = ?', [httpUser]);
  await db.query('DELETE FROM reviews WHERE booking_id = ?', [httpBooking]);
  const httpShop = await mkUser('p4httshop@test.local', 'tattoo_shop');
  await db.update('users', httpShop, { password_hash: await bcrypt.hash('P4Test123!', 10) });
  const shopPlan = await db.get(`SELECT id FROM plans WHERE slug = 'tattoo_shop'`);
  if (shopPlan) await db.insert('subscriptions', { user_id: httpShop, plan_id: shopPlan.id, status: 'active' });
  // A completed+paid booking at httpShop, already reviewed, so the public
  // shop-reviews page has a 5-star average before the HTTP phase runs.
  const httpShopCustomer = await mkUser('p4shopcustomer@test.local');
  const httpShopBooking = await mkBooking(httpShopCustomer, httpShop, 'completed', null);
  await mkPayment(httpShopBooking, 'paid');
  await core.createReview(httpShopCustomer, httpShopBooking, 5, 'Great shop!');
}

// HTTP phase. Assumes the suite's server is up on :4137 with the DB above.
// NOTE: the suite's shared db handle is closed before the HTTP phase, so
// this opens its own read-only handle (same pattern as founding.js).
async function runHttpTests(ok, req) {
  console.log('social layer + journal (http):');
  let r, body;
  const Database = require('better-sqlite3');
  const tdb = new Database(process.env.SQLITE_PATH, { readonly: true });
  const me = tdb.prepare(`SELECT id FROM users WHERE email = 'p4http@test.local'`).get();
  const shopU = tdb.prepare(`SELECT id FROM users WHERE email = 'p4httshop@test.local'`).get();
  const booking = tdb.prepare(`SELECT id FROM bookings WHERE customer_user_id = ?`).get(me.id);
  tdb.close();

  // Cookie-jar requests (redirects followed manually so Set-Cookie survives).
  async function jarReq(jar, method, p, body, headers = {}) {
    const h = { ...headers };
    const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) h.cookie = cookies;
    let payload = body;
    if (body && typeof body === 'object' && !(body instanceof URLSearchParams)) {
      payload = new URLSearchParams(body);
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(`http://localhost:4137${p}`, {
      method, headers: h, body: payload, redirect: 'manual',
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [k, v] = c.split(';')[0].split('=');
      jar[k.trim()] = (v || '').trim();
    }
    const location = res.headers.get('location');
    if (location && res.status >= 300 && res.status < 400) {
      return jarReq(jar, 'GET', new URL(location, 'http://localhost:4137').pathname);
    }
    return { status: res.status, text: await res.text() };
  }

  // Public pages.
  r = await req('GET', '/social/trending', { headers: { accept: 'application/json' } });
  body = JSON.parse(r.text);
  ok(r.status === 200 && body.ok && body.artists.length === 2 && body.artists[0].activity >= body.artists[1].activity,
    'GET /social/trending JSON returns ranked artists');
  r = await req('GET', `/social/reviews/shop/${shopU.id}`, { headers: { accept: 'application/json' } });
  body = JSON.parse(r.text);
  ok(r.status === 200 && body.ok && body.count >= 1 && body.average === 5,
    'public shop reviews JSON includes the 5-star average');
  r = await req('GET', `/social/reviews/shop/${shopU.id}`);
  ok(r.status === 200 && r.text.includes('5 / 5'), 'public shop reviews HTML renders the average');
  r = await req('GET', `/social/announcements/${shopU.id}`);
  ok(r.status === 200 && r.text.includes('announcements'), 'shop announcements page renders');

  // Anonymous clients: the journal redirects to login; the healed wall is a
  // public discovery feed (the route serves anonymous viewers explicitly).
  // (Uses a cookieless fetch — the shared `req` jar carries logins from earlier suite phases.)
  async function anonReq(p, headers = {}) {
    const res = await fetch(`http://localhost:4137${p}`, { headers: headers, redirect: 'manual' });
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }
  r = await anonReq('/journal');
  ok(r.status === 302 && (r.location || '').includes('/login'), 'journal redirects to login when anonymous');
  r = await anonReq('/social/healed', { accept: 'application/json' });
  ok(r.status === 200 && JSON.parse(r.text).ok === true, 'anonymous JSON healed feed is public (discovery wall)');

  // Login as the customer.
  const jar = {};
  r = await jarReq(jar, 'POST', '/login', { email: 'p4http@test.local', password: 'P4Test123!' });
  ok(r.status === 200, 'customer login ok');

  // Healed wall JSON + HTML once logged in.
  r = await jarReq(jar, 'GET', '/social/healed', null, { accept: 'application/json' });
  body = JSON.parse(r.text);
  ok(r.status === 200 && body.ok && Array.isArray(body.posts) && body.posts.length >= 3,
    'GET /social/healed returns JSON posts');
  r = await jarReq(jar, 'GET', '/social/healed');
  ok(r.status === 200 && r.text.includes('Healed results'), 'GET /social/healed renders HTML');

  // Journal: entry create + timeline JSON.
  r = await jarReq(jar, 'POST', '/journal/entries', { caption: 'Day one of healing.' });
  ok(r.status === 200 && r.text.includes('My tattoo journal'), 'journal entry posts and lands on the timeline');
  r = await jarReq(jar, 'GET', '/journal', null, { accept: 'application/json' });
  body = JSON.parse(r.text);
  const kinds = body.timeline.map((e) => e.kind);
  ok(body.ok && kinds.includes('journal') && kinds.includes('booking'),
    'journal JSON timeline merges entries + bookings chronologically');
  ok(Array.isArray(body.boards), 'journal JSON includes boards');

  // Healed wall: like flow through HTTP.
  const postId = body.timeline.find((e) => e.kind === 'healed')?.post.id
    || (JSON.parse((await jarReq(jar, 'GET', '/social/healed', null, { accept: 'application/json' })).text)).posts[0].id;
  r = await jarReq(jar, 'POST', `/social/healed/${postId}/like`, null, { accept: 'application/json' });
  body = JSON.parse(r.text);
  ok(r.status === 200 && body.ok && body.liked === true, 'HTTP like works');
  r = await jarReq(jar, 'GET', '/social/healed', null, { accept: 'application/json' });
  const liked = JSON.parse(r.text).posts.find((p) => p.id === postId);
  ok(liked.liked_by_viewer === 1, 'feed marks the post liked by the viewer');

  // Follow flow + duplicate rejected.
  const artistRow = (() => {
    const d2 = new Database(process.env.SQLITE_PATH, { readonly: true });
    const a = d2.prepare(`SELECT id FROM users WHERE email = 'p4artist@test.local'`).get();
    d2.close();
    return a;
  })();
  r = await jarReq(jar, 'POST', `/social/follow/${artistRow.id}`, { back: '/social/feed' }, { accept: 'application/json' });
  ok(JSON.parse(r.text).ok === true, 'HTTP follow works');
  r = await jarReq(jar, 'POST', `/social/follow/${artistRow.id}`, { back: '/social/feed' });
  ok(r.text.includes('already follow'), 'duplicate HTTP follow rejected with a friendly message');

  // Design boards over HTTP.
  r = await jarReq(jar, 'POST', '/social/boards', { name: 'HTTP board' }, { accept: 'application/json' });
  const boardId = JSON.parse(r.text).board_id;
  ok(r.status === 201 && boardId, 'board created over HTTP');
  const designRow = (() => {
    const d3 = new Database(process.env.SQLITE_PATH, { readonly: true });
    const d = d3.prepare(`SELECT id FROM designs WHERE title = 'P4 piece'`).get();
    d3.close();
    return d;
  })();
  r = await jarReq(jar, 'POST', `/social/boards/${boardId}/add`, { design_id: designRow.id });
  ok(r.text.includes(designRow.id) || r.status === 200, 'design added to board');
  r = await jarReq(jar, 'GET', `/social/boards/${boardId}`, null, { accept: 'application/json' });
  body = JSON.parse(r.text);
  ok(body.ok && body.board.items.length === 1 && body.board.items[0].id === designRow.id,
    'board detail JSON lists the added design');
  r = await jarReq(jar, 'POST', `/social/boards/${boardId}/remove`, { design_id: designRow.id });
  r = await jarReq(jar, 'GET', `/social/boards/${boardId}`, null, { accept: 'application/json' });
  ok(JSON.parse(r.text).board.items.length === 0, 'board remove empties the board');

  // Reviews over HTTP: completed+paid booking accepted, duplicate rejected.
  r = await jarReq(jar, 'POST', '/social/reviews',
    { booking_id: booking.id, rating: '5', body: 'Fantastic experience.' },
    { accept: 'application/json' });
  ok(r.status === 201 && JSON.parse(r.text).ok === true, 'HTTP review accepted for completed+paid booking');
  r = await jarReq(jar, 'POST', '/social/reviews',
    { booking_id: booking.id, rating: '4', body: 'Again.' },
    { accept: 'application/json' });
  body = JSON.parse(r.text);
  ok(r.status === 422 && body.ok === false && body.code === 'already_reviewed',
    'second HTTP review for the same booking rejected');
  r = await jarReq(jar, 'POST', '/social/reviews',
    { booking_id: 'nope', rating: '5', body: 'Ghost.' },
    { accept: 'application/json' });
  ok(r.status === 422, 'review for a missing booking rejected over HTTP');
  // Screening gate over HTTP.
  r = await jarReq(jar, 'POST', '/social/reviews',
    { booking_id: booking.id, rating: '5', body: 'Email me at a@b.com' },
    { accept: 'application/json' });
  ok(r.status === 422 && JSON.parse(r.text).ok === false, 'review with contact info rejected by screening');

  // Healed photo upload over HTTP (multipart; photo required).
  const fd = new FormData();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  fd.append('photo', new Blob([png], { type: 'image/png' }), 'healed.png');
  fd.append('caption', 'Freshly healed upload');
  const cookieHdr = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  let up = await fetch('http://localhost:4137/social/healed', {
    method: 'POST', headers: { cookie: cookieHdr }, body: fd, redirect: 'manual',
  });
  ok(up.status === 302, 'multipart healed upload accepted');
  r = await jarReq(jar, 'GET', '/social/healed', null, { accept: 'application/json' });
  const uploaded = JSON.parse(r.text).posts.find((p) => p.caption === 'Freshly healed upload');
  ok(uploaded && uploaded.photo_path && uploaded.photo_path.startsWith('photos/'),
    'uploaded healed post stored under the upload-dir photos dir');

  // Shop login -> announce -> a follower's feed shows it.
  const shopJar = {};
  r = await jarReq(shopJar, 'POST', '/login', { email: 'p4httshop@test.local', password: 'P4Test123!' });
  ok(r.status === 200, 'shop login ok');
  r = await jarReq(shopJar, 'POST', '/social/announce', { body: 'Guest artist this weekend!' });
  ok(r.status === 200 && r.text.includes('Announcement posted'), 'announcement post accepted (flash confirms)');
  r = await req('GET', `/social/announcements/${shopU.id}`);
  ok(r.text.includes('Guest artist this weekend'), 'public announcements page shows the new post');
  // The shop's own feed does not include its announcement (no self-follow);
  // a follower sees it.
  await jarReq(jar, 'POST', `/social/follow/${shopU.id}`, { back: '/social/feed' });
  r = await jarReq(jar, 'GET', '/social/feed', null, { accept: 'application/json' });
  body = JSON.parse(r.text);
  ok(body.items.some((i) => i.kind === 'announcement' && i.body === 'Guest artist this weekend!'),
    "follower's feed includes the shop announcement");

  // Feed JSON includes followed content.
  r = await jarReq(jar, 'GET', '/social/feed', null, { accept: 'application/json' });
  body = JSON.parse(r.text);
  ok(body.ok && Array.isArray(body.items), 'feed JSON returns items for followed artists');
}

module.exports = { runDbTests, runHttpTests };
