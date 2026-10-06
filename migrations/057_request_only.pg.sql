-- Request-only designs: trademarked/pop-culture character designs that
-- customers must request (fulfilled as custom orders), never instant-buy.
ALTER TABLE designs ADD COLUMN request_only INTEGER NOT NULL DEFAULT 0;
