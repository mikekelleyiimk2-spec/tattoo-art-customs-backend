-- 034: per-task administrator pay, funded from the website's 10% overhead.
-- Admin task pay is a separate obligation capped at 25% of cumulative site
-- overhead — it never debits the immutable site overhead ledger rows
-- (recipient_type='site'). Pay beyond the cap is held and released later as
-- overhead grows. Active-only: there is no flat/base component; an admin
-- earns solely by completing paid tasks.
CREATE TABLE IF NOT EXISTS admin_task_pay (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',
  ledger_id TEXT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(task_type, ref_type, ref_id)
);
