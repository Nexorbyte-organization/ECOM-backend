import { Notification } from '../../db/index.js';
import { AppError } from '../utils/appError.js';

export class NotificationController {
  static async list(req, res) {
    const notifications = await Notification.findAll({
      where: { userId: req.authUser.id },
      order: [['createdAt', 'DESC']],
      limit: 100,
    });
    return res.status(200).json({ success: true, data: notifications });
  }

  static async markRead(req, res, next) {
    const notification = await Notification.findOne({
      where: { id: req.params.id, userId: req.authUser.id },
    });
    if (!notification) return next(new AppError('Notification not found', 404));
    notification.isRead = true;
    await notification.save();
    return res.status(200).json({ success: true, data: notification });
  }

  static async markAllRead(req, res) {
    await Notification.update(
      { isRead: true },
      { where: { userId: req.authUser.id, isRead: false } },
    );
    return res.status(200).json({ success: true, message: 'Notifications marked as read' });
  }

  static async clear(req, res) {
    await Notification.destroy({ where: { userId: req.authUser.id } });
    return res.status(200).json({ success: true, message: 'Notifications cleared' });
  }
}
