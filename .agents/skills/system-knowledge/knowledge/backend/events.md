# Events and lifecycle

## Current behavior
Event stores organizer, date/deadline/times, category/location/gathering point/photo, required count, optional male/female counts, per-usher budget, dress code/notes, hired talent IDs, supervisor IDs, and WhatsApp metadata.

Statuses are open/confirmed/completed/cancelled. Creation starts open; owner close changes open to confirmed. Direct cancellation/deletion is limited to open events. Other cancellation/deletion uses admin action requests; duplicate pending requests of the same type are rejected. Admin controls completion/status changes.

Create/update validate times, dates/deadline, gender totals, and count relative to hired staff. Inspect both validators and controllers; their rules are not necessarily identical.

Company queries resolve organizerId from owner/staff. Talent responses hide QR metadata and hide WhatsApp fields until accepted. Group workflow stores an organizer-provided link or supplies a wa.me message-sharing link; no WhatsApp provisioning API is implemented.

## Source entry points
- `src/routers/organizer.router.js`
- `src/controllers/organizer.controller.js`
- `src/controllers/admin.controller.js`
- `src/validators/event.validator.js`
- `src/utils/eventVisibility.js`
- `src/services/event.service.js`
- `db/models/event.model.js`
- `db/models/event-action-request.model.js`

## Change coupling
Lifecycle changes can affect applications, attendance, payments, and frontend controls. Relevant check: test/eventVisibility.test.js.
