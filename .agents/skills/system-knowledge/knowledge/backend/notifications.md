# Notifications and transactional email

## Current behavior
Notification stores recipient, title/message, type, optional frontend link, and read state. Authenticated users list, mark one/all read, and clear their own notifications.

NotificationService persists first, then optionally sends escaped HTML email if EMAIL_USER and EMAIL_PASS are configured. Delivery is asynchronous and failures are swallowed; persistence is not proof of email delivery. Event/application/referral/staff/payment workflows use this service. Auth verification/reset email is separate.

Settlement collection and usher payout state do not depend on notification persistence. A notification failure after a confirmed payment or payout does not mark the transfer failed or prevent remaining queued payouts.

Assigning an usher to a map pin creates a notification naming the location and event, with a link to `/talent/events/:id/map`. Re-saving an existing assignment does not repeat the notification.

Clearing notifications soft deletes them by setting `deletedAt`; cleared records disappear from lists and unread totals while remaining stored. User, staff, and organization deletion also soft delete their existing notifications.

## Source entry points
- `src/services/notification.service.js`
- `src/controllers/notification.controller.js`
- `src/routers/notification.router.js`
- `db/models/notification.model.js`
- `src/utils/email.js`
- `src/utils/htmlTemplate.js`
- `src/controllers/user.controller.js`

## Change coupling
Notification links must match frontend routes; read-state/payload changes affect Navbar and API normalization.
