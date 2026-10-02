# Administration

## Current behavior
Admin routes require authenticated admin role. Features include platform totals, user/talent/company lists and invitations, blocking, verification/status updates, deletion, and late-excuse reset.

The admin analytics endpoint returns database aggregates for the full platform; see [analytics](analytics.md). The legacy dashboard endpoint remains available for older clients.

Admins can switch into any active, unblocked organization owner account from the admin user list. The acting session has that owner's full organization permissions, including financial actions, and no admin route access until stopped. The backend records the real admin actor on the request and logs acting mutations; there is no persistent audit table.

Admins list/moderate/delete events and resolve cancel/delete requests. Approval applies the requested action and records resolution as implemented; deletion uses shared relation cleanup. Read controllers before changing transitions. Email verification and talent performance verification differ.

Admin payments (`/admin/payments/*`, `/admin/organizers/:id/payments|payment-tier|credit-adjustments`, `/admin/events/:id/funding`): an overview of underfunded prefunded events and failed card refunds (already converted to credit); tier override; signed credit adjustments; and sending queued payouts. Attendance and payment release run automatically, so there are no dispute, withdrawal, or release decisions. See [payments](payments.md).

Admin user deletion is a soft delete. It is refused while money is unsettled: organization credit, a card refund in progress, or usher pay still waiting to be sent. Organization deletion uses one transaction for the organization, its staff and their notifications, owned events and event relations, organization notifications, settlements, saved cards, and card enrollments. Any dependent write failure rolls back the whole cascade. Deleted users and organizations are excluded from lists, lookups, and dashboard totals. Accounts retain their identity keys; invitations and signup still reject identities reserved by deleted accounts. The frontend reloads lists after deletion and describes retained data in its confirmation.

`npm run seed:demo` runs the CLI seeder on Windows and Unix against the database selected by `PG_URI`. It requires `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` (at least 8 characters), and creates or resets that admin account. It does not print the password. Legacy demo cleanup is disabled unless `SEED_DEMO_CLEANUP=true`; that flag removes specified legacy demo records and should only be used on an isolated demo database. The script has no environment allowlist, so operators must verify the target database before running it.

## Source entry points
- `src/routers/admin.router.js`
- `src/controllers/funding.controller.js`
- `src/controllers/admin.controller.js`
- `src/services/event.service.js`
- `db/models/event-action-request.model.js`
- `src/validators/user.validator.js`
- `scripts/seed-demo-data.js`

## Change coupling
Changes affect frontend admin dashboard/users/events. Permission changes require ROLES.md; lifecycle changes require events.md.
