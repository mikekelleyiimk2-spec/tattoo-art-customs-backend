-- Custom-order finished file attachments (admin uploads the completed
-- custom design; buyers download via secure tokens).
ALTER TABLE orders ADD COLUMN custom_color_path TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN custom_linework_path TEXT NOT NULL DEFAULT '';
