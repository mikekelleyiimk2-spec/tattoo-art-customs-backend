-- 089: Guest design checkout (owner money-path fix 2026-10-15). A logged-out
-- visitor can buy a premade design end-to-end: the order row carries the
-- buyer's checkout email in guest_email and buyer_id stays '' (the NOT NULL
-- column's guest sentinel). Delivery is the existing paid-download token,
-- emailed to guest_email by lib/fulfillment. Member orders are untouched.
ALTER TABLE orders ADD COLUMN guest_email TEXT;
