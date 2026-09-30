# OO-Ushers Backend

Express and PostgreSQL API for the OO-Ushers platform. It supports usher and organizer onboarding, profile-completion restrictions, event operations, applications, direct booking invitations, attendance, ratings, warning records, referrals, staff roles, notifications, and admin approvals.

## Local setup

1. Install dependencies with `npm install`.
2. Create `.env` with the required settings below.
3. Start the API with `npm start`. It uses port `4000` by default; the Next.js frontend uses port `3001`.
4. Open `/health` to verify the server and database, or `/docs` for the API reference.

```env
APP_ENV=dev
DB_SYNC_ALTER=false
PORT=4000
BASE_URL=https://YOUR-PUBLIC-TEST-BACKEND.example.com
FRONTEND_URL=http://localhost:3001
CORS_ORIGINS=http://localhost:3001
PG_URI=postgresql://USER:PASSWORD@HOST:5432/DATABASE
PG_SSL=false
JWT_SECRET_KEY=replace-with-at-least-32-random-characters
EMAIL_USER=
EMAIL_PASS=
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

# Paymob Accept — this codebase is intentionally locked to Test Mode
PAYMOB_MODE=test
PAYMOB_BASE_URL=https://accept.paymob.com
PAYMOB_SECRET_KEY=sk_test_replace_me
PAYMOB_PUBLIC_KEY=pk_test_replace_me
PAYMOB_API_KEY=replace_me
PAYMOB_HMAC_SECRET=replace_me
PAYMOB_INTEGRATION_IDS=123456,234567
# Optional only for cards saved with the old standalone encryption key.
PAYMOB_TOKEN_ENCRYPTION_KEY=

# Optional until Paymob activates Payouts Sandbox
PAYMOB_PAYOUT_BASE_URL=https://stagingpayouts.paymobsolutions.com
PAYMOB_PAYOUT_CLIENT_ID=
PAYMOB_PAYOUT_CLIENT_SECRET=
PAYMOB_PAYOUT_USERNAME=
PAYMOB_PAYOUT_PASSWORD=
```

## Paymob Test Mode

The organization settles an event only after it is completed. Every present or late usher receives a settlement line based on the event's per-usher budget. The system records 5% as the OO-Ushers transfer/platform fee and 95% as the usher's amount.

- Ushers with a supported wallet or complete bank payout account are queued for an automatic Paymob Payouts Sandbox transfer after the collection webhook succeeds.
- Ushers without a supported payout account are marked `cash_due`. The Paymob checkout collects only their 5% platform fee; the organization pays their remaining 95% in cash and records it from the event settlement screen.
- The collection callback and card-token callback are SHA-512 HMAC verified. Saved card tokens are encrypted with AES-256-GCM using a key derived from the Test Paymob secret already stored in the backend environment; raw card numbers and CVVs never enter this application.
- Live credentials are rejected. Moving to production requires a deliberate code and configuration change after sandbox acceptance.

For card-on-file testing, set `PAYMOB_CARD_INTEGRATION_ID` to a Test Normal 3DS or Auth card integration with card saving enabled. Add Card will fail with a configuration error if this is missing; it no longer falls back to a wallet integration. The organizer must select Save Card in Paymob Checkout. `PAYMOB_API_KEY` enables an order-based card-token inquiry when the callback is missed; the callback remains the primary path. Payouts credentials are issued separately by the Paymob Payouts account manager.

Database startup runs the repository migrations and creates missing tables. Sequelize schema alteration is off by default because it may drop existing PostgreSQL constraints. To opt in against a disposable local development database only, set `DB_SYNC_ALTER=true` with `APP_ENV=dev`; it remains disabled when `NODE_ENV=production` or `VERCEL` is set. Apply deliberate migrations for deployed schema changes.

## Account access rules

- Browser authentication uses secure HTTP-only access and rotating refresh cookies. Password reset requires a short-lived token issued only after OTP verification.

- New usher and organizer accounts can browse immediately, but event actions remain locked until all required profile data is complete.
- Ushers must complete their name, photo, city, phone, work cities, languages, and event categories.
- Organizers must complete their company name, logo, description, location, and phone.
- Organizer staff can use their company workspace, but cannot bypass an incomplete or blocked owner account.
- Public signup only permits usher/talent and organizer/provider accounts. Staff and admin roles must be invited.

To seed an admin, set `SEED_ADMIN_EMAIL` and a unique `SEED_ADMIN_PASSWORD` of at least 8 characters, verify that `PG_URI` points to the intended database, then run `npm run seed:demo` from the repository root. The command creates or resets that admin account and reports success or failure; it does not print the password. It leaves legacy demo records alone unless `SEED_DEMO_CLEANUP=true` is explicitly set. Do not enable cleanup on a database containing real data.
- Event, company, profile, and portfolio images are validated in memory and uploaded to Cloudinary rather than embedded in JSON payloads.
- Referral URLs contain signed, expiring invite tokens; public previews expose only the event and referrer fields needed by registration.

Frontend role and field names are accepted alongside the backend names. Examples include `talent`/`usher`, `provider`/`organizer`, `Sports Event`/`sport_event`, `experienceYears`/`experience`, and `phoneNumber`/`mobileNumber`.

The usher API is available under both `/usher` and `/talent`; the organizer API is available under both `/organizer` and `/provider`. Responses retain the backend fields and add frontend-friendly aliases such as `_id`, `providerId`, `photo`, `categories`, and `frontendRole`.

## Verification

```sh
npm test
npm run lint
npm run generate:openapi
```

The automated tests cover frontend aliases, profile locks, protected signup roles, event category compatibility, pagination behavior, route contracts, and the existing payment security rules.
