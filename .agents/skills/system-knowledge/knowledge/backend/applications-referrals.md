# Applications, booking, excuses, and referrals

## Current behavior
`GET /talent/applications/my` pages with `size` or its alias `limit` (default 10, maximum 100).

Application joins event/talent with pending/accepted/rejected/excused/standby/withdrawn status, direct-book flag, and referral origin. Unique event/talent constraint prevents duplicates. Applying requires a complete profile and an open event before its deadline.

Decision service synchronizes application status and event.hiredTalents. Acceptance checks capacity, other non-cancelled hired bookings on the same date, no-show suspension (`users.suspendedUntil`), and, after a prefund event's funding deadline, that paid funding already covers the new usher. Callers use transactions/row locks. Organizer auto-accept preference applies to rating strictly above 4.5; capacity/date conflicts leave the application pending. Direct booking creates a pending direct application (an invitation). Only the usher can accept it, through PATCH /talent/applications/:applicationId/respond with `accept` or `decline`; acceptance runs the same capacity and same-date checks under row locks, and declining marks the application rejected. The organization may still reject (withdraw) a pending invitation but cannot accept it. Answers require a complete profile and an open or confirmed event that has not started.

Organization decisions are closed once the event starts or is cancelled/completed, and excused applications cannot be changed; accepting also requires an unblocked usher. Same-date conflicts compare the whole calendar day.

Ushers with 5 or more late excuses (`LATE_EXCUSE_LIMIT`) cannot apply, accept referrals, or accept booking invitations until the counter is reset (by an admin or five good events). Organizations can still decide on their existing applications.

An organization can preview the most recent past, non-cancelled event with a hired team via `GET /organizer/events/:id/last-team`. `POST /organizer/events/:id/rebook-last-team` sends pending direct-book invitations from that team to an owned open event. It skips existing applications and currently unavailable ushers, limits new invitations to unfilled slots after hired ushers and pending direct invitations, and reports invited IDs plus per-usher skip reasons. Repeating the request does not duplicate applications or notifications. The usher still accepts each invitation through the normal application flow. The frontend must use these endpoints to expose the rebook action.

Standby (`src/services/standby.service.js`): an event's `standbyCount` (at most half `requiredCount`, rounded up) sets how many unpaid, on-call ushers it may keep. Standby ushers are not in `hiredTalents`, so funding, check-in, automatic absence, and statistics ignore them; they see the event but not the WhatsApp link or map. Standby is unpaid, so an application only becomes `standby` with the usher's agreement: `standbyOk` sent when applying, or accepting a standby invitation (POST /organizer/direct-book with `asStandby`, allowed for open or confirmed events before the start while the list has room). The organization puts a pending application on standby with status `standby`; accepting into a full event (including auto-accept) puts an usher with `standbyOk` on standby instead of failing. Joining requires room on the list, an unstarted event, and no hire elsewhere that day. Hiring an usher withdraws their standby applications for other events that day (`withdrawn`); the usher can leave standby without penalty through PATCH /usher/applications/:applicationId/leave-standby (`withdrawn`). GET /usher/events/:id returns `standbyPosition`.

When a hired spot opens before the start (an usher excuses, the organization rejects a hired usher, or `requiredCount` rises), `StandbyService.fillOpenSpots` moves standby ushers into the team in `standbySince` order through the normal acceptance checks, skipping anyone blocked, suspended, at the late-excuse limit, booked elsewhere that day, or refused by the funding check after the funding deadline (spots cancelled for lack of funding are therefore not refilled). It notifies the moved ushers and the organization, and warns the organization when a queue existed but spots stay open. The organization can also accept a standby usher manually or remove them (`rejected`). Moving in sets `promotedAt`; an excuse within `PROMOTION_GRACE_MS` (2 hours) of it is not late. Users have no gender field, so the event's gender split is not considered. At the start, the automation sweep releases the remaining list (`rejected`, in-app notice); cancelling or completing the event rejects standby with pending applications.

Excuse requires the user's accepted application and an event not already occurred. Late-excuse threshold is three days relative to applicationDeadline, not event start. Excusing removes hired membership; late excuses increment lateExcuseCount and reset the good-event streak.

Referrals have pending/accepted/declined states. Existing-user referrals and purpose-bound new-user invite links are distinct. Public auth invite preview precedes authenticated redemption and acceptance/decline. Referral acceptance enters the application workflow.

## Source entry points
- `src/controllers/usher.controller.js`
- `src/controllers/organizer.controller.js`
- `src/controllers/user.controller.js`
- `src/services/application-decision.service.js`
- `src/services/standby.service.js`
- `src/routers/usher.router.js`
- `db/models/application.model.js`
- `db/models/referral.model.js`
- `src/controllers/organization-talent.controller.js`

## Change coupling
Acceptance changes affect capacity, hired lists, the standby queue, frontend jobs/referrals, attendance, and settlement eligibility. Relevant check: test/standby.test.js.
