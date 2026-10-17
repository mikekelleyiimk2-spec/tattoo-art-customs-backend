-- 091: Set AK Ink Therapy as the business name on Adolfo's shop profile
-- Owner fix 2026-10-17: his public storefront and booking pages showed his
-- account name (Adolfo) because shop_profiles.business_name was never set
-- Guarded: only fills the field when it is currently empty, never overwrites
UPDATE shop_profiles SET business_name = 'AK Ink Therapy' WHERE user_id = '3dcf35ac4d2762d2f2725398' AND COALESCE(business_name, '') = '';
