# Settlements, Paymob, cards, and payouts

## Advance funding (prefund) and trust tiers
Every event has `fundingMode`. New events default to `prefund`; events that existed before advance funding were migrated to `pay_after` so they keep the post-event checkout described below. Rules and constants live in `src/services/funding-policy.js`; orchestration in `src/services/funding.service.js`.

Prefund: required funding = hired ushers × budget (gross, in piasters). Paid `EventFunding` rows count toward it; pending, failed, and refunded rows do not. The owner funds through POST /organizer/events/:id/funding: organization credit is applied first (unless `useCredit: false`) as a `credit` funding row, and only the rest becomes one Paymob checkout (`paymob` row, special reference `OO-FUND-…`, redirect `/provider/payments/result?fundingId=…`). The event row and organization row are locked; a partial unique index allows only one not_started/pending checkout per event, and an active checkout with the same card and amount is reused. If the Paymob request fails, the applied credit stays on the event and only the checkout part is retried. Stale funding checkouts reconcile through the same rules as settlements.

Closing (open→confirmed) a prefund event requires zero shortfall. Hires and pay rises after funding create a new shortfall due `FUNDING_DEADLINE_HOURS` (48) before start; overdue is shown to the organization, admins (underfunded list), and hired ushers (`paymentProtection: awaiting_funding` on GET /usher/events/:id). There is no scheduled job, so missing the deadline does not cancel anything automatically. Hired ushers are notified when an event becomes fully funded.

Release (POST /organizer/events/:id/release-payments, owner; admin variant accepts `unmarkedAs`): the event must be completed and not released, every hired usher must have an attendance mark, and funding must cover the whole hired team. Present/late ushers get a `prefund` settlement (`OO-REL-…`, collectionStatus paid, no Paymob collection) with 95%/5% lines. Ushers without a supported payout account get `awaiting_method` lines instead of cash; adding or changing their default payout method queues and sends them. Absent ushers' gross pay becomes an `AbsenceHold` for `DISPUTE_WINDOW_HOURS` (72). Surplus (e.g. excused ushers) becomes credit. `fundsReleasedAt` makes release one-time; a released event cannot leave completed.

Absence protection: an attendance created or confirmed by the usher's QR scan has `checkInMethod: qr` and the organization cannot mark it absent. A held absence can be disputed once by its usher before `releaseAfter`. If the organization changes the usher to present/late, or an admin decides for the usher, the hold is paid through an individual `prefund` settlement (`OO-AWARD-…`, line type `dispute_award`); an admin decision for the usher also sets attendance to present with method `admin`. An undisputed hold returns to organization credit after the window; this is applied lazily whenever holds, credit, or funding are read, because there is no scheduler. Holds are claimed with conditional updates and credit entries use unique references, so concurrent readers cannot settle twice.

Cancellation (admin status change or approved cancel request) of a prefund event with paid funding, before release, splits funding by hours before start: ≥72h 100% credit; 24–72h 50% credit and 50% of each hired usher's pay as compensation; <24h (including after start) 0% credit and full compensation. Compensation is a `prefund` settlement (`OO-CANCEL-…`, line type `cancellation_compensation`, null attendance) paid like release lines. Underfunded events share compensation out of what was paid. A funded, unreleased event cannot be deleted until cancelled.

Late and refunded payments: a funding checkout paid after the event was cancelled, released, deleted, or switched to pay-after becomes `late_funding_refund` credit. A Paymob refund callback of paid funding before release just removes it from the funded total; after release or after late credit it records a negative `chargeback` entry.

Credit is an append-only ledger (`OrganizerCreditEntry`, signed piasters, unique `reference` per effect). Debits lock the organization user row. Owners can request one withdrawal at a time (reserved immediately as a negative entry, minimum 1 EGP); admins mark it paid with a transfer reference (paid outside the platform) or reject it, and the organization can cancel it while pending; rejection/cancellation adds a reversal entry. Admins can add signed adjustments with a note.

Trust tiers: `trusted` organizations may switch an event to `pay_after` (PATCH /organizer/events/:id/funding-mode) while it has no funding and is not completed/cancelled; switching back to prefund is blocked once any settlement exists. Automatic trust requires ≥3 paid events (released prefund events or pay-after events with a paid checkout), no pay-after event with an unpaid present usher 7+ days after it ended, no admin dispute decided for an usher in the last 90 days, and a non-negative credit balance. `users.paymentTierOverride` (admin) wins. Closing a pay-after event requires the organization to be trusted at that moment.

Account deletion is refused while an organization has non-zero credit, a pending withdrawal, or active holds, or while an usher has awaiting/queued/processing pay or active holds.

## Pay-after settlements (post-event checkout)
Settlement preview/create (bulk and individual) is only available for `pay_after` events; prefund events return 409. Cash marking is only for `checkout` settlements.

Owner settlement preview/create requires an owned completed event. Eligible lines are hired ushers with present/late attendance; absent and unmarked ushers are excluded, and no eligible attendance is an error. Marking an usher absent is rejected once their payment has started, so a started payment never covers an absent usher.

Budget is per usher. Gross cents = round(budget × 100); fee cents = round(gross × 5%); entitlement = gross minus fee. Digital lines collect gross and pay entitlement; cash lines collect fee only and the organizer pays entitlement in cash.

Default payout method wins, otherwise first method. Wallet needs issuer/destination; bank needs destination/bank code. Unsupported/missing/incomplete details become cash.

On settlement creation, the owner may send `excludedTalentIds` with unique IDs from the event's eligible ushers. Selected ushers become cash lines even when they have a supported payout account: Paymob collects only their 5% fee, the organizer owes their 95% entitlement in cash, and no automatic payout is queued for them. Invalid or ineligible IDs are rejected. An active checkout can be reused only with the same card and matching line payout/collection choices; choices can change when a new checkout is created after expiry. The frontend payment panel sends this selection and updates its displayed totals before checkout.

An event can have one bulk settlement or individual settlements per eligible usher. A confirmed failed bulk collection allows separate per-usher checkouts; once any individual checkout starts, bulk checkout is unavailable for that event. Pending or paid bulk collection blocks individual collection, preventing duplicate charges. Paymob does not call back for an abandoned checkout, so an expired pending checkout is reconciled when the owner reads or starts a settlement. With PAYMOB_API_KEY, 15 minutes after expiry the backend asks Paymob for the order transaction and applies it through the same path as the callback; no transaction marks the checkout failed so it can restart, while an unreachable or mismatched inquiry leaves it blocked. Without PAYMOB_API_KEY an expired checkout becomes failed 24 hours after expiry. A checkout stuck in preparation (`not_started`) for 10 minutes becomes failed, since no payment page was issued. A paid collection cannot restart; a pending individual checkout is reused and an unresolved expired checkout cannot be replaced until Paymob confirms failure. Backend recalculates totals. Cash-paid marking requires collected settlement and a cash line. Public serialization hides raw payout destinations/metadata.

Collection is test-only. Checkout creation rejects digital payout lines when Paymob Payouts Sandbox credentials are not configured, so the owner cannot collect a payment that would only leave those payouts queued. Callback validates transaction/card-token HMAC, test/integration identity, settlement linkage, amount/currency. Redirect query parameters are not payment proof. Successful collection triggers automatic payouts for every queued digital line; a repeated valid paid callback can continue queued lines, and each line is claimed before its payout request to avoid overlapping sends. Cash lines are paid directly by the organizer. External payout failures are recorded per line, and payout reconciliation remains incomplete; a transfer left in processing after an interrupted request requires reconciliation before retrying.

After collection succeeds, the owner may retry a single digital payout only when Paymob has explicitly reported a terminal failed/rejected status. A provider timeout, unknown status, or legacy failure is not considered safe to retry because the transfer may have succeeded; its line remains visible with a failure/processing reason for reconciliation. An atomic line update claims a retry before sending so two clicks cannot send it twice, and increments the attempt number used in Paymob's client reference. Individual collection and payout status are returned per settlement, and the event payment UI shows Paid, Payment failed, Payout failed, and pending states beside each usher. Schema migration replaces the unique event settlement key with one bulk settlement per event and one individual settlement per event/usher, and adds retry-safety and attempt fields to settlement lines.

Saved card tokens use AES-256-GCM with a key derived from the configured Paymob Test secret; optional PAYMOB_TOKEN_ENCRYPTION_KEY supports legacy decryption. Checkout accepts an owned active test card. Backend exposes card list/delete/verify, enrollment creation/status, and default selection. Enrollment creation is profile-gated and requires PAYMOB_CARD_INTEGRATION_ID, a Test Normal 3DS or Auth card integration with card saving enabled; it never selects the first general payment method as a fallback. Status lookup is owner-scoped. Verified card-token callbacks complete enrollment; when PAYMOB_API_KEY is configured, pending status lookup can recover a token through Paymob's order-based card-token inquiry if the callback was missed. Both paths require the Paymob order to match the saved checkout. Expired pending enrollments become failed. Removing a default card selects the newest remaining active test card. External sandbox success still requires merchant configuration and end-to-end verification.

Saved-card removal sets `deletedAt` as well as disabling the card and selecting another default. Organization deletion hides its cards, enrollments, and settlements; event deletion hides its settlements. Valid HMAC payment callbacks explicitly include archived checkouts so an already-started collection can still be recorded and payable lines processed. Internal payout identity lookup includes archived ushers; no new notification is sent to deleted accounts. Late card-token callbacks and order-based inquiries cannot recreate a removed card or create a card for a deleted organization/checkout. Settlement lines replaced during checkout retry are soft deleted; a partial unique index on `(settlementId, talentId)` where `deletedAt IS NULL` permits a new active line while retaining prior attempts.

## Source entry points
- `src/services/funding-policy.js`
- `src/services/funding.service.js`
- `src/services/absence-hold.service.js`
- `src/services/organizer-credit.service.js`
- `src/services/settlement.service.js`
- `src/controllers/funding.controller.js`
- `db/models/event-funding.model.js`
- `db/models/organizer-credit-entry.model.js`
- `db/models/credit-withdrawal.model.js`
- `db/models/absence-hold.model.js`
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
Frontend settlement/result/card controls, the event funding panel, the organization payments page, the usher held-pay list, and the admin payments page depend on these contracts. Unit tests do not establish merchant activation or live-service success. `test/fundingPolicy.test.js` covers the pure rules.
