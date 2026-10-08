-- 063: Merch catalog — fixed-design POD products (not tied to an owned design).
-- Adds catalog_asset to print_orders: relative asset path (e.g.
-- catalog/merch/music-genres-tee-300dpi.png) resolved by /prints/file/:id
-- with the same basename traversal guard as doodle_file.
ALTER TABLE print_orders ADD COLUMN catalog_asset TEXT;
