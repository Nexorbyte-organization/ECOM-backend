# Events and lifecycle

## Current behavior
Event stores organizer, schedule (`days`), deadline, category/location/gathering point/photo, required count, standby count (see [applications](applications-referrals.md)), optional male/female counts, per-usher budget (pay per usher for each event day, at least 600 EGP), dress code/notes, hired talent IDs, supervisor IDs, WhatsApp metadata, an optional venue pin (`venueLatitude`/`venueLongitude`, both or neither) used for location check-in, and `noShowFeeCents` recorded at release.

Statuses are open/confirmed/completed/cancelled. Creation starts open with `fundingMode: prefund`; owner close changes open to confirmed and requires the hired team to be fully funded (prefund) or the organization to be trusted (pay_after); see [payments](payments.md). Organizations cannot cancel or delete events: the organizer update rejects status changes, and there is no organizer delete or action-request route. Admins cancel/delete directly and still resolve action requests created before this rule.

An event runs on 1–14 days (`days`: `[{ date: 'YYYY-MM-DD', startTime, endTime }]`, different dates within 30 calendar days, each with its own hours and end after start). Create sends `days`, or `eventDate`/`startTime`/`endTime` for a one-day event; `normalizeEventDays` validates and sorts them and `scheduleFromDays` derives the stored columns: `eventDate`/`startTime`/`endTime` mirror the first day (so date-ordered queries keep working) and `endDate` is the last day. Events created before multi-day support have empty `days` and `endDate` backfilled to `eventDate`; `eventDays(event)` falls back to `eventDate`/`startTime`/`endTime` for them, and `Event.toJSON` always returns `days`, `dayCount`, and `endDate`. `src/utils/eventSchedule.js` turns each day (midnight UTC calendar date plus local times) into instants in `APP_TIMEZONE` (default Africa/Cairo); an end time at or before the start time means that day ends the next day (create/edit validation rejects this for new schedules). The event starts at the first day's start and ends at the last day's end. The owner can complete an open or confirmed event through PATCH /organizer/events/:id/complete once its end time has passed; completion unlocks payments. Events are also completed automatically 24 hours after they end (see [payments](payments.md)). All status changes go through `EventService.changeStatus`, which enforces `EVENT_STATUS_TRANSITIONS` (cancelled is final; completed can move back to confirmed or to cancelled only while no settlement other than a failed one exists and its prefunded payments were not released). Cancelling a prefund event with paid funding settles it in the same transaction (credit/compensation split by hours before start). Cancelling or completing rejects remaining pending and standby applications and declines pending referrals; cancellation also notifies hired ushers and pending applicants. Admin status changes and approved cancel requests use the same path.

Editing is staged by `src/utils/eventEditing.js`. A schedule edit sends the full `days` list; a one-day event may still send `eventDate`/`startTime`/`endTime` (`withScheduleChanges` turns them into `days`), while a multi-day event that sends them gets 400. Open events accept every field, except that pay cannot be lowered and days cannot be removed once ushers are hired. Confirmed events accept title, days (dates and times, but not the number of days, since pay covers every day), location, meeting point, venue pin, dress code, notes, WhatsApp link, and standby count (not below the current standby list); staffing counts, gender split, category, deadline, and pay are locked. Once the event starts only notes and the WhatsApp link change. Completed and cancelled events cannot be edited. Values equal to the stored ones are ignored, so a form may resend unchanged fields; a changed locked field returns 409. Changing the schedule of an event with hired ushers is rejected when any of them is hired for another non-cancelled event on one of its days (`findBookingConflict` in `src/services/application-decision.service.js` finds candidates by `eventDate`/`endDate` range and then matches actual days, so an event in a gap between days does not clash). When the dates/times, location, meeting point, pay, or dress code change, hired ushers are notified.

Create/update validate times, dates/deadline, gender totals, and count relative to hired staff. Inspect both validators and controllers; their rules are not necessarily identical.

Company queries resolve organizerId from owner/staff. Talent responses hide `noShowFeeCents` and hide WhatsApp fields until accepted. Group workflow stores an organizer-provided link or supplies a wa.me message-sharing link; no WhatsApp provisioning API is implemented.

The WhatsApp invite message names the date, or the first and last date and number of days of a multi-day event.

The organization dashboard reads owned event IDs, statuses, and hired talent IDs for its totals, then loads recent and active event lists and counts pending applications for those event IDs. Pending applications includes all owned events, including completed and cancelled events.

The separate organization analytics endpoint aggregates owned event, staffing, review, and financial data directly in SQL; see [analytics](analytics.md). It does not change the legacy dashboard response.

New event photos upload to `ECOM/organization/{organizerId}/events/{eventId}/photos`, using IDs from the ownership-checked event record and the shared `src/utils/uploadFolders.js` helper. Existing photos are not moved, and replacements continue deleting the previous stored public ID. The photo response contract is unchanged.

Each event may also have a separate map image and named pins. The owner uploads or replaces a JPEG/PNG map (5 MB limit), then creates pins at percentage x/y coordinates and assigns hired usher IDs. Each usher can occupy only one pin per event; a pin may hold multiple ushers. Pin mutations lock the event row, and assignment removal during application rejection or excuse removes the usher from pins. New assignments create a notification and request email delivery with a link to the usher map page. Workspace staff can read the organization map; only the owner can change it. The usher map endpoint requires hired membership and an assigned pin, returns the full map image and only that usher's pin data, and does not expose other assignments. Map image/pins are excluded from ordinary talent event serialization.

Event deletion is refused while the event holds paid, unreleased advance funding (cancel first). Event deletion soft deletes the event, applications, attendance, reviews, referrals, settlements, and normally its action requests in one transaction. Event photos/maps remain stored. Approved admin delete requests preserve the action-request history as before; subsequent normal event lookups return no event. Settlement lines remain available internally for reconciliation of already-started payments, while deleted settlements are excluded from normal API lookups.

## Source entry points
- `src/routers/organizer.router.js`
- `src/controllers/organizer.controller.js`
- `src/controllers/admin.controller.js`
- `src/validators/event.validator.js`
- `src/utils/eventVisibility.js`
- `src/services/event.service.js`
- `db/models/event.model.js`
- `src/controllers/event-map.controller.js`
- `db/models/event-action-request.model.js`
- `src/utils/eventEditing.js`

## Change coupling
Lifecycle changes can affect applications, attendance, payments, and frontend controls. The frontend edit modal mirrors the edit stages. Relevant checks: test/eventVisibility.test.js, test/eventEditing.test.js, test/eventSchedule.test.js.

Contract for the frontend: events carry `days`, `dayCount`, and `endDate`; create/edit forms send `days` (YYYY-MM-DD dates, HH:mm times) and treat `budget` as pay per usher per day; the edit modal must lock the number of days outside the open stage and day removal once ushers are hired.
