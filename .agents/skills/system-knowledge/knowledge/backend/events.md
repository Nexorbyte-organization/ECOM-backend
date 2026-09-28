# Events and lifecycle

## Current behavior
Event stores organizer, date/deadline/times, category/location/gathering point/photo, required count, optional male/female counts, per-usher budget, dress code/notes, hired talent IDs, supervisor IDs, and WhatsApp metadata.

Statuses are open/confirmed/completed/cancelled. Creation starts open; owner close changes open to confirmed. Direct cancellation/deletion is limited to open events. Other cancellation/deletion uses admin action requests; duplicate pending requests of the same type are rejected. Admin controls completion/status changes.

Create/update validate times, dates/deadline, gender totals, and count relative to hired staff. Inspect both validators and controllers; their rules are not necessarily identical.

Company queries resolve organizerId from owner/staff. Talent responses hide QR metadata and hide WhatsApp fields until accepted. Group workflow stores an organizer-provided link or supplies a wa.me message-sharing link; no WhatsApp provisioning API is implemented.

New event photos upload to `ECOM/organization/{organizerId}/events/{eventId}/photos`, using IDs from the ownership-checked event record and the shared `src/utils/uploadFolders.js` helper. Existing photos are not moved, and replacements continue deleting the previous stored public ID. The photo response contract is unchanged.

Each event may also have a separate map image and named pins. The owner uploads or replaces a JPEG/PNG map (5 MB limit), then creates pins at percentage x/y coordinates and assigns hired usher IDs. Each usher can occupy only one pin per event; a pin may hold multiple ushers. Pin mutations lock the event row, and assignment removal during application rejection or excuse removes the usher from pins. New assignments create a notification and request email delivery with a link to the usher map page. Workspace staff can read the organization map; only the owner can change it. The usher map endpoint requires hired membership and an assigned pin, returns the full map image and only that usher's pin data, and does not expose other assignments. Map image/pins are excluded from ordinary talent event serialization.

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

## Change coupling
Lifecycle changes can affect applications, attendance, payments, and frontend controls. Relevant check: test/eventVisibility.test.js.
