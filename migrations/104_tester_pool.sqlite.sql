-- 104: Tester Hub pool machine (owner ruling 2026-10-26).
-- Tester Hub is NOT test-for-test trading: it is ONE standing pool.
-- Sign-up IS the opt-in — a person's Gmail joins the pool once and the
-- Hub routes it into the tester lists of apps in the Hub. Developers
-- add an app and the pool populates its tester list in one go.
--
-- tester_signups (migration 102) is the pool. It gains a status so a
-- member can leave without deleting the record: 'active' members are
-- the pool; 'left' members are out and never routed anywhere.
ALTER TABLE tester_signups ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
CREATE INDEX IF NOT EXISTS idx_tester_signups_status ON tester_signups(status);
-- Apps in the Hub feed. A developer adds an app once; pool_snapshot is
-- the number of pool members the app instantly had at the moment it
-- was added — the "12 in one go" number, computed from the live pool.
-- optin_url is nullable ONLY for fleet rows whose Play track is not
-- live yet (no opt-in link exists to give); developer-added apps must
-- carry one (enforced in src/lib/testerPool.js).
CREATE TABLE IF NOT EXISTS tester_hub_apps (
  id TEXT PRIMARY KEY,
  app_name TEXT NOT NULL,
  package TEXT,
  optin_url TEXT,
  blurb TEXT,
  developer_gmail TEXT,
  pool_snapshot BIGINT NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'hub-app',
  status TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tester_hub_apps_status ON tester_hub_apps(status);
CREATE INDEX IF NOT EXISTS idx_tester_hub_apps_created ON tester_hub_apps(created_at);
