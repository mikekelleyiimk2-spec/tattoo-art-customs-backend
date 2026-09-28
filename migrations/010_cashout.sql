-- Cashout options: payout destinations (bank, PayPal, digital wallets) +
-- early-cashout requests with a 3% early-cashout penalty.
CREATE TABLE IF NOT EXISTS payout_destinations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  recipient_type TEXT NOT NULL DEFAULT 'artist',
  dest_type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payout_destinations_user ON payout_destinations(user_id);

CREATE TABLE IF NOT EXISTS cashout_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  recipient_type TEXT NOT NULL,
  destination_id TEXT,
  dest_snapshot TEXT NOT NULL DEFAULT '{}',
  amount_cents INTEGER NOT NULL,
  penalty_cents INTEGER NOT NULL DEFAULT 0,
  net_cents INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'early',
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cashout_requests_user ON cashout_requests(user_id, status);

-- cashout_mode: 'weekly' (free automatic Monday payout) or 'manual'
-- (recipient cashes out on demand, 3% early-cashout penalty each time).
ALTER TABLE artist_profiles ADD COLUMN cashout_mode TEXT NOT NULL DEFAULT 'weekly';
ALTER TABLE shop_profiles ADD COLUMN cashout_mode TEXT NOT NULL DEFAULT 'weekly';

-- Link ledger rows to the cashout request that pays them (early or weekly-manual).
ALTER TABLE commission_ledger ADD COLUMN cashout_id TEXT;
