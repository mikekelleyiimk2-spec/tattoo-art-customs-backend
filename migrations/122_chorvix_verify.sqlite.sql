-- 122: Chorvix verification layer (owner directive 2026-11-01:
-- "Never seen that login build it can keep up and verify game data
-- keeps hacks like me from sweeping up my penny's"). The seat
-- foundation (110/111) proved WHO a seat is; this layer proves it
-- CONTINUOUSLY, on any platform, and proves what the seat OWNS
-- against server truth:
--
-- seat_sessions — short-lived, refreshable, revocable seat sessions.
--   One row per device/platform sitting: the same seat on a phone,
--   a TV, and an iOS sideload are three rows over ONE user_id.
--   Only SHA-256 hashes of the session/refresh tokens are stored —
--   raw tokens exist only in the client's hands. client_root is the
--   root checker's living record: the client DECLARES its
--   configuration ('root' | 'not-root' | 'unknown') and the server
--   RECORDS it. It is never an input to any allow/deny decision —
--   root is welcome (owner law); the boot is for behavior, and
--   behavior is what verify_events records.
-- seat_entitlements — the durable binding of an unlock to a seat.
--   Written when server truth grants something outside the orders
--   table: a redeemed unlock code (source 'code'), a verified Play
--   purchase link, a house grant. Website orders are NOT copied
--   here — lib/seatVerify.js reads them live from `orders`, so the
--   orders table stays the single truth for purchases.
-- verify_events — the integrity watch: every session open / verify
--   failure / refresh / revoke / claim mismatch / code redemption
--   outcome, with the seat when one was proven. This is the living
--   record Aria and the owner audit (GET /api/onemind/watch).
CREATE TABLE IF NOT EXISTS seat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT NOT NULL UNIQUE,
  surface TEXT,
  platform TEXT,
  client_root TEXT NOT NULL DEFAULT 'unknown',
  client_build TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  refresh_expires_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  revoked_at BIGINT,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_seat_sessions_user ON seat_sessions (user_id, revoked_at);
CREATE TABLE IF NOT EXISTS seat_entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  product TEXT NOT NULL,
  source TEXT NOT NULL,
  ref TEXT,
  granted_at BIGINT NOT NULL,
  revoked_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seat_entitlements_grant ON seat_entitlements (user_id, product, source, ref);
CREATE INDEX IF NOT EXISTS idx_seat_entitlements_user ON seat_entitlements (user_id, revoked_at);
CREATE TABLE IF NOT EXISTS verify_events (
  id TEXT PRIMARY KEY,
  ts BIGINT NOT NULL,
  user_id TEXT,
  onemind_id TEXT,
  surface TEXT,
  platform TEXT,
  kind TEXT NOT NULL,
  detail TEXT,
  ip_hash TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verify_events_ts ON verify_events (ts);
CREATE INDEX IF NOT EXISTS idx_verify_events_user ON verify_events (user_id, ts);
CREATE INDEX IF NOT EXISTS idx_verify_events_kind ON verify_events (kind, ts);
