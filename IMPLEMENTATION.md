# OO-Ushers Backend — Implementation and Logic

> Status snapshot: 10 September 2026  
> Repository: `usher-backend`  
> Runtime: Node.js ES modules, Express 5, Sequelize 6, PostgreSQL

This document is a historical implementation snapshot. For current maintained behavior, start at [.agents/skills/system-knowledge/knowledge/INDEX.md](.agents/skills/system-knowledge/knowledge/INDEX.md), then read only the relevant domain and source files. Source code is authoritative when this snapshot differs.

## 1. Responsibilities

The backend is the source of truth for authentication, authorization, profile completion, events, applications, organization staffing, attendance, reviews, referrals, notifications, admin moderation, post-event collections, and usher payouts.

It serves the frontend through JSON APIs and exposes OpenAPI documentation. Local development listens on port `4000`; the frontend normally listens on port `3001`.

## 2. Main structure

- `index.js`: Express entry point, CORS, local listener, and serverless export.
- `src/initapp.js`: environment loading, database connection, health route, documentation, router mounting, and global errors.
- `src/routers`: endpoint definitions and middleware ordering.
- `src/controllers`: business workflows and response handling.
- `src/services`: Paymob, payout, card-token, payout-method, and notification services.
- `src/middleware`: authentication, authorization, validation, upload, and profile-completion enforcement.
- `src/validators`: Joi request validation.
- `db/models`: Sequelize domain models.
- `db/connection.js`: PostgreSQL connection and model initialization.
- `docs`: OpenAPI source/generated specification and Swagger UI.
- `test`: route-alignment and Paymob/business-rule tests.

## 3. Route prefixes

Routes are mounted as follows:

- `/auth`: authentication and current user.
- `/usher` and `/talent`: the same usher router for backward/frontend naming compatibility.
- `/organizer` and `/provider`: the same organization router.
- `/admin`: platform administration.
- `/notifications`: user notifications.
- `/payments`: public Paymob callback and authenticated settlement lookup.
- `/health`: server and database health.
- `/docs` and `/docs/openapi.json`: API documentation.

## 4. Authentication and authorization

- Passwords are hashed with bcrypt.
- Successful login issues a JWT.
- Protected requests use `Authorization: Bearer <token>`.
- Email verification uses OTP state and expiry fields.
- Forgotten-password and reset-password flows are implemented.
- Blocked or unauthorized accounts are rejected by middleware.
- Role checks separate admins, ushers, organization owners, organization members, and supervisors.
- Organization staff records are linked to an owning organization through `providerOwnerId`/organization relationships.

Backend roles map to frontend concepts:

- `usher` → talent/usher workspace.
- `organizer` → organization owner.
- `organizer_member` → organization staff member.
- `organizer_supervisor` → organization supervisor.
- `admin` → platform administration.

## 5. Profile completion enforcement

Protected work actions pass through the complete-profile middleware.

An incomplete usher may authenticate and read permitted screens/data, but cannot apply, refer, accept referrals, or submit protected job actions.

An incomplete organization may authenticate and read permitted workspace data, but cannot create/update/delete/close events, book ushers, change applications or attendance, submit reviews, manage staff, create settlements, or perform other protected mutations.

This server-side rule prevents clients from bypassing the frontend alert or disabled controls.

## 6. Data model

### User

Stores identity, role, credentials, contact details, organization relationship, usher profile data, organization information, portfolio/profile image, verification/blocking state, OTP state, ratings, completed-event count, reliability, excuses/warnings, preferences, availability, WhatsApp consent, payout methods, and organization-owner linkage.

### Event

Stores organization, title/category, event/application dates, start/end times, event and gathering locations, photo, required usher count, gender configuration, per-usher budget, dress code, notes, lifecycle status, hired ushers, supervisors, and WhatsApp-group metadata.

### Application

Joins one usher to one event with status, direct-book flag, referral origin, and application date. A unique event/usher index prevents duplicate applications.

### Attendance

Stores one event/usher attendance record with status and optional check-in/check-out timestamps. A unique event/usher index prevents duplicates.

### Review

Stores event-specific reviewer, reviewed user, rating, and comment. The unique composite index prevents duplicate reviews by the same reviewer for the same person and event.

### Referral

Stores event, referring usher, referred usher, and referral status.

### EventActionRequest

Stores an organization request to perform an admin-controlled event action, its reason/status, and resolution metadata.

### Notification

Stores recipient, localized/user-facing title and message, type, optional link, and read state.

### EventSettlement

Stores one event-level financial settlement: gross amount, amount collected through Paymob, 5% fee, 95% usher amount, cash amount due, collection/payout states, internal reference, Paymob intention/order/transaction identifiers, checkout information, callback state, and test/live marker.

### SettlementLine

Stores each usher's portion of a settlement: attendance, gross amount, Paymob collection portion, 5% fee, 95% payout, payout type/provider/destination/metadata, Paymob payout transaction, failure details, and paid date.

### OrganizerCard

Stores Paymob card-token metadata. The usable token is encrypted with AES-256-GCM using a key derived from the backend's existing Test Paymob secret; IV and authentication tag are stored separately. Masked card details are retained for display. Test/live state and active/default flags prevent inappropriate token use.

### OrganizerCardEnrollment

Tracks each organizer's standalone Paymob Test checkout for adding a card. The checkout uses a 10 EGP sandbox transaction through a Test Online Card Integration ID. A card appears only after Paymob sends a card-token callback with a valid HMAC; the raw card number is never handled by this app.

## 7. Authentication API

Under `/auth`:

- `POST /signup`
- `POST /login`
- `POST /forget-password`
- `POST /verify-otp`
- `POST /reset-password`
- `GET /me`

An additional authorized user listing route remains for compatibility.

## 8. Usher API and business logic

Under `/talent` or `/usher`:

- Read dashboard and profiles.
- Update profile and upload profile picture.
- Add/delete payout methods and select a default.
- Browse eligible open events and view details.
- Apply to an event with duplicate and eligibility protection.
- List personal applications and event history.
- Submit an excuse for an accepted application under current rules.
- Refer another usher to an event.
- View, accept, or decline pending referrals.
- List searchable usher records where authorized.

Payout methods support structured mobile-wallet and bank metadata. The default usable method is resolved when a settlement is created. Ushers without a supported method are classified for cash payment.

## 9. Organization API and business logic

Under `/provider` or `/organizer`:

- Read/update organization profile and upload logo.
- Read dashboard.
- Create, list, read, update, delete, and close events.
- Assign supervisors.
- List event applicants and update application decisions.
- Read and record attendance.
- Read and create event reviews.
- View event referrals.
- Search ushers and directly book an usher.
- Submit event-action requests requiring admin review.
- Create the event WhatsApp-group workflow where configured.
- Preview/create/read event settlement and mark cash lines paid.
- List/remove/verify stored organization card tokens.
- Start a standalone card setup checkout, read its status, and set a saved card as default. The organizer can select an owned saved card for a later event checkout; its decrypted token is sent only to Paymob's Intention API as a customer-initiated transaction.
- Invite, update, block, unblock, and remove organization staff.

Owner-only middleware protects financial, profile, event ownership, and staff-management actions. Organization workspace members receive only their authorized scope.

## 10. Attendance, reviews, reliability, and warnings

Attendance supports operational states such as present, late, absent, and excused as defined by validators/controllers. Attendance and accepted/hired state determine whether an usher belongs in a payable settlement.

Reviews update rating-related data. Excuse and attendance behavior feed warning/reliability information such as `lateExcuseCount`, `consecutiveGoodEvents`, completed events, and reliability score. Admins can reset the relevant excuse counter.

The system does not implement GPS check-ins, criminal checks, or identity-check claims.

## 11. Event lifecycle and guarded actions

The event model and controllers enforce status-dependent operations. Organization owners can perform normal eligible changes; restricted actions can be submitted as event-action requests and resolved by an admin. Applications, attendance, reviews, and payments are bound to the event's state rather than being accepted blindly from the client.

## 12. Settlement calculation

Settlement starts only after the event is complete and uses hired/accepted ushers with payable attendance.

For each eligible usher:

- Gross amount = event budget per usher.
- Platform/transfer deduction = 5%.
- Usher entitlement = 95%.

Digital payout line:

- Paymob collection amount = 100% of the per-usher budget.
- Automatic payout amount = 95%.
- Platform retains the 5% portion.

Cash payout line:

- Paymob collection amount = 5% of the per-usher budget.
- Organization pays the remaining 95% directly to the usher.
- The line is visibly classified as cash and can be marked paid by the organization.

This prevents charging the organization twice while preserving the agreed total budget.

## 13. Paymob Test collection

The payment integration is deliberately locked to `PAYMOB_MODE=test`.

Flow:

1. Organization requests settlement creation.
2. Backend recalculates eligibility and amounts; frontend totals are never trusted.
3. Backend creates a Paymob Intention using configured Test Integration IDs.
4. Backend supplies its public webhook and frontend return URL in the intention.
5. Organization completes Paymob Unified Checkout.
6. Paymob sends the transaction callback to `POST /payments/paymob/webhook`.
7. Backend verifies SHA-512 HMAC, test/live state, amount, currency, order/reference relationship, and transaction status.
8. Successful collection updates the settlement and triggers eligible automatic payouts when Payouts Sandbox is configured.
9. Frontend polls the authenticated settlement endpoint to display the authoritative result.

When Paymob rejects intention creation, the backend records the failure and returns Paymob's HTTP status and a bounded, redacted validation message to the organizer, including in production. This identifies errors such as an invalid Integration ID or missing billing field without exposing credentials.

The public callback is the source of truth. Browser redirect query parameters are not trusted as proof of payment.

Required collection configuration:

```env
PAYMOB_MODE=test
PAYMOB_BASE_URL=https://accept.paymob.com
PAYMOB_SECRET_KEY=
PAYMOB_PUBLIC_KEY=
PAYMOB_API_KEY=
PAYMOB_HMAC_SECRET=
PAYMOB_INTEGRATION_IDS=
PAYMOB_CARD_INTEGRATION_ID=
# Optional for reading cards saved with the old standalone key:
PAYMOB_TOKEN_ENCRYPTION_KEY=
BASE_URL=https://PUBLIC-TEST-BACKEND
FRONTEND_URL=http://localhost:3001
```

`PAYMOB_INTEGRATION_IDS` is a comma-separated list of numeric Test Integration IDs. Secrets must remain in `.env` and must never be committed.
Set `PAYMOB_CARD_INTEGRATION_ID` to the Test Online Card ID when the payment-method list contains other methods. Paymob Checkout must have Save Card enabled, and the merchant's card integration must support tokenization. Card setup and reuse remain in Test Mode until the merchant enables the necessary features.
New Test cards no longer require a separate encryption key. Keep `PAYMOB_SECRET_KEY` in the backend Vercel environment; the key is derived server-side and never sent to the browser. If the Paymob secret changes, existing cards must be added again unless they are migrated before rotation. The optional old encryption key only supports previously saved cards.

## 14. Paymob Payouts Sandbox

Automatic payouts are optional until Paymob activates the Payouts Sandbox account.

Required credentials:

```env
PAYMOB_PAYOUT_BASE_URL=https://stagingpayouts.paymobsolutions.com
PAYMOB_PAYOUT_CLIENT_ID=
PAYMOB_PAYOUT_CLIENT_SECRET=
PAYMOB_PAYOUT_USERNAME=
PAYMOB_PAYOUT_PASSWORD=
PAYMOB_PAYOUT_HMAC_SECRET=
```

The payout service:

- Refuses non-staging configuration in test mode.
- Obtains and caches an OAuth access token.
- Builds wallet or bank payout payloads from the usher's selected method.
- Sends 95% of the gross amount.
- Stores returned transaction/status information.
- Leaves unsupported/missing payout destinations as cash lines.

The payout HMAC variable is reserved for secure payout callbacks. A dedicated complete payout-callback/inquiry reconciliation workflow remains future work.

## 15. Notifications and email

The notification service stores in-app notifications and can send email when email credentials are configured. Users can list notifications, mark one/all as read, and clear them. Transactional templates use OO-Ushers branding.

Email environment variables:

```env
EMAIL_USER=
EMAIL_PASS=
```

## 16. Uploads

Profile photos and organization logos use Multer plus Cloudinary. Required variables:

```env
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

## 17. Admin API

Admins can:

- Read dashboard totals.
- List/invite users.
- List ushers and organizations.
- Block/unblock, verify/unverify, update status, or delete users.
- Reset usher excuse counters.
- List, moderate, or delete events.
- Review and approve/reject event-action requests.

Admin endpoints require both authentication and admin authorization.

## 18. API documentation and health

- `GET /health` reports server availability and database connectivity.
- `GET /docs/openapi.json` returns the generated OpenAPI specification.
- Swagger UI routes expose interactive API documentation.
- Run `npm run generate:openapi` after route/contract changes.

## 19. Environment summary

Core runtime variables:

```env
APP_ENV=dev
PORT=4000
BASE_URL=
FRONTEND_URL=http://localhost:3001
PG_URI=
PG_SSL=false
JWT_SECRET_KEY=
```

Use a long random JWT secret. `BASE_URL` must be public HTTPS for Paymob callbacks during local sandbox testing. PostgreSQL must be available before the application becomes fully usable.

## 20. Verification commands

Run from `usher-backend`:

```bash
npm test
npm run lint
npm start
```

The latest completed verification passed all 14 automated tests. Lint completed without errors; only existing console warnings were reported.

## 21. Current limitations and remaining verification

- A real Paymob Test collection still requires valid merchant Test credentials.
- Local webhook testing requires a public HTTPS tunnel or deployed test backend.
- Cards and wallets must be active under the configured Test Integration IDs.
- Automatic disbursement requires separate Paymob Payouts Sandbox activation and credentials.
- Bank payouts can remain pending and need a complete callback/inquiry reconciliation flow for production-grade final status.
- Final frontend/backend production domains have not been selected.
- CORS is permissive during development and must be restricted before production.
- Production readiness requires real database, email, upload, payment, payout, security, and role-based end-to-end tests.

## 22. Maintenance rule

Update only affected modular knowledge files with the implementation change, following [AGENTS.md](AGENTS.md) and the shared system-knowledge skill. This historical snapshot does not require regeneration. Never document a UI promise that the backend does not enforce.
