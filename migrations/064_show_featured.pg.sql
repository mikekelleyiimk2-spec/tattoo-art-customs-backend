-- 064: Show-featured designs — flags designs used on the Little Inkers
-- "Color With Us!" show (designs.show_featured = 1). Active TAC members get
-- a discount on these (see pricing.showFeaturedDiscountPct, default 20%).
-- NOTE: no trailing-semicolon comments (migrate.js splits on semicolon lines).
ALTER TABLE designs ADD COLUMN show_featured BIGINT NOT NULL DEFAULT 0;
