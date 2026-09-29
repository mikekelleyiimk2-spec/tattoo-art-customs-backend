// Phase 4 social layer + customer journal: shared business logic.
// Routes and tests share these so the rules live in exactly one place.
//
// Composite-PK tables (healed_likes, follows, board_items) are written with
// db.query() and explicit columns — NEVER db.insert(), which injects an id
// column those tables do not have.
const db = require('../db');

// --- Healed-post likes (idempotent; healed_posts.likes_count maintained) ---
async function likePost(postId, userId) {
  return db.transaction(async (tx) => {
    const post = await tx.get('SELECT id FROM healed_posts WHERE id = ?', [postId]);
    if (!post) {
      const e = new Error('Post not found.');
      e.code = 'NOT_FOUND';
      throw e;
    }
    const existing = await tx.get(
      'SELECT 1 AS one FROM healed_likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
    if (!existing) {
      await tx.query(
        'INSERT INTO healed_likes (post_id, user_id, created_at) VALUES (?, ?, ?)',
        [postId, userId, Date.now()]);
    }
    const { n } = await tx.get('SELECT COUNT(*) AS n FROM healed_likes WHERE post_id = ?', [postId]);
    await tx.query('UPDATE healed_posts SET likes_count = ? WHERE id = ?', [n, postId]);
    return { liked: true, likes_count: n };
  });
}

async function unlikePost(postId, userId) {
  return db.transaction(async (tx) => {
    await tx.query('DELETE FROM healed_likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
    const { n } = await tx.get('SELECT COUNT(*) AS n FROM healed_likes WHERE post_id = ?', [postId]);
    await tx.query('UPDATE healed_posts SET likes_count = ? WHERE id = ?', [n, postId]);
    return { liked: false, likes_count: n };
  });
}

// --- Follows ---
async function followUser(followerId, followedId) {
  if (String(followerId) === String(followedId)) {
    const e = new Error('You cannot follow yourself.');
    e.code = 'SELF';
    throw e;
  }
  const target = await db.get('SELECT id, role FROM users WHERE id = ?', [followedId]);
  if (!target) {
    const e = new Error('User not found.');
    e.code = 'NOT_FOUND';
    throw e;
  }
  try {
    await db.query(
      'INSERT INTO follows (follower_user_id, followed_user_id, created_at) VALUES (?, ?, ?)',
      [followerId, followedId, Date.now()]);
  } catch (e) {
    // Composite-PK duplicate: UNIQUE constraint failed (sqlite) / duplicate
    // key (pg). Rejected, not silently absorbed.
    if (/unique|duplicate/i.test(e.message || '')) {
      const dup = new Error('You already follow this user.');
      dup.code = 'DUPLICATE';
      throw dup;
    }
    throw e;
  }
  return { following: true };
}

async function unfollowUser(followerId, followedId) {
  await db.query('DELETE FROM follows WHERE follower_user_id = ? AND followed_user_id = ?',
    [followerId, followedId]);
  return { following: false };
}

// --- Design boards ---
async function createBoard(ownerId, name) {
  return db.insert('design_boards', { owner_user_id: ownerId, name, created_at: db.now() });
}

async function addBoardItem(boardId, designId) {
  const design = await db.get('SELECT id FROM designs WHERE id = ?', [designId]);
  if (!design) {
    const e = new Error('Design not found.');
    e.code = 'NOT_FOUND';
    throw e;
  }
  try {
    await db.query('INSERT INTO board_items (board_id, design_id, created_at) VALUES (?, ?, ?)',
      [boardId, designId, Date.now()]);
  } catch (e) {
    if (/unique|duplicate/i.test(e.message || '')) {
      const dup = new Error('That design is already on this board.');
      dup.code = 'DUPLICATE';
      throw dup;
    }
    throw e;
  }
  return { added: true };
}

async function removeBoardItem(boardId, designId) {
  await db.query('DELETE FROM board_items WHERE board_id = ? AND design_id = ?',
    [boardId, designId]);
  return { removed: true };
}

async function boardWithItems(boardId) {
  const board = await db.get('SELECT * FROM design_boards WHERE id = ?', [boardId]);
  if (!board) return null;
  // PUBLIC ARTWORK RULE: boards surface catalog designs through the
  // watermarked linework image only — never clean color art.
  const items = await db.all(
    `SELECT d.id, d.title, d.style, d.linework_wm_path, bi.created_at AS added_at
     FROM board_items bi
     JOIN designs d ON d.id = bi.design_id
     WHERE bi.board_id = ?
     ORDER BY bi.created_at DESC`,
    [boardId]);
  return { ...board, items };
}

// --- Reviews ---
// A review is allowed only when ALL of these hold:
//   1. the booking exists,
//   2. the requester is the booking's customer,
//   3. bookings.status = 'completed',
//   4. a booking_payments row exists for the booking with status = 'paid',
//   5. no review exists yet for the booking (reviews.booking_id is UNIQUE).
async function reviewEligibility(customerId, bookingId) {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
  if (!booking) return { ok: false, reason: 'not_found' };
  if (booking.customer_user_id !== customerId) return { ok: false, reason: 'not_yours' };
  if (booking.status !== 'completed') return { ok: false, reason: 'not_completed' };
  const paid = await db.get(
    `SELECT id FROM booking_payments WHERE booking_id = ? AND status = 'paid' LIMIT 1`,
    [bookingId]);
  if (!paid) return { ok: false, reason: 'unpaid' };
  const existing = await db.get('SELECT id FROM reviews WHERE booking_id = ?', [bookingId]);
  if (existing) return { ok: false, reason: 'already_reviewed' };
  return { ok: true, booking };
}

const REVIEW_REASONS = {
  not_found: 'We could not find that booking.',
  not_yours: 'You can only review your own appointments.',
  not_completed: 'Reviews open once your appointment is completed.',
  unpaid: 'Reviews open once your booking is paid in full.',
  already_reviewed: 'You already reviewed this appointment — thank you!',
};

async function createReview(customerId, bookingId, rating, body) {
  const r = Math.round(Number(rating));
  if (!Number.isFinite(r) || r < 1 || r > 5) {
    const e = new Error('Rating must be a whole number from 1 to 5.');
    e.code = 'BAD_RATING';
    throw e;
  }
  const check = await reviewEligibility(customerId, bookingId);
  if (!check.ok) {
    const e = new Error(REVIEW_REASONS[check.reason]);
    e.code = check.reason;
    throw e;
  }
  const { booking } = check;
  try {
    return await db.insert('reviews', {
      booking_id: bookingId,
      shop_user_id: booking.shop_user_id,
      artist_user_id: booking.staff_id || null,
      customer_user_id: customerId,
      rating: r,
      body: body ? String(body).slice(0, 2000) : null,
      created_at: db.now(),
    });
  } catch (e) {
    // Backstop for a race between the eligibility check and the insert —
    // the UNIQUE(booking_id) constraint fires here.
    if (/unique|duplicate/i.test(e.message || '')) {
      const dup = new Error(REVIEW_REASONS.already_reviewed);
      dup.code = 'already_reviewed';
      throw dup;
    }
    throw e;
  }
}

// --- Trending: artists ranked by healed-post activity in the last 30 days
// (posts created in the window + likes on those posts). Pure SQL.
async function trendingArtists(limit = 20, days = 30) {
  const since = Date.now() - Math.max(1, days) * 86400000;
  return db.all(
    `SELECT u.id AS artist_id,
            u.display_name AS display_name,
            COUNT(hp.id) AS post_count,
            COALESCE(SUM(hp.likes_count), 0) AS like_count,
            COUNT(hp.id) + COALESCE(SUM(hp.likes_count), 0) AS activity
     FROM healed_posts hp
     JOIN users u ON u.id = hp.artist_user_id
     WHERE hp.artist_user_id IS NOT NULL AND hp.created_at >= ?
     GROUP BY u.id, u.display_name
     ORDER BY activity DESC, post_count DESC
     LIMIT ?`,
    [since, Math.max(1, Math.min(100, limit))]);
}

module.exports = {
  likePost, unlikePost,
  followUser, unfollowUser,
  createBoard, addBoardItem, removeBoardItem, boardWithItems,
  reviewEligibility, REVIEW_REASONS, createReview,
  trendingArtists,
};
