# Attendance, reviews, and performance

## Current behavior
Attendance is unique per event/talent with present/absent/late states. Excused is an application state. Check-in is the single source of truth: an usher proves attendance with their own phone, staff can only check someone in, and a missed check-in becomes absent automatically. Nobody can mark an usher absent by hand, so there is nothing to dispute.

Check-in points (`CheckInPoint`, one per event and staff user): any organization workspace user opens the check-in screen, which calls PUT /organizer/events/:id/check-in-points/me every few seconds with the phone's location (required, accuracy ≤ 500 m). The response contains a QR URL (`/talent/check-in/<token>`) and a 6-digit code, both signed with the point's server-side secret and rotating every 30 seconds (`src/utils/checkInCode.js`; the previous two steps are still accepted). Codes are returned only during the check-in window. DELETE …/check-in-points/me closes the caller's point; GET …/check-in-points lists points with `live` (location reported in the last 3 minutes). Several points can be open at once (gathering point, bus, venue).

Usher check-in (POST /usher/attendance/check-in, `location` required): `method: qr` with the scanned token, `method: code` with `eventId` and the 6-digit code, or `method: location` ("I'm here") with `eventId`. QR and code require the usher within 200 m of that staff phone, which must have reported its location in the last 3 minutes. "I'm here" succeeds within 200 m of any staff phone that reported in the last 15 minutes or of the event's optional venue pin (`venueLatitude`/`venueLongitude`). All methods require hired membership, a non-cancelled/non-completed unreleased event, and the window: from 2 hours before the start until 2 hours after the end (event schedule in APP_TIMEZONE). Arriving more than 15 minutes after the start records late; otherwise present. A repeated check-in keeps the first status and time. The record stores method (`qr`/`code`/`location`), point, and coordinates.

Staff check-in (POST /organizer/events/:id/attendance, workspace) accepts only present or late, for an usher whose phone cannot check in (no camera/location, dead battery). It records method `staff`, the staff user, and the staff phone location when sent. It cannot change an usher's own check-in, cannot turn present into late, opens with the check-in window, and stays possible until payments are released; it can change an automatic absent into present/late. Absent is never accepted.

When check-in closes, `AttendanceService.finalizeAttendance` creates `absent` records (method `auto`) for hired ushers without one and notifies them. Three no-shows within 90 days set `users.suspendedUntil` 30 days after the latest one; while suspended an usher cannot apply, accept invitations, or be accepted/direct-booked, and the suspension lifts on its own (it is recomputed whenever attendance changes, so a later staff check-in can clear it). Time-based steps run from `EventAutomationService` on reads of organization/usher events, dashboards, attendance, and funding (throttled to once a minute per scope) and from the scheduled sweep (see [runtime](runtime.md)).

Present/late records contribute to a good-event streak; five good events reset late excuses and streak. Absence resets streak. Reviews require the event to be completed or ended, and the usher to have present/late attendance. Event-specific reviews reject duplicate reviewer/person/event entries. The review comment is optional; an empty comment is stored as null. GET /organizer/events/:id/reviews lets the frontend show who has already been rated. The rating is a weighted average: each organization's first two reviews of an usher count fully and later ones count 0.25 (`src/services/talent-stats.service.js`).

Verification requires at least 10 present/late attendance records on accepted applications, rating at least 4, and attended events from at least 3 different organizations. completedEventsCount is attendance-derived, not solely the event's completed status. Reliability is present/late percentage among attendance on accepted applications, defaulting to 100 with no records.

## Source entry points
- `src/utils/checkInCode.js`
- `src/services/attendance.service.js`
- `src/services/talent-stats.service.js`
- `src/services/event-automation.service.js`
- `db/models/check-in-point.model.js`
- `src/controllers/usher.controller.js`
- `src/controllers/organizer.controller.js`
- `src/validators/event.validator.js`
- `db/models/attendance.model.js`
- `db/models/review.model.js`
- `test/checkIn.test.js`
- `test/talentStats.test.js`

## Change coupling
QR URLs target frontend /talent/check-in/[token], which must send the device location. Attendance changes affect payments, suspensions, and profile statistics.
