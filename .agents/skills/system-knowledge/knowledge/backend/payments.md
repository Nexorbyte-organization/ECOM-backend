# Settlements, Paymob, cards, and payouts

## Current behavior
Owner settlement preview/create requires an owned completed event. Eligible lines are hired ushers with present/late attendance; no eligible attendance is an error.

Budget is per usher. Gross cents = round(budget × 100); fee cents = round(gross × 5%); entitlement = gross minus fee. Digital lines collect gross and pay entitlement; cash lines collect fee only and the organizer pays entitlement in cash.

Default payout method wins, otherwise first method. Wallet needs issuer/destination; bank needs destination/bank code. Unsupported/missing/incomplete details become cash.

On settlement creation, the owner may send `excludedTalentIds` with unique IDs from the event's eligible ushers. Selected ushers become cash lines even when they have a supported payout account: Paymob collects only their 5% fee, the organizer owes their 95% entitlement in cash, and no automatic payout is queued for them. Invalid or ineligible IDs are rejected. An active checkout can be reused only with the same card and matching line payout/collection choices; choices can change when a new checkout is created after expiry. The frontend payment panel sends this selection and updates its displayed totals before checkout.

An event can have one bulk settlement or individual settlements per eligible usher. A confirmed failed bulk collection allows separate per-usher checkouts; once any individual checkout starts, bulk checkout is unavailable for that event. Pending or paid bulk collection blocks individual collection, preventing duplicate charges. A paid collection cannot restart; a pending individual checkout is reused and an unresolved expired checkout cannot be replaced until Paymob confirms failure. Backend recalculates totals. Cash-paid marking requires collected settlement and a cash line. Public serialization hides raw payout destinations/metadata.

Collection is test-only. Checkout creation rejects digital payout lines when Paymob Payouts Sandbox credentials are not configured, so the owner cannot collect a payment that would only leave those payouts queued. Callback validates transaction/card-token HMAC, test/integration identity, settlement linkage, amount/currency. Redirect query parameters are not payment proof. Successful collection triggers automatic payouts for every queued digital line; a repeated valid paid callback can continue queued lines, and each line is claimed before its payout request to avoid overlapping sends. Cash lines are paid directly by the organizer. External payout failures are recorded per line, and payout reconciliation remains incomplete; a transfer left in processing after an interrupted request requires reconciliation before retrying.

After collection succeeds, the owner may retry a single digital payout only when Paymob has explicitly reported a terminal failed/rejected status. A provider timeout, unknown status, or legacy failure is not considered safe to retry because the transfer may have succeeded; its line remains visible with a failure/processing reason for reconciliation. An atomic line update claims a retry before sending so two clicks cannot send it twice, and increments the attempt number used in Paymob's client reference. Individual collection and payout status are returned per settlement, and the event payment UI shows Paid, Payment failed, Payout failed, and pending states beside each usher. Schema migration replaces the unique event settlement key with one bulk settlement per event and one individual settlement per event/usher, and adds retry-safety and attempt fields to settlement lines.

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
