-- 045: rush custom option (owner rule 2026-09-30; additive only).
-- rush_fee_cents holds the $30 rush fee (0 = standard 48h order); for rush
-- orders delivery_due is set to created_at + 24h instead of + 48h. The fee is
-- split 60/40 ($18 fulfilling designer incentive / $12 site overhead) via
-- dedicated commission_ledger rows at routing time.
ALTER TABLE orders ADD COLUMN rush_fee_cents BIGINT NOT NULL DEFAULT 0;
