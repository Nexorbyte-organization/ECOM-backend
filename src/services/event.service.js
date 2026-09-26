import { Application, Attendance, Event, EventActionRequest, Referral, Review } from '../../db/index.js';

export class EventService {
  static async deleteWithRelations(eventId, { transaction, preserveActionRequests = false } = {}) {
    const options = transaction ? { transaction } : {};
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
    return Event.destroy({ where: { id: eventId }, ...options });
  }
}
