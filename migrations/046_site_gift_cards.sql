-- 046: site-wide gift cards (owner rule 2026-09-30; additive only).
--
-- site_gift_cards: denominations $25/$50/$75/$100/$150 with a $1.95 flat
-- purchase fee (disclosed at checkout); free email delivery, optional
-- physical mail for +$4.95 shipping. Codes are unguessable, single-use, and
-- only ACTIVATED after payment clears (pending -> active -> redeemed) -
-- redemption converts the card to site credit spendable on premades,
-- customs, and memberships. paid_with_credit marks memberships bought with
-- site credit (no PayPal subscription id, never auto-renews).
CREATE TABLE IF NOT EXISTS site_gift_cards (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE,
  purchaser_user_id TEXT NOT NULL,
  recipient_email TEXT,
  recipient_name TEXT,
  amount_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  total_paid_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  ship_pending INTEGER NOT NULL DEFAULT 0,
  shipped_at BIGINT,
  ship_address TEXT,
  paypal_order_id TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT '',
  manual_note TEXT,
  redeemed_by_user_id TEXT,
  redeemed_at BIGINT,
  expires_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_gift_cards_code ON site_gift_cards(code);
CREATE INDEX IF NOT EXISTS idx_site_gift_cards_purchaser ON site_gift_cards(purchaser_user_id);
CREATE INDEX IF NOT EXISTS idx_site_gift_cards_ship ON site_gift_cards(ship_pending, shipped_at);
ALTER TABLE subscriptions ADD COLUMN paid_with_credit BIGINT NOT NULL DEFAULT 0;
