# Events and lifecycle

## Current behavior
Event stores organizer, date/deadline/times, category/location/gathering point/photo, required count, optional male/female counts, per-usher budget, dress code/notes, hired talent IDs, supervisor IDs, and WhatsApp metadata.

Statuses are open/confirmed/completed/cancelled. Creation starts open; owner close changes open to confirmed. Organizations cannot cancel or delete events: the organizer update rejects status changes, and there is no organizer delete or action-request route. Admins cancel/delete directly and still resolve action requests created before this rule.

`src/utils/eventSchedule.js` turns the stored calendar day (`eventDate`, midnight UTC from the form date) plus local `startTime`/`endTime` into instants in `APP_TIMEZONE` (default Africa/Cairo); an end time at or before the start time means the event ends the next day. The owner can complete an open or confirmed event through PATCH /organizer/events/:id/complete once its end time has passed; completion unlocks payments. All status changes go through `EventService.changeStatus`, which enforces `EVENT_STATUS_TRANSITIONS` (cancelled is final; completed can move back to confirmed or to cancelled only while no settlement other than a failed one exists). Cancelling or completing rejects remaining pending applications and declines pending referrals; cancellation also notifies hired ushers and pending applicants. Admin status changes and approved cancel requests use the same path.

Editing is staged by `src/utils/eventEditing.js`. Open events accept every field, except that pay cannot be lowered once ushers are hired. Confirmed events accept title, date, times, location, meeting point, dress code, notes, and WhatsApp link; staffing counts, gender split, category, deadline, and pay are locked. Once the event starts only notes and the WhatsApp link change. Completed and cancelled events cannot be edited. Values equal to the stored ones are ignored, so a form may resend unchanged fields; a changed locked field returns 409. Changing the date of an event with hired ushers is rejected when any of them is hired for another non-cancelled event that day. When the date, times, location, meeting point, pay, or dress code change, hired ushers are notified.

Create/update validate times, dates/deadline, gender totals, and count relative to hired staff. Inspect both validators and controllers; their rules are not necessarily identical.

Company queries resolve organizerId from owner/staff. Talent responses hide QR metadata and hide WhatsApp fields until accepted. Group workflow stores an organizer-provided link or supplies a wa.me message-sharing link; no WhatsApp provisioning API is implemented.

The organization dashboard reads owned event IDs, statuses, and hired talent IDs for its totals, then loads recent and active event lists and counts pending applications for those event IDs. Pending applications includes all owned events, including completed and cancelled events.

New event photos upload to `ECOM/organization/{organizerId}/events/{eventId}/photos`, using IDs from the ownership-checked event record and the shared `src/utils/uploadFolders.js` helper. Existing photos are not moved, and replacements continue deleting the previous stored public ID. The photo response contract is unchanged.

Each event may also have a separate map image and named pins. The owner uploads or replaces a JPEG/PNG map (5 MB limit), then creates pins at percentage x/y coordinates and assigns hired usher IDs. Each usher can occupy only one pin per event; a pin may hold multiple ushers. Pin mutations lock the event row, and assignment removal during application rejection or excuse removes the usher from pins. New assignments create a notification and request email delivery with a link to the usher map page. Workspace staff can read the organization map; only the owner can change it. The usher map endpoint requires hired membership and an assigned pin, returns the full map image and only that usher's pin data, and does not expose other assignments. Map image/pins are excluded from ordinary talent event serialization.

Event deletion soft deletes the event, applications, attendance, reviews, referrals, settlements, and normally its action requests in one transaction. Event photos/maps remain stored. Approved admin delete requests preserve the action-request history as before; subsequent normal event lookups return no event. Settlement lines remain available internally for reconciliation of already-started payments, while deleted settlements are excluded from normal API lookups.

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
Lifecycle changes can affect applications, attendance, payments, and frontend controls. The frontend edit modal mirrors the edit stages. Relevant checks: test/eventVisibility.test.js, test/eventEditing.test.js.
