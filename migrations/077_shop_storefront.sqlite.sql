-- 077: Shop storefront (shop toolset)
-- Public branded page per shop (/store/:shopId) listing the shop's own
-- approved designs for sale, with the shop's referral code on links.
-- Runs once (tracked in migrations table).
CREATE TABLE IF NOT EXISTS shop_storefront_settings (
  shop_user_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  headline TEXT NULL,
  welcome_text TEXT NULL
);
