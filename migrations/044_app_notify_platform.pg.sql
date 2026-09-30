-- 044: track which platform an app-launch signup is waiting for (additive only).
-- The homepage banner shows an iPhone-only notify form once the Android app
-- is live but the iOS app is still pending.
ALTER TABLE app_launch_signups ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'any';
