# Attendance, reviews, and performance

## Current behavior
Attendance is unique per event/talent with present/absent/late states. Excused is an application state. Manual recording requires hired membership and a non-cancelled event; the organization can record it at any time, independent of the QR check-in window. Reviews require the event to be completed or ended, and the usher to have present/late attendance.

Owner generates one QR while open. Persisted creation timestamp/event ID form an HMAC-signed token; subsequent reads reproduce its URL. Check-in verifies signature/timestamp, hired membership, event not completed/cancelled, and the check-in window: from 2 hours before the event starts until 2 hours after it ends (event schedule in APP_TIMEZONE). Arriving more than 15 minutes after the start records late; otherwise present. A repeated scan keeps the first status and check-in time and reports alreadyCheckedIn; a scan replaces an absent mark. Repeats do not increment the good streak. No GPS check exists.

Present/late records contribute to a good-event streak; five good events reset late excuses and streak. Absence resets streak. Event-specific reviews reject duplicate reviewer/person/event entries and refresh rating aggregates. The review comment is optional; an empty comment is stored as null. GET /organizer/events/:id/reviews lets the frontend show who has already been rated.

Absent and unmarked ushers are left out of payments. Once an usher's payment has started (a settlement line whose collection is not failed), the organization can no longer mark them absent.

Performance verification requires at least 10 present/late attendance records on accepted applications and rating at least 4. completedEventsCount is attendance-derived, not solely the event's completed status. Reliability is present/late percentage among attendance on accepted applications, defaulting to 100 with no records.

## Source entry points
- `src/utils/attendanceQr.js`
- `src/controllers/usher.controller.js`
- `src/controllers/organizer.controller.js`
- `src/validators/event.validator.js`
- `db/models/attendance.model.js`
- `db/models/review.model.js`
- `test/attendanceQr.test.js`

## Change coupling
QR URLs target frontend /talent/check-in/[token]. Attendance changes affect payments and profile statistics.
