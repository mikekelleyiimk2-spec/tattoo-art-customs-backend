-- 049: track Google Play purchase acknowledgement.
--
-- Google auto-refunds any purchase left unacknowledged after ~3 days while
-- the membership stays active. play.js now acknowledges immediately after
-- granting the membership, and an hourly scheduler sweep retries any
-- verified+granted purchase whose acknowledge call failed. acknowledged_at
-- (unix ms, NULL = not yet acknowledged) is what the sweep scans for.
ALTER TABLE play_purchases ADD COLUMN acknowledged_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_play_purchases_unacked
  ON play_purchases(status, acknowledged_at);
