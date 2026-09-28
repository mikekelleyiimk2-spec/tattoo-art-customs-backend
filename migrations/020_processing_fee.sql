-- Processing-fee pass-through (2026-09-28): the 3.5% + $0.49 web processing
-- fee is added to every web transaction and stored on the order. Commissions
-- are computed on the base price (amount_paid_cents - fee_cents); the fee
-- covers the payment processor's cut so the business never absorbs it.
ALTER TABLE orders ADD COLUMN fee_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE credit_topups ADD COLUMN fee_cents BIGINT NOT NULL DEFAULT 0;
