# Applications, booking, excuses, and referrals

## Current behavior
`GET /talent/applications/my` pages with `size` or its alias `limit` (default 10, maximum 100).

Application joins event/talent with pending/accepted/rejected/excused status, direct-book flag, and referral origin. Unique event/talent constraint prevents duplicates. Applying requires a complete profile and an open event before its deadline.

Decision service synchronizes application status and event.hiredTalents. Acceptance checks capacity and other non-cancelled hired bookings on the same date. Callers use transactions/row locks. Organizer auto-accept preference applies to rating strictly above 4.5; capacity/date conflicts leave the application pending. Direct booking creates a pending direct application (an invitation). Only the usher can accept it, through PATCH /talent/applications/:applicationId/respond with `accept` or `decline`; acceptance runs the same capacity and same-date checks under row locks, and declining marks the application rejected. The organization may still reject (withdraw) a pending invitation but cannot accept it. Answers require a complete profile and an open or confirmed event that has not started.

Organization decisions are closed once the event starts or is cancelled/completed, and excused applications cannot be changed; accepting also requires an unblocked usher. Same-date conflicts compare the whole calendar day.

Ushers with 5 or more late excuses (`LATE_EXCUSE_LIMIT`) cannot apply, accept referrals, or accept booking invitations until the counter is reset (by an admin or five good events). Organizations can still decide on their existing applications.

An organization can preview the most recent past, non-cancelled event with a hired team via `GET /organizer/events/:id/last-team`. `POST /organizer/events/:id/rebook-last-team` sends pending direct-book invitations from that team to an owned open event. It skips existing applications and currently unavailable ushers, limits new invitations to unfilled slots after hired ushers and pending direct invitations, and reports invited IDs plus per-usher skip reasons. Repeating the request does not duplicate applications or notifications. The usher still accepts each invitation through the normal application flow. The frontend must use these endpoints to expose the rebook action.

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
- `src/controllers/organization-talent.controller.js`

## Change coupling
Acceptance changes affect capacity, hired lists, frontend jobs/referrals, attendance, and settlement eligibility.
