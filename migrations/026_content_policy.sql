-- 026: content-rating + blur pipeline, linework-only approval rework,
-- rejection reasons, age verification, and the notifications table.
--
-- Content policy (owner, 2026-09-28):
--   * nudity allowed (watermarked as usual)
--   * sexual acts / highly offensive content => blurred until the viewer is
--     age-verified AND opted in, or has purchased the piece
--   * racist material => status 'on_hold', admin-only approve/reject
--   * linework-only uploads are approvable; the site color version follows
--     via color_pending instead of hiding the piece (replaces the old
--     'awaiting_color' / 'pending_color_approval' statuses)
--   * rejections require a reason, delivered to the artist
ALTER TABLE designs ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE designs ADD COLUMN linework_blur_path TEXT;
ALTER TABLE designs ADD COLUMN color_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE designs ADD COLUMN reject_reason TEXT;
-- Retire the old hiding statuses: linework-only pieces re-enter the normal
-- approval flow; the colorization queue now keys on color_pending.
UPDATE designs SET color_pending = 1 WHERE color_source = 'none' AND status IN ('awaiting_color', 'pending_color_approval');
UPDATE designs SET status = 'pending' WHERE status IN ('awaiting_color', 'pending_color_approval');

ALTER TABLE users ADD COLUMN age_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN dob TEXT;
ALTER TABLE users ADD COLUMN show_explicit INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  read_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
