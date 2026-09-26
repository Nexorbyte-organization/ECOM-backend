# Administration

## Current behavior
Admin routes require authenticated admin role. Features include platform totals, user/talent/company lists and invitations, blocking, verification/status updates, deletion, and late-excuse reset.

Admins list/moderate/delete events and resolve cancel/delete requests. Approval applies the requested action and records resolution as implemented; deletion uses shared relation cleanup. Read controllers before changing transitions. Email verification and talent performance verification differ.

## Source entry points
- `src/routers/admin.router.js`
- `src/controllers/admin.controller.js`
- `src/services/event.service.js`
- `db/models/event-action-request.model.js`
- `src/validators/user.validator.js`

## Change coupling
Changes affect frontend admin dashboard/users/events. Permission changes require ROLES.md; lifecycle changes require events.md.
