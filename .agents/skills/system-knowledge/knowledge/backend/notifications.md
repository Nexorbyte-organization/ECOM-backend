# Notifications and transactional email

## Current behavior
Notification stores recipient, title/message, type, optional frontend link, and read state. Authenticated users list, mark one/all read, and clear their own notifications.

NotificationService persists first, then optionally sends email if EMAIL_USER and EMAIL_PASS are configured. The email uses the same branded layout as the account emails (`HtmlTemplateService.notification`): the notification type picks the eyebrow, title and message are escaped, and a button opens the notification link on the first FRONTEND_URL origin. Links that are not app-relative open the app home page instead. A plain-text alternative carries the message and URL. Delivery is asynchronous and failures are swallowed, except on Vercel (`VERCEL` set), where the request waits up to 5 seconds for delivery because the function can be frozen after the response; persistence is not proof of email delivery. Event/application/referral/staff/payment workflows use this service. Auth verification/reset email is separate.

Settlement collection and usher payout state do not depend on notification persistence. A notification failure after a confirmed payment or payout does not mark the transfer failed or prevent remaining queued payouts.

Assigning an usher to a map pin creates a notification naming the location and event, with a link to `/talent/events/:id/map`. Re-saving an existing assignment does not repeat the notification.

Clearing notifications soft deletes them by setting `deletedAt`; cleared records disappear from lists and unread totals while remaining stored. User, staff, and organization deletion also soft delete their existing notifications.

The protected event reminder cron emails hired ushers when an open/confirmed event enters its final 24 hours before `eventStartsAt`, using `APP_TIMEZONE` (default Africa/Cairo). The five-minute schedule normally sends shortly after that threshold; missed runs, failed deliveries, and hires made inside the window are caught up before the event starts. Cancelled, completed, deleted, and already-started events are skipped, and current hired membership is checked again before sending. The branded email includes the local date/time, location, meeting point and dress code when present, and `/talent/jobs/:id`. This reminder sends email only and awaits SMTP acceptance; it does not use the notification service's background delivery.

`event_reminders` stores one successful delivery per event, usher, and start instant. An event row lock serializes overlapping deliveries; a changed date/time permits a new reminder for the new start instant. Clearing notifications does not reset delivery history. Failed sends remain retryable, and one recipient failure does not stop the sweep. SMTP and database commits are not atomic: a process failure after SMTP acceptance but before recording delivery can cause a duplicate on retry. Missing email configuration skips the sweep; missing/deleted recipients are skipped. New tables are created by the normal startup schema sync.

## Source entry points
- `src/services/notification.service.js`
- `src/controllers/notification.controller.js`
- `src/routers/notification.router.js`
- `db/models/notification.model.js`
- `src/utils/email.js`
- `src/utils/htmlTemplate.js`
- `src/services/event-reminder.service.js`
- `db/models/event-reminder.model.js`
- `src/controllers/user.controller.js`

## Change coupling
Notification links must match frontend routes; read-state/payload changes affect Navbar and API normalization.
