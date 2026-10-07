-- 061: doodle-to-merchandise — let print_orders reference an uploaded kid doodle.
-- Doodle merch (tee/poster) prints the uploaded file as-is; the artwork is
-- served to Printful via /prints/file/:id?token= like design-based prints.
ALTER TABLE print_orders ADD COLUMN doodle_file TEXT;
