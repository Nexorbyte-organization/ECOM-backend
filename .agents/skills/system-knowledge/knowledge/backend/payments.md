# Settlements, Paymob, cards, and payouts

## Current behavior
Owner settlement preview/create requires an owned completed event. Eligible lines are hired ushers with present/late attendance; no eligible attendance is an error.

Budget is per usher. Gross cents = round(budget × 100); fee cents = round(gross × 5%); entitlement = gross minus fee. Digital lines collect gross and pay entitlement; cash lines collect fee only and the organizer pays entitlement in cash.

Default payout method wins, otherwise first method. Wallet needs issuer/destination; bank needs destination/bank code. Unsupported/missing/incomplete details become cash.

One settlement exists per event. Paid collection cannot restart; unexpired pending checkout is reused. Backend recalculates totals. Cash-paid marking requires collected settlement and a cash line. Public serialization hides raw payout destinations/metadata.

Collection is test-only. Callback validates transaction/card-token HMAC, test/integration identity, settlement linkage, amount/currency. Redirect query parameters are not payment proof. Successful collection triggers payouts when Sandbox is configured; payout reconciliation remains incomplete.

Saved card tokens use AES-256-GCM with a key derived from the configured Paymob Test secret; optional PAYMOB_TOKEN_ENCRYPTION_KEY supports legacy decryption. Checkout accepts an owned active test card. Backend exposes card list/delete/verify, enrollment creation/status, and default selection. Enrollment creation is profile-gated; status lookup is owner-scoped and expired pending enrollments become failed. Verified card-token callbacks complete enrollment. Removing a default card selects the newest remaining active test card. External sandbox success still requires merchant configuration and end-to-end verification.

## Source entry points
- `src/controllers/payment.controller.js`
- `src/routers/payment.router.js`
- `src/routers/organizer.router.js`
- `src/services/paymob.service.js`
- `src/services/paymob-payout.service.js`
- `src/services/payout-method.service.js`
- `src/services/card-token.service.js`
- `db/models/event-settlement.model.js`
- `db/models/settlement-line.model.js`
- `db/models/organizer-card.model.js`
- `db/models/organizer-card-enrollment.model.js`
- `test/paymob-payment.test.js`

## Change coupling
Frontend settlement/result/card controls depend on these contracts. Unit tests do not establish merchant activation or live-service success.
