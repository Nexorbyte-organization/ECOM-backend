import { Notification, User } from '../../db/index.js';
import { EmailService } from '../utils/email.js';

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

export class NotificationService {
  static async create({ userId, title, message, type = 'info', link = null, sendEmail = true }) {
    const notification = await Notification.create({ userId, title, message, type, link });

    if (sendEmail && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      const user = await User.findByPk(userId, { attributes: ['email'] });
      if (user?.email) {
        EmailService.sendEmail({
          to: user.email,
          subject: title,
          html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></div>`,
        }).catch(() => undefined);
      }
    }

    return notification;
  }
}
