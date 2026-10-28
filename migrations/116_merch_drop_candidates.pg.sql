-- 116: merch drop candidates — designs whose SIGNED-IN gallery hearts
-- (design_likes rows with voter_key LIKE 'user:%', migration 055) cross
-- the owner yardstick become candidates for a merch drop of that design
-- (src/lib/merchDrops.js). Guest hearts ('guest:<uuid>') do NOT move
-- this signal (owner rule: signed-in hearts move the count), and Little
-- Inkers hearts live in lil_likes/lil_like_counts (migration 101) — a
-- separate table this feature never reads or mixes in.
-- A row here is a QUEUE ENTRY ONLY: nothing auto-approves and nothing
-- publishes. The owner mockup-approval gate is absolute (see the
-- handoff checklist in src/lib/merchDrops.js).
CREATE TABLE IF NOT EXISTS merch_drop_candidates (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL,
  signed_in_hearts BIGINT NOT NULL DEFAULT 0,
  total_hearts BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'candidate',
  first_flagged_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  owner_note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_merch_drop_candidates_design ON merch_drop_candidates(design_id);
CREATE INDEX IF NOT EXISTS idx_merch_drop_candidates_status ON merch_drop_candidates(status);
