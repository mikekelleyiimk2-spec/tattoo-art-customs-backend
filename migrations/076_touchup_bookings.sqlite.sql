-- 076: Touch-up booking support (shop toolset)
-- Adds booking_type ('standard' | 'touchup') and parent_booking_id to bookings,
-- plus a per-shop touch-up deposit setting (default 0 = free touch-ups).
-- Runs once (tracked in migrations table); plain ADD COLUMN matches repo convention.
ALTER TABLE bookings ADD COLUMN booking_type TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE bookings ADD COLUMN parent_booking_id TEXT NULL;
ALTER TABLE shop_booking_settings ADD COLUMN touchup_deposit_cents INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_bookings_touchup_parent ON bookings(parent_booking_id);
