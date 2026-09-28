# SETUP — Tattoo Art Customs Backend

## 1. Local run (5 minutes)

```bash
cd tattoo-art-customs-backend
npm install
npm run migrate   # creates data/app.db (SQLite) + tables
npm run seed      # creates the 4 plans + head-admin user
npm start         # http://localhost:3000
```

`npm test` runs the full suite against a throwaway database (does not touch `data/app.db`).

Copy `.env.example` to `.env` and fill in values as needed. Without PayPal credentials the site
runs fine for browsing, accounts, uploads, messaging, and manual (CashApp/Venmo) payments — checkout
buttons show a "payments being set up" notice and buyers are routed to manual payment.

## 2. Environment variables

| Variable | Required | What it is |
|---|---|---|
| `PORT` | no | Server port (default 3000; hosts like Render set this automatically) |
| `BASE_URL` | yes (prod) | Public URL, e.g. `https://tattoo-art-customs.onrender.com` (used for PayPal return links + referral links) |
| `SESSION_SECRET` | yes (prod) | Long random string for session cookies |
| `DATABASE_URL` | yes (prod) | PostgreSQL connection string. If unset, the app uses SQLite at `SQLITE_PATH` |
| `SQLITE_PATH` | no | SQLite file (default `data/app.db`) |
| `ASSET_DIR` | no | Where uploaded images live (default `assets/`) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | yes | Seed admin login (`npm run seed`) |
| `PAYPAL_CLIENT_ID` | yes | PayPal REST app client ID (see §3) |
| `PAYPAL_CLIENT_SECRET` | yes | PayPal REST app secret |
| `PAYPAL_MODE` | no | `sandbox` (default) or `live` |
| `PAYPAL_WEBHOOK_ID` | yes | Webhook ID from the PayPal dashboard (see §3) |
| `PAYPAL_PLAN_CUSTOMER` | yes | Subscription plan ID for $5/month customer membership |
| `PAYPAL_PLAN_ARTIST` | yes | Subscription plan ID for $5/month design-artist plan |
| `PAYPAL_PLAN_SHOP` | yes | Subscription plan ID for $99.99/year tattoo-shop plan |
| `PAYPAL_PLAN_CUSTOMER_ANNUAL` | no | Subscription plan ID for $50/year customer membership (optional; leave blank and the annual plan shows as "coming soon") |
| `FOUNDING_SHOP_WINDOW_END` | no | ISO date (e.g. `2027-03-01`) ending the founding-shop window; shops joining before it pay $79.99 for their first year instead of $99.99. Defaults to 2027-03-01. |
| `SMTP_HOST/PORT/USER/PASS/FROM` | no | Email sending; without these, emails are logged to the console |
| `WISE_API_TOKEN` / `WISE_PROFILE_ID` | no | Wise API token + profile ID for automatic bank-account payouts; without these, bank cashouts queue for manual admin send |
| `WEEKLY_PAYOUTS_ENABLED` | no | Set to `false` to disable the automatic Monday payout run |

## 3. PayPal setup (Business account)

You already have a PayPal Business account. Do this once:

1. Go to **https://developer.paypal.com/dashboard/applications** and log in with the Business account.
2. **Apps & Credentials** → **Create App** (name it "Tattoo Art Customs"). Copy the **Client ID** and
   **Secret** → these are `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`. Keep `PAYPAL_MODE=sandbox`
   while testing; switch to `live` for real money (the dashboard has a Sandbox/Live toggle — create the
   app under **Live** when ready).
3. **Subscription plans** (do this in the same mode you will run): go to
   **https://www.paypal.com/billing/plans** (or Developer Dashboard → Subscriptions → Plans) and create
   four plans:
   - Customer — $5.00 USD, monthly → `PAYPAL_PLAN_CUSTOMER`
   - Customer Annual — $50.00 USD, yearly → `PAYPAL_PLAN_CUSTOMER_ANNUAL` (optional — see below)
   - Design Artist — $5.00 USD, monthly → `PAYPAL_PLAN_ARTIST`
   - Tattoo Shop — $99.99 USD, yearly → `PAYPAL_PLAN_SHOP`

   Copy each plan's ID (looks like `P-xxxxxxxxxxxxxxxx`) into the matching variable.

   **Subscription incentives** (no extra plans needed — they are applied as
   PayPal billing-cycle overrides on the plans above):
   - **$1 first month:** new monthly customer memberships bill $1 for the first
     month, then $5/month. Applied exactly once per account.
   - **Annual customer:** $50/year (two months free vs monthly). If you haven't
     created the annual plan yet, leave `PAYPAL_PLAN_CUSTOMER_ANNUAL` blank —
     the annual plan shows as "coming soon" without disabling other checkout.
   - **Founding tattoo shops:** while `FOUNDING_SHOP_WINDOW_END` is in the
     future, new shop subscriptions bill $79.99 for the first year and renew
     at $99.99/year automatically. After the window, shops pay $99.99 immediately.
   - **Refer a friend:** every account gets a personal `TAC-XXXXXX` referral
     code (`/membership` shows the shareable link; `?ref=CODE` works on signup).
     When a referred friend becomes a paying subscriber, the referrer gets one
     free month of membership (exactly once per referred subscription; the
     referrer's PayPal billing is suspended for the month and resumes automatically).
4. **Webhooks:** Developer Dashboard → **Apps & Credentials** → your app → **Webhooks** (or
   **https://developer.paypal.com/dashboard/webhooks**) → **Add Webhook**:
   - Webhook URL: `https://YOUR-DOMAIN/membership/webhook`
   - Events: `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.CANCELLED`,
     `BILLING.SUBSCRIPTION.EXPIRED`, `BILLING.SUBSCRIPTION.PAYMENT.FAILED`
   - Copy the **Webhook ID** (looks like `8UV...`) → `PAYPAL_WEBHOOK_ID`.
   
   Webhook events are signature-verified against this ID; unverified events are rejected with 401.

## 4. Deploy on Render (recommended)

1. Push this folder to a GitHub repo.
2. In Render: **New → Blueprint**, select the repo. `render.yaml` creates the web service (Docker) plus
   a PostgreSQL database and wires `DATABASE_URL`.
3. After deploy, set the `sync: false` variables in the Render dashboard: `ADMIN_EMAIL`,
   `ADMIN_PASSWORD`, `PAYPAL_*`, `BASE_URL` (your `https://*.onrender.com` URL), SMTP if used.
4. The container runs `node src/db/seed.js` then `node src/index.js` on every start: migrations apply
   automatically and the admin user is created on first boot.

**Important:** Render's filesystem is ephemeral — uploaded images in `ASSET_DIR` disappear on redeploy.
For production, point `ASSET_DIR` at a persistent disk (Render Disk) or object storage and copy the
watermarked gallery images there.

## 5. Going live checklist

- [ ] `PAYPAL_MODE=live`, live client ID/secret, live plan IDs, live webhook ID
- [ ] `BASE_URL` = the real public URL
- [ ] Strong `SESSION_SECRET`, `ADMIN_EMAIL`/`ADMIN_PASSWORD` set
- [ ] Test a $1-style sandbox purchase end-to-end first (buy → manual confirm → download → commission ledger)
- [ ] Prepare the watermarked linework files: admin uploads them per design at **Admin → Designs**
      (a design cannot be approved until its watermarked linework exists)

## Membership perks, roles, and the colorization workflow

- **Member early sale:** active members (any subscription, plus admins) get the
  Saturday sale price from **6:00 PM CT** instead of the public 7:00 PM CT.
  Applied on the website and the app — checkout always re-verifies membership
  server-side.
- **Member-exclusive designs:** any design can be flagged "members only" at
  **Admin → Designs**. Exclusive designs are hidden from the gallery, design
  pages, public artist portfolios, the app API, and checkout for non-members.
- **Head admin:** the `ADMIN_EMAIL` bootstrap account is the **head admin**.
  Only a head admin can manage admins (Admin → Admins); the site always keeps
  at least one head admin, and a normal admin cannot demote one.
- **Site colorization approval:** linework-only uploads wait as `awaiting_color`;
  the admin attaches the finished color version in the colorization queue
  (status → `pending_color_approval`), and a **site administrator** approves it
  (→ `pending` → normal admin approval). The designer is notified when color is
  attached and when the piece goes live — there is no designer approval gate.
  The site-created color is a purchase deliverable only: never public, never
  watermarked for display, never added to the designer's portfolio.
- **Referral free months:** the daily scheduler resumes PayPal subscriptions
  whose referral free month has ended (6:00 AM CT).

## Selling ad space

The site has built-in direct ad sales — no extra setup needed:

- **Advertisers** book at `/advertise`: 3 placements (Leaderboard $150/mo on every page,
  Gallery spotlight $100/mo, Design page banner $75/mo). Orders arrive as *pending*.
- **You** activate them in the admin panel under **Ad space** after payment arrives
  (PayPal/card like any other sale). The ad then runs for the booked months, and you
  get impression/click counts per ad.
- If a slot has no booked ad, it falls back to Google AdSense when `ADSENSE_PUBLISHER_ID`
  is set in `.env` — otherwise the slot stays empty. Apply for AdSense after the site
  is live, then paste the publisher ID into Render's environment variables.
- Rates live in `src/lib/ads.js` (`SLOTS`) — edit and redeploy to change them.
