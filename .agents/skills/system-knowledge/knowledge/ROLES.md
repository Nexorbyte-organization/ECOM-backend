# Roles and authorization

- `usher`: own profile, payout methods, applications/referrals/history, event browsing, QR check-in. Complete-profile gates protect selected application/referral/excuse mutations; check-in is not profile-gated.
- `organizer`: owns company profile/events/staff. Owner-only routes include event creation/edit/delete/close, QR generation/read, supervisor assignment, WhatsApp creation, settlement preview/create/cash marking, card management.
- `organizer_member`, `organizer_supervisor`: company workspace reads plus decisions, direct booking, attendance/reviews, and action requests where routed. providerOwnerId resolves company ownership. Current event queries scope to company, not supervisor assignment.
- `admin`: platform users/events/action requests and authenticated settlement lookup.

Event maps: the organizer owner uploads the map and creates/edits/deletes pins and assignments; organizer staff can read the company map. An usher can fetch a map only while hired and assigned, and receives only their own pin details. Assignment accepts hired ushers only.

Authentication rejects blocked accounts and staff with missing/non-organizer/blocked owners. Staff profile gates use the owner. Route role checks do not replace controller record-ownership checks.

Sources: `src/utils/constant/enums.js`, `src/middlewares/authentication.js`, `src/routers/organizer.router.js`, `src/routers/usher.router.js`, `src/routers/admin.router.js`, `src/routers/payment.router.js`, `src/controllers/organizer.controller.js`.
