-- 029: push notifications (Web Push subscriptions + Expo push tokens).
-- VAPID keys live in VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY env vars, or are
-- auto-generated once and persisted in the settings table (see lib/push.js).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint ON push_subscriptions(endpoint);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
ALTER TABLE users ADD COLUMN expo_push_token TEXT;
