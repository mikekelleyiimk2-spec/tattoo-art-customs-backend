-- 065: Show air datetime — designs.show_air_at (BIGINT ms timestamp, NULL =
-- no gate) gates the show-featured member discount: the discount applies
-- only once the episode has aired publicly (server time now >= show_air_at).
-- The badge and /show-designs listing are NOT gated, only the discount.
-- NOTE: no trailing-semicolon comments (migrate.js splits on semicolon lines).
ALTER TABLE designs ADD COLUMN show_air_at BIGINT;
