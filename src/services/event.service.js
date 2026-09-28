import { Application, Attendance, Event, EventActionRequest, Referral, Review } from '../../db/index.js';
import { CloudinaryService } from '../utils/cloudinary.js';

export class EventService {
  static async deleteWithRelations(eventId, { transaction, preserveActionRequests = false } = {}) {
    const options = transaction ? { transaction } : {};
    const event = await Event.findByPk(eventId, { attributes: ['mapImage'], ...options });
    const relatedDeletes = [
      Attendance.destroy({ where: { eventId }, ...options }),
      Review.destroy({ where: { eventId }, ...options }),
      Referral.destroy({ where: { eventId }, ...options }),
      Application.destroy({ where: { eventId }, ...options }),
    ];
    if (!preserveActionRequests) {
      relatedDeletes.push(EventActionRequest.destroy({ where: { eventId }, ...options }));
    }
    await Promise.all(relatedDeletes);
    const deleted = await Event.destroy({ where: { id: eventId }, ...options });
    if (deleted && event?.mapImage?.public_id) {
      const removeMapImage = () => CloudinaryService.deleteImage(event.mapImage.public_id).catch(() => undefined);
      if (transaction) transaction.afterCommit(removeMapImage);
      else await removeMapImage();
    }
    return deleted;
  }
}
