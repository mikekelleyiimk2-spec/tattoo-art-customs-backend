-- 100: merch hearts — wishlist favorites gain an item type and products
-- get like tables of their own, mirroring the design system (053/055).
-- user_favorites.design_id stays the item id column: design ids and merch
-- catalog ids never collide (merch ids are catalog slugs like pf-tee-wolf
-- or amazon-saniderm), and item_type records which catalog an id is in.
-- Existing favorite rows are all designs, which is what the DEFAULT says.
ALTER TABLE user_favorites ADD COLUMN item_type TEXT NOT NULL DEFAULT 'design';
CREATE INDEX IF NOT EXISTS idx_user_favorites_type ON user_favorites(user_id, item_type, created_at);
CREATE TABLE IF NOT EXISTS merch_likes (
  merch_id TEXT NOT NULL,
  voter_key TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (merch_id, voter_key)
);
CREATE INDEX IF NOT EXISTS idx_merch_likes_item ON merch_likes(merch_id, created_at);
CREATE TABLE IF NOT EXISTS merch_like_counts (
  merch_id TEXT PRIMARY KEY,
  like_count BIGINT NOT NULL DEFAULT 0
);
