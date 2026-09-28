-- 024: tattoo shops can opt in to a free designer membership while their
-- shop subscription is active (designer_opt_in on shop_profiles).
ALTER TABLE shop_profiles ADD COLUMN designer_opt_in INTEGER NOT NULL DEFAULT 0;
