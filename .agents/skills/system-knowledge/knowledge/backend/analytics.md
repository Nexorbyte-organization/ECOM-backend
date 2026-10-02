# Analytics

## Current behavior

`GET /organizer/analytics` (also `/provider/analytics`) is available to the organization owner and workspace staff. It resolves the owner from `providerOwnerId` for staff and scopes every event-derived query to that owner's live events. Organization-owned ledger, withdrawal, favorite, staff, and pending action-request queries use the owner ID directly. `GET /admin/analytics` requires the admin role and returns platform-wide aggregates. Admin acting sessions use organization access and cannot use admin routes until stopped. Both endpoints are read-only, return `{ success, data }`, and do not paginate or expose individual users, payment details, or raw payout destinations.

Analytics contain all-time totals for live events, positions, hired slots, event statuses/categories, applications (including direct invitations), attendance/QR marks, referrals, and review count/average. The only time-bounded series is events created by month for the current month and preceding 11 months. `recent` is limited to six live events. Hires count event slots on non-cancelled events, so one usher on two events counts twice. Booked value is the sum of current event per-usher budgets multiplied by current hired slots on non-cancelled events; it is neither collected cash nor earned revenue.

Money is returned as EGP converted from stored piasters. Paid advance funding is split between Paymob and credit applied to events. Paid settlement collections show checkout amounts and fees in paid settlements; retained no-show fees stored on events are shown separately. Payout amounts are settlement-line entitlements by current payout state for paid settlements only; `cash_due` is owed directly by organizations. Credit balance is the sum of active ledger entries. Card refunds are grouped by current status, including failed refunds converted to organization credit. These are different flows and must not be added together as a single revenue total. A paid funding row that was later refunded has `refunded` status and is excluded. Deleted events and their relations are excluded from event-based metrics; credit and refund ledgers use their own live rows.

The attention section counts open, confirmed, or completed but unreleased prefund events whose current hired-team requirement exceeds paid event funding, the resulting shortfall, pending event requests, and (admin only) ushers with at least five late excuses. Organization people counts are staff by role and favorite ushers. Admin people counts include active users by role, blocked/verified accounts, favorite entries, the five organizations with most events, and the five highest-rated ushers with completed events. Rankings return only display names and aggregate counts/rating.

The queries are bounded aggregates and a six-row recent list; they do not load full event or user collections into application memory. No schema change or cached snapshot is involved, so each request reflects the current committed database state.

## Source entry points

- `src/services/analytics.service.js`
- `src/controllers/organizer.controller.js`
- `src/controllers/admin.controller.js`
- `src/routers/organizer.router.js`
- `src/routers/admin.router.js`
- `test/analytics.test.js`

## Change coupling

The frontend dashboard contract is described in its analytics knowledge file. New financial states or event ownership rules must be reflected in these aggregates and their labels.
