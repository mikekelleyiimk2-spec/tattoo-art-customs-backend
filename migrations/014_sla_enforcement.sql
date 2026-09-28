-- SLA enforcement for custom design orders: late penalties, reminders, day-7 termination.
ALTER TABLE orders ADD COLUMN late_penalty_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN designer_contract_terminated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN replacement_status TEXT;
-- Flag on the designer account: suspended designers cannot take new custom orders
-- (blocked from the request-artist dropdown and routing) pending admin review.
ALTER TABLE users ADD COLUMN sla_suspended INTEGER NOT NULL DEFAULT 0;
-- Per-day penalty ledger (idempotency: one row per order+day; also mirrored on
-- orders.late_penalty_days). Amounts are in cents.
CREATE TABLE IF NOT EXISTS sla_penalties (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  day_number INTEGER NOT NULL,
  designer_id TEXT NOT NULL,
  original_cents INTEGER NOT NULL,
  deduction_cents INTEGER NOT NULL,
  owner_cents INTEGER NOT NULL,
  credit_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(order_id, day_number)
);
-- Reminder idempotency: one row per order+reminder_key.
CREATE TABLE IF NOT EXISTS sla_reminders (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  reminder_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(order_id, reminder_key)
);
CREATE INDEX IF NOT EXISTS idx_sla_penalties_order ON sla_penalties(order_id);
CREATE INDEX IF NOT EXISTS idx_sla_reminders_order ON sla_reminders(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_due ON orders(delivery_due);
