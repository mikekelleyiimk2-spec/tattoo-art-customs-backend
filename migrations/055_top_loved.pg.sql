-- 055: top-loved leaderboard (design likes from gallery hearts).
-- voter_key is 'user:<user_id>' for logged-in users, 'guest:<uuid>' for guests.
-- design_like_counts is a maintained rollup for fast ranking.
CREATE TABLE IF NOT EXISTS design_likes (
  design_id TEXT NOT NULL,
  voter_key TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (design_id, voter_key)
);
CREATE INDEX IF NOT EXISTS idx_design_likes_design ON design_likes(design_id, created_at);
CREATE TABLE IF NOT EXISTS design_like_counts (
  design_id TEXT PRIMARY KEY,
  like_count BIGINT NOT NULL DEFAULT 0
);
-- Backfill: every existing wishlist favorite counts as one love.
-- (INSERT...SELECT...ON CONFLICT does not parse on SQLite, so the backfill
-- uses WHERE NOT EXISTS / DELETE+INSERT, which are idempotent on both.)
INSERT INTO design_likes (design_id, voter_key, created_at)
SELECT design_id, 'user:' || user_id, created_at FROM user_favorites uf
WHERE NOT EXISTS (
  SELECT 1 FROM design_likes dl
  WHERE dl.design_id = uf.design_id AND dl.voter_key = 'user:' || uf.user_id
);
DELETE FROM design_like_counts;
INSERT INTO design_like_counts (design_id, like_count)
SELECT design_id, COUNT(*) FROM design_likes GROUP BY design_id;
