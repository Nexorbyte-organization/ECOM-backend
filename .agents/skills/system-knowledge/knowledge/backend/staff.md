# Organization staff

## Current behavior
Owners invite, update, block/unblock, and remove members/supervisors. Staff records use providerOwnerId; staff mutations require the owner's complete profile.

Owner assigns/removes supervisors belonging to the same company. supervisorIds stores the list; supervisorId mirrors the first for compatibility. Assignment emits notifications. Current company event queries are not restricted by supervisor assignment.

Removing a staff member now soft deletes the account and its notifications, and removes supervisor assignments in one transaction. Organization deletion also soft deletes its staff. Deleted staff are excluded from lists and cannot authenticate.

## Source entry points
- `src/controllers/staff.controller.js`
- `src/controllers/organizer.controller.js`
- `src/routers/organizer.router.js`
- `src/validators/event.validator.js`
- `src/middlewares/authentication.js`
- `db/models/user.model.js`
- `db/models/event.model.js`

## Change coupling
Access changes require ROLES.md and corresponding frontend staff/owner controls.
