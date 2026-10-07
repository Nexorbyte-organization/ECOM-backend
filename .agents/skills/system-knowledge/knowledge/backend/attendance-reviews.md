# Attendance, reviews, and performance

## Current behavior
Attendance is unique per event/talent/day (`dayIndex`, 0-based in date order; records from before multi-day support are day 0) with present/absent/late states. On a multi-day event ushers check in every day and are paid for the days they check in (see [payments](payments.md)). Excused is an application state. Check-in is the single source of truth: an usher proves attendance with their own phone, staff can only check someone in, and a missed check-in becomes absent automatically. Nobody can mark an usher absent by hand, so there is nothing to dispute.

Check-in points (`CheckInPoint`, one per event and staff user): any organization workspace user opens the check-in screen, which calls PUT /organizer/events/:id/check-in-points/me every few seconds with the phone's location (required, accuracy ≤ 500 m). The response contains a QR URL (`/talent/check-in/<token>`) and a 6-digit code, both signed with the point's server-side secret and rotating every 30 seconds (`src/utils/checkInCode.js`; the previous two steps are still accepted). Codes are returned only during the check-in window. DELETE …/check-in-points/me closes the caller's point; GET …/check-in-points lists points with `live` (location reported in the last 3 minutes). Several points can be open at once (gathering point, bus, venue).

Usher check-in (POST /usher/attendance/check-in, `location` required): `method: qr` with the scanned token, `method: code` with `eventId` and the 6-digit code, or `method: location` ("I'm here") with `eventId`. QR and code require the usher within 200 m of that staff phone, which must have reported its location in the last 3 minutes. "I'm here" succeeds within 200 m of any staff phone that reported in the last 15 minutes or of the event's optional venue pin (`venueLatitude`/`venueLongitude`). All methods require hired membership, a non-cancelled/non-completed unreleased event, and an open day window: from 2 hours before that day's start until 2 hours after its end (event schedule in APP_TIMEZONE; `checkInDayAt` picks the day, preferring a day that has not ended when windows overlap). Between days check-in is refused until the next day opens. Arriving more than 15 minutes after that day's start records late; otherwise present. A repeated check-in the same day keeps the first status and time; the response message names the day on multi-day events. The check-in point view returns the current (or next) day's `opensAt`/`closesAt`, `dayIndex`, and `dayCount`, and codes only while a day window is open. The record stores method (`qr`/`code`/`location`), point, and coordinates.

Staff check-in (POST /organizer/events/:id/attendance, workspace) accepts only present or late, for an usher whose phone cannot check in (no camera/location, dead battery). It records method `staff`, the staff user, and the staff phone location when sent. Optional `dayIndex` picks any day whose check-in has opened; by default it is the current day, or the latest day that has started. It cannot change an usher's own check-in for that day, cannot turn present into late, opens with the first day's check-in window, and stays possible until payments are released; it can change an automatic absent into present/late. Absent is never accepted.

When a day's check-in closes, `AttendanceService.finalizeAttendance` creates `absent` records (method `auto`) for that day for hired ushers without one and notifies them (naming the day on multi-day events). Three no-shows within 90 days (counted per event: missing several days of one event counts once) set `users.suspendedUntil` 30 days after the latest one; while suspended an usher cannot apply, accept invitations, or be accepted/direct-booked, and the suspension lifts on its own (it is recomputed whenever attendance changes, so a later staff check-in can clear it). Time-based steps run from `EventAutomationService` on reads of organization/usher events, dashboards, attendance, and funding (throttled to once a minute per scope) and from the scheduled sweep (see [runtime](runtime.md)).

Present/late records contribute to a good-event streak (only the first checked-in day of an event counts); five good events reset late excuses and streak. Absence resets streak. Reviews require the event to be completed or ended, and the usher to have present/late attendance on at least one day. Usher event history, profile history, and GET /usher/events/:id (hired) summarize per-day records with `summarizeAttendance`: `attendanceStatus` (present/late if any day was worked, absent if all recorded days were missed), `attendedDays`, `dayCount`, and `attendanceDays`. GET /organizer/events/:id/attendance returns one record per usher and day with `dayIndex` and `date`. Event-specific reviews reject duplicate reviewer/person/event entries. The review comment is optional; an empty comment is stored as null. GET /organizer/events/:id/reviews lets the frontend show who has already been rated. The rating is a weighted average: each organization's first two reviews of an usher count fully and later ones count 0.25 (`src/services/talent-stats.service.js`).

Verification requires at least 10 present/late attendance records on accepted applications, rating at least 4, and attended events from at least 3 different organizations. completedEventsCount (and the verification event count) is the number of distinct events with a present/late day, not solely the event's completed status. Reliability is the present/late percentage among attendance records (days) on accepted applications, defaulting to 100 with no records.

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
