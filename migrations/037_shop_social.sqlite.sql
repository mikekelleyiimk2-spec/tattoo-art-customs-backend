-- 037: shop social (healed-result loop: journal, healed posts, follows,
-- design boards, announcements, reviews).
CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  customer_user_id TEXT NOT NULL,
  booking_id TEXT NULL,
  design_id TEXT NULL,
  photo_path TEXT NULL,
  caption TEXT NULL,
  happened_at BIGINT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_customer ON journal_entries(customer_user_id);

CREATE TABLE IF NOT EXISTS healed_posts (
  id TEXT PRIMARY KEY,
  customer_user_id TEXT NOT NULL,
  artist_user_id TEXT NULL,
  shop_user_id TEXT NULL,
  design_id TEXT NULL,
  booking_id TEXT NULL,
  photo_path TEXT NULL,
  caption TEXT NULL,
  likes_count INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_healed_posts_customer ON healed_posts(customer_user_id);
CREATE INDEX IF NOT EXISTS idx_healed_posts_shop ON healed_posts(shop_user_id);

-- Composite PK; later phases insert via db.query (not db.insert, which
-- always generates an id) so rows have exactly (post_id, user_id).
CREATE TABLE IF NOT EXISTS healed_likes (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(post_id, user_id)
);

CREATE TABLE IF NOT EXISTS healed_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_healed_comments_post ON healed_comments(post_id);

-- Composite PK; later phases insert via db.query for the same reason.
CREATE TABLE IF NOT EXISTS follows (
  follower_user_id TEXT NOT NULL,
  followed_user_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(follower_user_id, followed_user_id)
);

CREATE TABLE IF NOT EXISTS design_boards (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_design_boards_owner ON design_boards(owner_user_id);

-- Composite PK; later phases insert via db.query for the same reason.
CREATE TABLE IF NOT EXISTS board_items (
  board_id TEXT NOT NULL,
  design_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(board_id, design_id)
);

CREATE TABLE IF NOT EXISTS shop_announcements (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_announcements_shop ON shop_announcements(shop_user_id);

-- One review per booking (UNIQUE booking_id); later phases only allow
-- creation from completed + paid bookings.
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE,
  shop_user_id TEXT NOT NULL,
  artist_user_id TEXT NULL,
  customer_user_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  body TEXT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_shop ON reviews(shop_user_id);
