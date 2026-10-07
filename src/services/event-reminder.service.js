import { Op } from 'sequelize';
import { sequelize } from '../../db/connection.js';
import { Event } from '../../db/models/event.model.js';
import { EventReminder } from '../../db/models/event-reminder.model.js';
import { User } from '../../db/models/user.model.js';
import { EmailService } from '../utils/email.js';
import { HtmlTemplateService } from '../utils/htmlTemplate.js';
import { dayStartsAt, eventDays, platformTimeZone } from '../utils/eventSchedule.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// The event day whose reminder is due at `now`: one that starts within the next 24 hours. Each day
// of a multi-day event gets its own reminder.
export const dueReminderDay = (event, now) => {
  if (!event || event.deletedAt || !['open', 'confirmed'].includes(event.status)) return null;
  const days = eventDays(event);
  for (const [dayIndex, day] of days.entries()) {
    const startsAt = dayStartsAt(day);
    if (startsAt && !Number.isNaN(startsAt.getTime()) && now < startsAt && now.getTime() >= startsAt.getTime() - DAY_MS) {
      return { dayIndex, dayCount: days.length, startsAt };
    }
  }
  return null;
};

export const reminderIsDue = (event, now) => Boolean(dueReminderDay(event, now));

export class EventReminderService {
  static async sendForUsher(eventId, userId, now = new Date()) {
    return sequelize.transaction(async (transaction) => {
      // Serialize concurrent cron deliveries and recheck current membership/status/schedule.
      const event = await Event.findByPk(eventId, { transaction, lock: transaction.LOCK.UPDATE });
      const due = dueReminderDay(event, now);
      if (!due || !event.hiredTalents?.includes(userId)) return false;
      const { startsAt } = due;
      const where = { eventId, userId, startsAt };
      if (await EventReminder.findOne({ where, transaction, paranoid: false })) return false;
      const user = await User.findByPk(userId, { attributes: ['email'], transaction });
      if (!user?.email) return false;

      const timeZone = platformTimeZone();
      const startLabel = new Intl.DateTimeFormat('en-GB', {
        timeZone, dateStyle: 'full', timeStyle: 'short',
      }).format(startsAt);
      const multiDay = due.dayCount > 1;
      const title = multiDay ? `Reminder: day ${due.dayIndex + 1} of ${event.title} starts soon` : `Reminder: ${event.title} starts soon`;
      const message = [
        multiDay
          ? `You are booked for ${event.title}. Day ${due.dayIndex + 1} of ${due.dayCount} starts within 24 hours. Check in again when you arrive.`
          : `You are booked for ${event.title}. Your event starts within 24 hours.`,
        `Start: ${startLabel} (${timeZone}).`,
        `Location: ${event.location}.`,
        event.gatheringLocation && `Meeting point: ${event.gatheringLocation}.`,
        event.dressCode && `Dress code: ${event.dressCode}.`,
        'Please review your event details and arrive on time.',
      ].filter(Boolean).join('\n');
      const link = `/talent/jobs/${event.id}`;
      // Await SMTP acceptance. Failed sends roll back and remain eligible for the next run.
      await EmailService.sendEmail({
        to: user.email,
        subject: title,
        html: HtmlTemplateService.notification({ title, message, type: 'info', link }),
        text: HtmlTemplateService.notificationText({ message, link }),
        timeoutMs: 10000,
      });
      await EventReminder.create({ ...where, sentAt: new Date() }, { transaction });
      return true;
    });
  }

  static async sweep(now = new Date()) {
    const result = { checked: 0, sent: 0, failures: [] };
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      return { ...result, skipped: 'email_not_configured' };
    }
    let afterId;
    // Calendar dates are UTC labels; widen the range for local timezone offsets, then check
    // the exact start instant. Keyset pagination avoids starving events beyond the first page.
    for (;;) {
      const events = await Event.findAll({
        attributes: ['id', 'hiredTalents'],
        where: {
          status: { [Op.in]: ['open', 'confirmed'] },
          // Events with a day in the window: from the first day until the last.
          eventDate: { [Op.lte]: new Date(now.getTime() + 2 * DAY_MS) },
          [Op.or]: [
            { endDate: { [Op.gte]: new Date(now.getTime() - DAY_MS) } },
            { endDate: null, eventDate: { [Op.gte]: new Date(now.getTime() - DAY_MS) } },
          ],
          ...(afterId ? { id: { [Op.gt]: afterId } } : {}),
        },
        order: [['id', 'ASC']], limit: 100,
      });
      if (!events.length) break;
      for (const event of events) {
        result.checked += 1;
        for (const userId of new Set(event.hiredTalents || [])) {
          try {
            if (await this.sendForUsher(event.id, userId, now)) result.sent += 1;
          } catch (error) {
            result.failures.push({ eventId: event.id, userId, message: error.message });
          }
        }
      }
      afterId = events.at(-1).id;
    }
    return result;
  }
}
