import { sequelize } from '../../db/connection.js';
import { Application, Attendance, Event, EventActionRequest, EventSettlement, Referral, Review } from '../../db/index.js';

export class EventService {
  static async deleteWithRelations(eventId, { transaction, preserveActionRequests = false } = {}) {
    if (!transaction) {
      return sequelize.transaction((transaction) => this.deleteWithRelations(eventId, { transaction, preserveActionRequests }));
    }
    const options = { transaction };
    const event = await Event.findByPk(eventId, { attributes: ['id'], lock: transaction.LOCK.UPDATE, ...options });
    if (!event) return 0;
    const relatedDeletes = [
      Attendance.destroy({ where: { eventId }, ...options }),
      Review.destroy({ where: { eventId }, ...options }),
      Referral.destroy({ where: { eventId }, ...options }),
      Application.destroy({ where: { eventId }, ...options }),
      // Keep payable lines available internally for an already-started checkout.
      EventSettlement.destroy({ where: { eventId }, ...options }),
    ];
    if (!preserveActionRequests) {
      relatedDeletes.push(EventActionRequest.destroy({ where: { eventId }, ...options }));
    }
    await Promise.all(relatedDeletes);
    return Event.destroy({ where: { id: eventId }, ...options });
  }
}
