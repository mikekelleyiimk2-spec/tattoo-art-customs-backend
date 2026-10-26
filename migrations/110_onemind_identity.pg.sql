-- 110: OneMind identity foundation (owner law restated 2026-10-26:
-- "Logging into anything we own is your login to OneMind... you're
-- tied to the table the moment you sit down anywhere"). The backend
-- IS OneMind (the hub where the plugs run together) and the OneMind
-- app is one window into it. Every account in `users` IS a OneMind
-- account: this migration gives each one a canonical onemind_id
-- (minted in code by src/lib/onemind.js at boot and at sign-in, so
-- every existing account is migrated with no password change and no
-- lockout) and creates the tie registry: one row per account per
-- surface, first_seated_at written once at the sitting, last_seen_at
-- and signin_count moving on every later sign-in. Kids surfaces
-- (Kids Corner / Little Inkers / Poppy and Ziggy) NEVER appear here:
-- they are absent from the surface registry (src/lib/surfaces.js),
-- so no tie can be written for them by construction.
ALTER TABLE users ADD COLUMN onemind_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_onemind_id ON users (onemind_id);
CREATE TABLE IF NOT EXISTS account_ties (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  first_seated_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  signin_count BIGINT NOT NULL DEFAULT 1,
  UNIQUE (user_id, surface)
);
CREATE INDEX IF NOT EXISTS idx_account_ties_user ON account_ties (user_id);
CREATE INDEX IF NOT EXISTS idx_account_ties_surface ON account_ties (surface);
