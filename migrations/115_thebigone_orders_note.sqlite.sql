-- 115: The Big One register products on the orders table (owner order
-- 2026-10-27, Lane A). Classifieds/notices submissions and gift
-- subscriptions are orders rows (order_type 'the_big_one_listing' /
-- 'the_big_one_gift', status 'pending_review') whose payload — listing
-- business/text/department or gift plan/recipient — rides in this one
-- JSON note column. Nothing auto-publishes: the desk reviews the row,
-- confirms payment by hand, and only then flips a listing to
-- 'published'.
ALTER TABLE orders ADD COLUMN guest_note TEXT;
