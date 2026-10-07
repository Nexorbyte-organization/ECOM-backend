import { Notification, User } from '../../db/index.js';
import { EmailService } from '../utils/email.js';
import { HtmlTemplateService } from '../utils/htmlTemplate.js';

const EMAIL_WAIT_MS = 5000;

export class NotificationService {
  static async create({ userId, title, message, type = 'info', link = null, sendEmail = true }) {
    const notification = await Notification.create({ userId, title, message, type, link });

    if (sendEmail && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      const user = await User.findByPk(userId, { attributes: ['email'] });
      if (user?.email) {
        const delivery = EmailService.sendEmail({
          to: user.email,
          subject: title,
          html: HtmlTemplateService.notification({ title, message, type, link }),
          text: HtmlTemplateService.notificationText({ message, link }),
        }).catch(() => undefined);
        // Serverless functions can be frozen once the response is sent, which drops unawaited
        // email. There, wait briefly for delivery; elsewhere keep sending in the background.
        if (process.env.VERCEL) {
          await Promise.race([delivery, new Promise((resolve) => setTimeout(resolve, EMAIL_WAIT_MS))]);
        }
      }
    }

    return notification;
  }
}
