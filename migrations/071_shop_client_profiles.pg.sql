-- 071: Client profiles CRM (shop toolset)
-- Per-shop client records (contact info, allergies, notes) plus per-client
-- tattoo history (description, placement, date done, artist, aftercare, booking link)
-- Idempotent: safe to re-run (IF NOT EXISTS throughout)
-- Convention: TEXT ids (db.insert auto-generates), TEXT shop_user_id (matches waitlist/bookings)
CREATE TABLE IF NOT EXISTS shop_clients (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  allergies TEXT,
  notes TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_clients_shop ON shop_clients(shop_user_id);
CREATE TABLE IF NOT EXISTS shop_client_tattoos (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES shop_clients(id) ON DELETE CASCADE,
  booking_id TEXT,
  description TEXT,
  placement TEXT,
  date_done TEXT,
  artist_name TEXT,
  aftercare_notes TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_client_tattoos_client ON shop_client_tattoos(client_id);
