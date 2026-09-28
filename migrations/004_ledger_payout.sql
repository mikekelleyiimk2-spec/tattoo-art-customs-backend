-- Link commission ledger entries to the payout run that pays them.
-- Entries move payable -> queued (when a payout run is created) -> paid
-- (only when the admin confirms the PayPal payout completed).
ALTER TABLE commission_ledger ADD COLUMN payout_id TEXT;
