-- 090: Seed the Mango sun conure design into the main gallery
-- Owner order 2026-10-16: the realistic conure pattern art goes up in the gallery as Mango
-- Idempotent: ON CONFLICT (id) DO NOTHING, safe to re-run
-- NOTE: no trailing-semicolon comments (migrate.js splits on semicolon lines)
INSERT INTO designs (id, title, description, categories, color_path, linework_path, linework_wm_path, price_cents, artist_id, status, listing_scope, style, created_at, sale_count, show_featured, show_air_at) VALUES ('mango-sun-conure', 'Mango', 'Mango the sun conure - golden and loud with joy, perched in the river forest at dawn. Realism tattoo design, full color with matching clean linework included.', '["Animals & Wildlife > Sun Conure"]', 'designs/color-clean/mango-sun-conure.jpg', 'designs/linework-clean/mango-sun-conure.jpg', '/img/designs/mango-sun-conure-auto.jpg', 7500, NULL, 'approved', 'gallery', 'realism', 1792168471973, 0, 0, NULL) ON CONFLICT (id) DO NOTHING;
