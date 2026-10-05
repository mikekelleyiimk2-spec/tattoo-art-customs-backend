-- 053: user favorites (wishlist) — server-side persistence for logged-in users.
-- Guests are client-only (localStorage); no server rows for guests.
CREATE TABLE IF NOT EXISTS user_favorites (
  user_id TEXT NOT NULL,
  design_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, design_id)
);
CREATE INDEX IF NOT EXISTS idx_user_favorites_user ON user_favorites(user_id, created_at);
