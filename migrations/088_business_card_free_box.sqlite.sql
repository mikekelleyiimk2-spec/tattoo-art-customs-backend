-- 088: Free first business-card box for annual-plan shops (owner FINAL
-- pricing ruling 2026-10-14: paid orders at cost + 25%, PLUS one free
-- box for annual tattoo_shop subscribers — smallest set only, 50
-- cards, once per shop account, ever). is_free_box marks the one
-- redemption row on business_card_orders so the perk can never be
-- claimed twice — the flag is the ledger, checked by freeBoxStatus()
-- in src/lib/businessCards.js before any free order is created.
ALTER TABLE business_card_orders ADD COLUMN is_free_box INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_bcard_free ON business_card_orders (user_id, is_free_box);
