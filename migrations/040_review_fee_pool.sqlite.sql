-- 040: prepaid review-fee pool for Tier-1 admin task pay (additive only).
--
-- Design triage pay (approve/reject/hold, $0.25 each) is funded by designer
-- upload fees, never by site overhead: the fee is collected at upload time,
-- before any review happens, so review pay can never accrue as owner debt.
-- review_fee_pool is a simple double-entry ledger: 'fee_in' rows credit the
-- pool (one per over-quota upload), 'review_out' rows debit it (one per
-- paid triage action). Balance = SUM(fee_in) - SUM(review_out).
CREATE TABLE IF NOT EXISTS review_fee_pool (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  user_id TEXT,
  ref_type TEXT,
  ref_id TEXT,
  created_at INTEGER NOT NULL
);
-- Monthly per-designer upload counter for the free-quota rule: the first
-- FREE_UPLOADS_PER_MONTH (15) design uploads per Chicago calendar month are
-- free; every upload beyond that books REVIEW_FEE_CENTS (40c).
CREATE TABLE IF NOT EXISTS artist_upload_usage (
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);
-- Funding source for each admin_task_pay row: 'overhead' (legacy default —
-- still capped at 25% of cumulative site overhead) or 'pool' (prepaid
-- review fees; outside the overhead cap entirely).
ALTER TABLE admin_task_pay ADD COLUMN funded_by TEXT NOT NULL DEFAULT 'overhead';
