-- 042: subscription_revenue ledger (additive only).
--
-- The opening raffle closes early at $2,700 in owner subscription profits,
-- but subscriptions were tracked without per-payment revenue rows. This
-- table is the clean ledger: one row per subscription payment, recorded
-- exactly once (UNIQUE on provider+provider_ref makes webhook retries and
-- double-fired activation paths idempotent).
--
-- Split rule (owner policy): the site takes its standard 10% overhead cut
-- and the owner keeps 90% — the same 10% overhead applied to all other
-- revenue. Owner-favorable rounding on odd cents (site share floors).
-- Play Store purchases are recorded at gross plan price; Google's store cut
-- is not deducted here (see src/lib/subscriptionRevenue.js).
CREATE TABLE IF NOT EXISTS subscription_revenue (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  owner_share_cents BIGINT NOT NULL,
  site_share_cents BIGINT NOT NULL,
  provider TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(provider, provider_ref)
);
CREATE INDEX IF NOT EXISTS idx_subscription_revenue_user ON subscription_revenue(user_id);
