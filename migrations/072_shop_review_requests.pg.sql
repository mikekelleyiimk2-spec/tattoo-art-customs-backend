-- 072: Review request sent-log (shop toolset)
-- The unified sent-log for review asks across all three sources: the
-- aftercare 'great'-check-in ask (aftercare.js maybeAskReview), the manual
-- shop trigger (POST /shop/reviews/send/:bookingId), and the auto-send
-- scheduler sweep (reviewRequests.runReviewSweep).
-- shop_review_settings is NOT created here — it already exists from 051
-- (shop_user_id TEXT PRIMARY KEY, google_review_url TEXT, enabled INTEGER).
-- Anti-spam: exactly one logged ask per booking, enforced by
-- UNIQUE(booking_id); double-asks are blocked across all sources.
-- Idempotent: safe to re-run (IF NOT EXISTS throughout)
-- Convention: TEXT ids, TEXT shop_user_id/booking_id (matches waitlist/bookings)
CREATE TABLE IF NOT EXISTS shop_review_requests (
  id TEXT PRIMARY KEY,
  shop_user_id TEXT NOT NULL,
  booking_id TEXT NOT NULL UNIQUE,
  client_email TEXT,
  sent_at BIGINT NOT NULL,
  clicked INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_review_requests_shop ON shop_review_requests(shop_user_id);
