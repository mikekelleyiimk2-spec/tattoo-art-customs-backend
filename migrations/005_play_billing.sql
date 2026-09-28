-- Google Play Billing purchases made in the Android app.
-- The app POSTs each purchase token here; rows start as 'pending' and are
-- marked 'verified' once the Play Developer API service account is configured
-- and the token is confirmed with Google. The admin then links verified rows
-- to website accounts (subscriptions) or fulfills design orders from them.
CREATE TABLE IF NOT EXISTS play_purchases (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  purchase_token TEXT UNIQUE NOT NULL,
  purchase_type TEXT NOT NULL DEFAULT 'inapp',
  status TEXT NOT NULL DEFAULT 'pending',
  email TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);
