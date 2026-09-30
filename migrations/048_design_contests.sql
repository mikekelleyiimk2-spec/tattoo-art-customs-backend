-- 048: design contests / bounty board (owner rule 2026-09-30; additive only).
--
-- A customer posts a brief + prize (minimum $30, paid UP FRONT and held in
-- escrow — never owner debt). Designers submit entries; the customer picks
-- a winner within 7 days (statuses: pending_payment -> open -> awarded,
-- open past its deadline with entries becomes judging so the customer or an
-- admin can still pick; open past its deadline with NO entries is refunded
-- to the customer as site credit). The winner gets the prize minus a 12%
-- platform cut; non-winning entries remain the designer's full property.
CREATE TABLE IF NOT EXISTS contests (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  size_placement TEXT NOT NULL DEFAULT '',
  prize_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  total_paid_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending_payment',
  winner_entry_id TEXT,
  winner_user_id TEXT,
  awarded_at BIGINT,
  ends_at BIGINT,
  order_id TEXT NOT NULL DEFAULT '',
  paypal_order_id TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS contest_entries (
  id TEXT PRIMARY KEY,
  contest_id TEXT NOT NULL,
  designer_id TEXT NOT NULL,
  image_path TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contests_status ON contests(status, ends_at);
CREATE INDEX IF NOT EXISTS idx_contests_customer ON contests(customer_id);
CREATE INDEX IF NOT EXISTS idx_contest_entries_contest ON contest_entries(contest_id);
CREATE INDEX IF NOT EXISTS idx_contest_entries_designer ON contest_entries(designer_id);
