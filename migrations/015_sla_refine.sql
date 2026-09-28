-- SLA refinement (2026-09-28): day-7 terminates the ORDER, never the designer's
-- account. Track missed deadlines per order for the repeat-offender escalator.
-- users.sla_suspended is now a MANUAL admin-only flag (automatic enforcement
-- never sets or reads it).
ALTER TABLE orders ADD COLUMN deadline_missed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN deadline_missed_at INTEGER;
-- Show the effective rate on the per-order penalty ledger (1 or 2 when the
-- repeat-offender escalator is active).
ALTER TABLE sla_penalties ADD COLUMN rate_mult REAL NOT NULL DEFAULT 1;
-- Admin "forgive/reset count": misses at/before this timestamp stop counting
-- toward the trailing-30-day repeat-offender window.
ALTER TABLE users ADD COLUMN sla_forgiven_at INTEGER;
-- TIER 2 — commission suspension (never touches subscription/account):
-- 6+ missed deadlines in the trailing 60 days pauses the designer's
-- commission on new sales for 30 days (renewable). Set/cleared by the
-- enforcer via refreshCommissionSuspensions(); lifted early only by admin.
ALTER TABLE users ADD COLUMN commission_suspended_until INTEGER;
CREATE INDEX IF NOT EXISTS idx_orders_missed_designer
  ON orders(requested_artist_id, deadline_missed, deadline_missed_at);
