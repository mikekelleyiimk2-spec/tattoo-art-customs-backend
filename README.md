# Tattoo Art Customs — Marketplace Backend

Server-rendered marketplace for original tattoo designs: public gallery (watermarked linework only),
customer memberships, design-artist uploads + 60% commissions, tattoo-shop referrals + 20% on verified
sales, premade checkout ($75 / $50 Saturday sale), custom design orders ($150, 50% deposit, 48-hour
delivery), on-site messaging with contact-info screening, manual CashApp/Venmo payments, and admin
moderation + payout queues.

- **Stack:** Node.js + Express + EJS, PostgreSQL (`DATABASE_URL`) with SQLite fallback for local dev,
  PayPal REST (Checkout + Subscriptions).
- **Run locally:** `npm install` → `npm run migrate` → `npm run seed` → `npm start` → http://localhost:3000
- **Test:** `npm test` (spins up a temp DB + server, 40+ checks)
- **Deploy:** Docker image + `render.yaml` Render Blueprint included. See **SETUP.md** for every
  environment variable and exactly where to get the PayPal credentials.

## Layout

- `src/index.js` — app wiring (helmet, sessions, layout, static, routes)
- `src/routes/` — site, auth, memberships, account, artist, shop, orders, messages, admin
- `src/lib/` — screening, pricing (Sat 7PM–Sun 5AM CT sale), paypal, commissions, mail
- `src/middleware/` — DB session store, auth guards, rate limits
- `src/views/` — EJS templates (server-rendered, SEO meta on public pages)
- `src/public/` — CSS
- `migrations/` — SQL migrations (run automatically at startup)
- `test/run.js` — test suite (`npm test`)

## Key business rules (enforced in code)

- Public gallery serves **only watermarked linework** (`/img/designs` → `assets/designs/linework-wm/`).
  Clean color/linework are never mounted publicly; buyers get 24-hour expiring token links.
- Third-party artist sales: **60% designer / 10% site / 20% referring shop** (the stated splits sum to
  90%; the remaining 10% is kept by the site as an explicit residual ledger entry — splits are never
  silently altered). Owner/unregistered art: 80% site / 20% referring shop.
- Artists/shops are paid only when **registered + actively subscribed + payout email set**; referring
  shops earn only after **admin verifies** the sale. Customers never see commission splits.
- Contact/payment info is screened out of bios, messages, and shop fields; verified+subscribed shops may
  list a street address in the business-location field only.
- Off-site sales → membership cancellation, no refund. All sales/subscriptions/memberships are final.
