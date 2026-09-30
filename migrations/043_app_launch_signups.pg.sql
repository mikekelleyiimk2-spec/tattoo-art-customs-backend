-- 043: app launch notify list (additive only).
--
-- The homepage "app coming soon" banner collects emails to notify when the
-- mobile app launches. Doubles as a warm customer-lead list for outreach.
CREATE TABLE IF NOT EXISTS app_launch_signups (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  notified_at BIGINT,
  UNIQUE(email)
);
CREATE INDEX IF NOT EXISTS idx_app_launch_signups_created ON app_launch_signups(created_at);
