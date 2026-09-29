// Phase 4 social layer. Mounted at /social by the coordinator — all routes
// here are relative to that mount. Response shape: JSON when the client
// asks for application/json, EJS views otherwise (app WebView consumes some
// of these as pages).
const express = require('express');
const db = require('../db');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter } = require('../middleware/rateLimit');
const { screenText } = require('../lib/screening');
const { notifyUser } = require('../lib/notify');
const { handlePhotoUpload, photoRelPath } = require('../lib/socialUpload');
const core = require('../lib/socialCore');

const router = express.Router();

function wantsJson(req) {
  return (req.headers.accept || '').includes('application/json');
}

function flashBack(req, res, msg, back = '/social/healed') {
  if (wantsJson(req)) return res.status(422).json({ ok: false, error: msg });
  req.session.flash = msg;
  return res.redirect(back);
}

function screenFail(reason) {
  return 'That text looks like it contains contact or payment info (' +
    reason + ') — all contact stays through the site, so we could not post it.';
}

// ---- Public reads (before requireLogin) ----

// Shop announcements for one shop (public — shops broadcast these).
router.get('/announcements/:shopId', async (req, res) => {
  const shop = await db.get(`SELECT id, display_name FROM users WHERE id = ?`, [req.params.shopId]);
  if (!shop) return res.status(404).render('error', { title: 'Not found', message: 'Shop not found.' });
  const posts = await db.all(
    `SELECT * FROM shop_announcements WHERE shop_user_id = ? ORDER BY created_at DESC LIMIT 50`,
    [shop.id]);
  if (wantsJson(req)) return res.json({ ok: true, shop, announcements: posts });
  res.render('social/announcements', { title: `${shop.display_name || 'Shop'} announcements`, shop, posts });
});

// Public reviews for a shop or an artist, with averages.
async function reviewsFor(kind, id) {
  const col = kind === 'shop' ? 'shop_user_id' : 'artist_user_id';
  const rows = await db.all(
    `SELECT r.*, u.display_name AS customer_name
     FROM reviews r
     JOIN users u ON u.id = r.customer_user_id
     WHERE r.${col} = ? ORDER BY r.created_at DESC`, [id]);
  const avg = rows.length
    ? Math.round((rows.reduce((s, r) => s + r.rating, 0) / rows.length) * 10) / 10
    : null;
  return { reviews: rows, average: avg, count: rows.length };
}

router.get('/reviews/shop/:shopId', async (req, res) => {
  const data = await reviewsFor('shop', req.params.shopId);
  if (wantsJson(req)) return res.json({ ok: true, kind: 'shop', shop_id: req.params.shopId, ...data });
  res.render('social/reviews', { title: 'Shop reviews', subject: 'shop', subjectId: req.params.shopId, ...data });
});

router.get('/reviews/artist/:artistId', async (req, res) => {
  const data = await reviewsFor('artist', req.params.artistId);
  if (wantsJson(req)) return res.json({ ok: true, kind: 'artist', artist_id: req.params.artistId, ...data });
  res.render('social/reviews', { title: 'Artist reviews', subject: 'artist', subjectId: req.params.artistId, ...data });
});

// Trending artists (public discovery): ranked by healed-post activity in the
// last 30 days — pure SQL in src/lib/socialCore.js.
router.get('/trending', async (req, res) => {
  const artists = await core.trendingArtists(20, 30);
  if (wantsJson(req)) return res.json({ ok: true, window_days: 30, artists });
  res.render('social/trending', { title: 'Trending artists', artists });
});

// ---- Healed wall (public read; posting needs login) ----
router.get('/healed', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 20;
  const viewer = req.user ? req.user.id : null;
  const posts = await db.all(
    `SELECT hp.*,
            u.display_name AS author_name,
            a.display_name AS artist_name,
            s.display_name AS shop_name,
            (SELECT COUNT(*) FROM healed_comments c WHERE c.post_id = hp.id) AS comment_count,
            CASE WHEN EXISTS (SELECT 1 FROM healed_likes l WHERE l.post_id = hp.id AND l.user_id = ?)
                 THEN 1 ELSE 0 END AS liked_by_viewer
     FROM healed_posts hp
     JOIN users u ON u.id = hp.customer_user_id
     LEFT JOIN users a ON a.id = hp.artist_user_id
     LEFT JOIN users s ON s.id = hp.shop_user_id
     ORDER BY hp.created_at DESC
     LIMIT ? OFFSET ?`,
    [viewer, perPage, (page - 1) * perPage]);
  const { n } = await db.get('SELECT COUNT(*) AS n FROM healed_posts');
  const payload = { ok: true, page, per_page: perPage, total: n, posts };
  if (wantsJson(req)) return res.json(payload);
  res.render('social/healed', { title: 'Healed results', ...payload });
});

router.use((req, res, next) => {
  // API-style clients get a 401 JSON body instead of the login-page redirect.
  if (!req.user && wantsJson(req)) {
    return res.status(401).json({ ok: false, error: 'Login required.' });
  }
  requireLogin(req, res, next);
});

// ---- Healed wall (posting — login required) ----
router.post('/healed', formLimiter, async (req, res) => {
  const err = await handlePhotoUpload(req, res);
  if (err) return flashBack(req, res, err.message);
  if (!req.file) return flashBack(req, res, 'A healed photo is required.');
  const caption = String(req.body.caption || '').trim().slice(0, 2000);
  if (!caption) return flashBack(req, res, 'Add a short caption with your healed photo.');
  const screen = screenText(caption);
  if (!screen.ok) return flashBack(req, res, screenFail(screen.flags.map((f) => f.label).join(', ')));
  // Optional tags — only keep them when the referenced rows exist.
  async function keepId(table, v) {
    if (!v) return null;
    const row = await db.get(`SELECT id FROM ${table} WHERE id = ?`, [String(v)]);
    return row ? row.id : null;
  }
  const artistId = await keepId('users', req.body.artist_user_id);
  const shopId = await keepId('users', req.body.shop_user_id);
  const designId = await keepId('designs', req.body.design_id);
  const bookingId = await keepId('bookings', req.body.booking_id);
  const id = await db.insert('healed_posts', {
    customer_user_id: req.user.id,
    artist_user_id: artistId,
    shop_user_id: shopId,
    design_id: designId,
    booking_id: bookingId,
    photo_path: photoRelPath(req.file),
    caption,
    likes_count: 0,
    created_at: db.now(),
  });
  if (wantsJson(req)) return res.status(201).json({ ok: true, post_id: id });
  req.session.flash = 'Your healed result is up — thanks for sharing!';
  res.redirect('/social/healed');
});

router.post('/healed/:id/like', formLimiter, async (req, res) => {
  try {
    const r = await core.likePost(req.params.id, req.user.id);
    if (wantsJson(req)) return res.json({ ok: true, ...r });
  } catch (e) {
    if (e.code === 'NOT_FOUND') {
      if (wantsJson(req)) return res.status(404).json({ ok: false, error: 'Post not found.' });
      req.session.flash = 'That post no longer exists.';
      return res.redirect('/social/healed');
    }
    throw e;
  }
  res.redirect('/social/healed');
});

router.post('/healed/:id/unlike', formLimiter, async (req, res) => {
  const r = await core.unlikePost(req.params.id, req.user.id);
  if (wantsJson(req)) return res.json({ ok: true, ...r });
  res.redirect('/social/healed');
});

router.post('/healed/:id/comment', formLimiter, async (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 2000);
  const back = '/social/healed';
  if (!body) return flashBack(req, res, 'Write a comment first.', back);
  const post = await db.get('SELECT id, customer_user_id FROM healed_posts WHERE id = ?', [req.params.id]);
  if (!post) return flashBack(req, res, 'That post no longer exists.', back);
  const screen = screenText(body);
  if (!screen.ok) return flashBack(req, res, screenFail(screen.flags.map((f) => f.label).join(', ')), back);
  await db.insert('healed_comments', {
    post_id: post.id, user_id: req.user.id, body, created_at: db.now(),
  });
  if (post.customer_user_id !== req.user.id) {
    await notifyUser(post.customer_user_id, {
      kind: 'healed_comment',
      title: 'New comment on your healed post',
      body: `${req.user.display_name || 'Someone'} commented: ${body.slice(0, 140)}`,
      link: '/social/healed',
    });
  }
  if (wantsJson(req)) return res.status(201).json({ ok: true });
  req.session.flash = 'Comment posted.';
  res.redirect(back);
});

// ---- Follows ----
router.post('/follow/:userId', formLimiter, async (req, res) => {
  const back = req.body.back || '/social/feed';
  try {
    await core.followUser(req.user.id, req.params.userId);
  } catch (e) {
    return flashBack(req, res, e.message, back);
  }
  const target = await db.get('SELECT display_name FROM users WHERE id = ?', [req.params.userId]);
  await notifyUser(req.params.userId, {
    kind: 'follow',
    title: 'New follower',
    body: `${req.user.display_name || 'Someone'} started following you.`,
    link: '/social/feed',
  });
  if (wantsJson(req)) return res.json({ ok: true, following: true, user_id: req.params.userId });
  req.session.flash = `Following ${target && target.display_name ? target.display_name : 'them'} now.`;
  res.redirect(back);
});

router.post('/unfollow/:userId', formLimiter, async (req, res) => {
  const back = req.body.back || '/social/feed';
  await core.unfollowUser(req.user.id, req.params.userId);
  if (wantsJson(req)) return res.json({ ok: true, following: false, user_id: req.params.userId });
  req.session.flash = 'Unfollowed.';
  res.redirect(back);
});

// ---- Design boards ----
router.get('/boards', async (req, res) => {
  const boards = await db.all(
    `SELECT b.*, (SELECT COUNT(*) FROM board_items bi WHERE bi.board_id = b.id) AS item_count
     FROM design_boards b WHERE b.owner_user_id = ? ORDER BY b.created_at DESC`,
    [req.user.id]);
  const following = await db.all(
    `SELECT u.id, u.display_name, u.role FROM follows f
     JOIN users u ON u.id = f.followed_user_id
     WHERE f.follower_user_id = ? ORDER BY u.display_name`, [req.user.id]);
  if (wantsJson(req)) return res.json({ ok: true, boards });
  res.render('social/boards', { title: 'Your design boards', boards, following });
});

router.post('/boards', formLimiter, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return flashBack(req, res, 'Give your board a name.', '/social/boards');
  const screen = screenText(name);
  if (!screen.ok) return flashBack(req, res, screenFail(screen.flags.map((f) => f.label).join(', ')), '/social/boards');
  const id = await core.createBoard(req.user.id, name);
  if (wantsJson(req)) return res.status(201).json({ ok: true, board_id: id });
  req.session.flash = `Board "${name}" created.`;
  res.redirect(`/social/boards/${id}`);
});

async function ownBoard(req, res) {
  const board = await db.get('SELECT * FROM design_boards WHERE id = ?', [req.params.id]);
  if (!board) {
    if (wantsJson(req)) return res.status(404).json({ ok: false, error: 'Board not found.' }), null;
    return res.status(404).render('error', { title: 'Not found', message: 'Board not found.' }), null;
  }
  if (board.owner_user_id !== req.user.id) {
    if (wantsJson(req)) return res.status(403).json({ ok: false, error: 'That board is not yours.' }), null;
    return res.status(403).render('error', { title: 'Forbidden', message: 'That board is not yours.' }), null;
  }
  return board;
}

router.get('/boards/:id', async (req, res) => {
  const board = await ownBoard(req, res);
  if (!board) return;
  const full = await core.boardWithItems(board.id);
  if (wantsJson(req)) return res.json({ ok: true, board: full });
  res.render('social/board', { title: board.name, board: full });
});

router.post('/boards/:id/add', formLimiter, async (req, res) => {
  const board = await ownBoard(req, res);
  if (!board) return;
  const back = `/social/boards/${board.id}`;
  try {
    await core.addBoardItem(board.id, String(req.body.design_id || ''));
  } catch (e) {
    return flashBack(req, res, e.message, back);
  }
  if (wantsJson(req)) return res.json({ ok: true, added: true });
  req.session.flash = 'Design added to your board.';
  res.redirect(back);
});

router.post('/boards/:id/remove', formLimiter, async (req, res) => {
  const board = await ownBoard(req, res);
  if (!board) return;
  const back = `/social/boards/${board.id}`;
  await core.removeBoardItem(board.id, String(req.body.design_id || ''));
  if (wantsJson(req)) return res.json({ ok: true, removed: true });
  req.session.flash = 'Design removed from your board.';
  res.redirect(back);
});

// ---- Shop announcements (shop subscription required to post) ----
router.post('/announce', requireSubscription('tattoo_shop'), formLimiter, async (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!body) return flashBack(req, res, 'Write the announcement first.', '/social/feed');
  // Shops may post business location/hours/appointment info; everything
  // else (email, phone, socials, payment info) is still blocked.
  const screen = screenText(body, { allow: ['street_address'] });
  if (!screen.ok) return flashBack(req, res, screenFail(screen.flags.map((f) => f.label).join(', ')), '/social/feed');
  await db.insert('shop_announcements', {
    shop_user_id: req.user.id, body, created_at: db.now(),
  });
  if (wantsJson(req)) return res.status(201).json({ ok: true });
  req.session.flash = 'Announcement posted to your followers.';
  res.redirect('/social/feed');
});

// ---- Feed: announcements from followed shops + healed posts from
// followed artists, newest first, paginated ----
router.get('/feed', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 20;
  const me = req.user.id;
  const items = await db.all(
    // Every column is explicitly aliased: in a compound SELECT, SQLite only
    // resolves ORDER BY against explicitly-aliased output columns.
    `SELECT a.id AS id, 'announcement' AS kind, a.body AS body, a.created_at AS created_at,
            a.shop_user_id AS author_id, u.display_name AS author_name,
            NULL AS photo_path, 0 AS likes_count, 0 AS liked_by_viewer
     FROM shop_announcements a
     JOIN follows f ON f.followed_user_id = a.shop_user_id AND f.follower_user_id = ?
     JOIN users u ON u.id = a.shop_user_id
     UNION ALL
     SELECT h.id AS id, 'healed' AS kind, h.caption AS body, h.created_at AS created_at,
            h.artist_user_id AS author_id, au.display_name AS author_name,
            h.photo_path AS photo_path, h.likes_count AS likes_count,
            CASE WHEN EXISTS (SELECT 1 FROM healed_likes l WHERE l.post_id = h.id AND l.user_id = ?)
                 THEN 1 ELSE 0 END AS liked_by_viewer
     FROM healed_posts h
     JOIN follows f ON f.followed_user_id = h.artist_user_id AND f.follower_user_id = ?
     JOIN users au ON au.id = h.artist_user_id
     WHERE h.artist_user_id IS NOT NULL
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [me, me, me, perPage, (page - 1) * perPage]);
  const payload = { ok: true, page, per_page: perPage, items };
  if (wantsJson(req)) return res.json(payload);
  res.render('social/feed', { title: 'Your feed', ...payload });
});

// ---- Reviews ----
router.post('/reviews', formLimiter, async (req, res) => {
  const back = '/journal';
  const reviewBody = String(req.body.body || '').trim().slice(0, 2000);
  if (reviewBody) {
    const screen = screenText(reviewBody);
    if (!screen.ok) {
      const msg = screenFail(screen.flags.map((f) => f.label).join(', '));
      if (wantsJson(req)) return res.status(422).json({ ok: false, error: msg });
      req.session.flash = msg;
      return res.redirect(back);
    }
  }
  let reviewId;
  try {
    reviewId = await core.createReview(
      req.user.id, String(req.body.booking_id || ''), req.body.rating, reviewBody);
  } catch (e) {
    if (wantsJson(req)) return res.status(422).json({ ok: false, error: e.message, code: e.code });
    req.session.flash = e.message;
    return res.redirect(back);
  }
  const review = await db.get('SELECT * FROM reviews WHERE id = ?', [reviewId]);
  if (review) {
    await notifyUser(review.shop_user_id, {
      kind: 'review',
      title: `New ${review.rating}-star review`,
      body: `${req.user.display_name || 'A customer'} reviewed your shop.`,
      link: `/social/reviews/shop/${review.shop_user_id}`,
    });
    if (review.artist_user_id && review.artist_user_id !== review.shop_user_id) {
      await notifyUser(review.artist_user_id, {
        kind: 'review',
        title: `New ${review.rating}-star review`,
        body: `${req.user.display_name || 'A customer'} reviewed your work.`,
        link: `/social/reviews/artist/${review.artist_user_id}`,
      });
    }
  }
  if (wantsJson(req)) return res.status(201).json({ ok: true, review_id: reviewId });
  req.session.flash = 'Review posted — thank you!';
  res.redirect(back);
});

module.exports = router;
