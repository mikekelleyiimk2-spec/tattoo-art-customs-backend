-- Site credit (wallet): anyone can top up with PayPal, keep commission
-- payouts as credit, spend credit at checkout, or withdraw it to a payout
-- destination (3% early-cashout penalty auto-withheld on withdrawal).
CREATE TABLE IF NOT EXISTS account_credits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_credits_user ON account_credits(user_id);

-- Pending PayPal top-ups (created -> captured -> credited).
CREATE TABLE IF NOT EXISTS credit_topups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paypal_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

-- cashout source: 'commission' (ledger) or 'credit' (wallet withdrawal).
ALTER TABLE cashout_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'commission';
