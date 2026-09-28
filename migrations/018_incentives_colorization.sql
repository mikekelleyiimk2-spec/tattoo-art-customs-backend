-- Subscription incentives, admin-only colorization approval, and
-- member-exclusive designs (2026-09-28).
--
-- Incentives:
--   users.referral_code              = this user's own refer-a-friend code
--                                      ("TAC-XXXXXX"; generated lazily).
--   users.referred_by                = referrer's user id (set at signup
--                                      when the friend joins via a code).
--   users.first_month_discount_used  = 1 once the $1-first-month discount
--                                      has been applied (exactly once).
--   users.membership_extended_until  = unix-ms; referral free months extend
--                                      the membership past the PayPal period.
--   subscriptions.first_month_discount_applied = 1 when the subscription
--                                      was created with the $1 trial month.
--   subscriptions.founding_discount_applied    = 1 when a tattoo shop joined
--                                      during the founding window ($79.99
--                                      first year instead of $99.99).
--   referral_redemptions: one row per referred paying subscriber — the
--      UNIQUE index on subscription_id guarantees each referred
--      subscription grants exactly one free month to the referrer.
--   designs.members_only             = 1 hides the piece from non-members
--                                      (gallery, portfolio, API, checkout).
--
-- Colorization: the designer-approval gate is removed. The flow is now:
--   awaiting_color -> (admin attaches color) -> pending_color_approval ->
--   (site administrator approves) -> pending -> approved (live).
-- Any in-flight 'pending_designer_approval' rows become
-- 'pending_color_approval'.
ALTER TABLE users ADD COLUMN referral_code TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN referred_by TEXT;
ALTER TABLE users ADD COLUMN first_month_discount_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN membership_extended_until INTEGER;
ALTER TABLE subscriptions ADD COLUMN first_month_discount_applied INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN founding_discount_applied INTEGER NOT NULL DEFAULT 0;
ALTER TABLE designs ADD COLUMN members_only INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS referral_redemptions (
  id TEXT PRIMARY KEY,
  referrer_id TEXT NOT NULL,
  referred_user_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  free_month_start INTEGER NOT NULL,
  free_month_end INTEGER NOT NULL,
  paypal_subscription_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_redemption_sub
  ON referral_redemptions(subscription_id);
CREATE INDEX IF NOT EXISTS idx_referral_redemption_referrer
  ON referral_redemptions(referrer_id);
CREATE INDEX IF NOT EXISTS idx_designs_members_only
  ON designs(status, listing_scope, members_only);

UPDATE designs SET status = 'pending_color_approval'
  WHERE status = 'pending_designer_approval';
