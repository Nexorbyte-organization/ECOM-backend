# Applications, booking, excuses, and referrals

## Current behavior
Application joins event/talent with pending/accepted/rejected/excused status, direct-book flag, and referral origin. Unique event/talent constraint prevents duplicates. Applying requires a complete profile and an open event before its deadline.

Decision service synchronizes application status and event.hiredTalents. Acceptance checks capacity and other non-cancelled hired bookings on the same date. Callers use transactions/row locks. Organizer auto-accept preference applies to rating strictly above 4.5; capacity/date conflicts leave the application pending. Direct booking creates a pending direct application before acceptance.

Excuse requires the user's accepted application and an event not already occurred. Late-excuse threshold is three days relative to applicationDeadline, not event start. Excusing removes hired membership; late excuses increment lateExcuseCount and reset the good-event streak.

Referrals have pending/accepted/declined states. Existing-user referrals and purpose-bound new-user invite links are distinct. Public auth invite preview precedes authenticated redemption and acceptance/decline. Referral acceptance enters the application workflow.

## Source entry points
- `src/controllers/usher.controller.js`
- `src/controllers/organizer.controller.js`
- `src/controllers/user.controller.js`
- `src/services/application-decision.service.js`
- `src/routers/usher.router.js`
- `db/models/application.model.js`
- `db/models/referral.model.js`

## Change coupling
Acceptance changes affect capacity, hired lists, frontend jobs/referrals, attendance, and settlement eligibility.
