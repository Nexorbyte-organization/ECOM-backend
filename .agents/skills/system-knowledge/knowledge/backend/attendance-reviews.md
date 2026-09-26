# Attendance, reviews, and performance

## Current behavior
Attendance is unique per event/talent with present/absent/late states. Excused is an application state. Manual recording requires hired membership and either a non-open event or elapsed application deadline.

Owner generates one QR while open. Persisted creation timestamp/event ID form an HMAC-signed token; subsequent reads reproduce its URL. Check-in verifies signature/timestamp, hired membership, event not completed/cancelled, and elapsed deadline if still open. It records present, preserves first check-in time, and reports alreadyCheckedIn on repeated present check-in. Repeats do not increment the good streak. No GPS check exists.

Present/late records contribute to a good-event streak; five good events reset late excuses and streak. Absence resets streak. Event-specific reviews reject duplicate reviewer/person/event entries and refresh rating aggregates.

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
