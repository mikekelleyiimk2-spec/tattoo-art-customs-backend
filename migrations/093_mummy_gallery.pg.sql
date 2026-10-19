-- 093: Seed the Show Mummy design into the main gallery
-- Owner order 2026-10-18: the cute 2D Poppy & Ziggy show mummy goes up in the gallery as a premade design
-- Color master is the show character art (open-mouth variant) and the linework is a pure trace generated from that same art
-- Idempotent: ON CONFLICT (id) DO NOTHING, safe to re-run
-- NOTE: no trailing-semicolon comments (migrate.js splits on semicolon lines)
INSERT INTO designs (id, title, description, categories, color_path, linework_path, linework_wm_path, price_cents, artist_id, status, listing_scope, style, created_at, sale_count, show_featured, show_air_at) VALUES ('mummy', 'Mummy', 'Mummy - the lovable wrapped rascal from the Poppy & Ziggy show, all bandages, safety pin and a stitched-up belly. New-school tattoo design, full color with matching clean linework included.', '["Horror > Mummy"]', 'designs/color-clean/mummy.jpg', 'designs/linework-clean/mummy.jpg', '/img/designs/mummy-auto.jpg', 7500, NULL, 'approved', 'gallery', 'new-school', 1792383206524, 0, 0, NULL) ON CONFLICT (id) DO NOTHING;
