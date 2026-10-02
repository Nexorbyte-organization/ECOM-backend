import { Op } from 'sequelize';
import { sequelize } from '../../db/connection.js';
import { Event } from '../../db/models/event.model.js';
import { EventReminder } from '../../db/models/event-reminder.model.js';
import { User } from '../../db/models/user.model.js';
import { EmailService } from '../utils/email.js';
import { HtmlTemplateService } from '../utils/htmlTemplate.js';
import { eventStartsAt, platformTimeZone } from '../utils/eventSchedule.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const reminderIsDue = (event, now) => {
  if (!event || event.deletedAt || !['open', 'confirmed'].includes(event.status)) return false;
  const start = eventStartsAt(event);
  return Boolean(start && now < start && now.getTime() >= start.getTime() - DAY_MS);
};

export class EventReminderService {
  static async sendForUsher(eventId, userId, now = new Date()) {
    return sequelize.transaction(async (transaction) => {
      // Serialize concurrent cron deliveries and recheck current membership/status/schedule.
      const event = await Event.findByPk(eventId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!reminderIsDue(event, now) || !event.hiredTalents?.includes(userId)) return false;
      const startsAt = eventStartsAt(event);
      const where = { eventId, userId, startsAt };
      if (await EventReminder.findOne({ where, transaction, paranoid: false })) return false;
      const user = await User.findByPk(userId, { attributes: ['email'], transaction });
      if (!user?.email) return false;

      const timeZone = platformTimeZone();
      const startLabel = new Intl.DateTimeFormat('en-GB', {
        timeZone, dateStyle: 'full', timeStyle: 'short',
      }).format(startsAt);
      const title = `Reminder: ${event.title} starts soon`;
      const message = [
        `You are booked for ${event.title}. Your event starts within 24 hours.`,
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
          eventDate: { [Op.between]: [new Date(now.getTime() - DAY_MS), new Date(now.getTime() + 2 * DAY_MS)] },
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
