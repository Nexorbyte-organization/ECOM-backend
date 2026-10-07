import { Op } from 'sequelize';
import { sequelize } from '../../db/connection.js';
import { Application, Attendance, Event, EventActionRequest, EventSettlement, Referral, Review } from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { NotificationService } from './notification.service.js';
import { FundingService } from './funding.service.js';

// Status changes an admin may make. Leaving `completed` is only possible while no payment
// has started, and `cancelled` is final.
export const EVENT_STATUS_TRANSITIONS = {
  open: ['confirmed', 'completed', 'cancelled'],
  confirmed: ['open', 'completed', 'cancelled'],
  completed: ['confirmed', 'cancelled'],
  cancelled: [],
};

export const canTransitionEvent = (from, to) => from === to || (EVENT_STATUS_TRANSITIONS[from] || []).includes(to);

export class EventService {
  static async deleteWithRelations(eventId, { transaction, preserveActionRequests = false } = {}) {
    if (!transaction) {
      return sequelize.transaction((transaction) => this.deleteWithRelations(eventId, { transaction, preserveActionRequests }));
    }
    const options = { transaction };
    const event = await Event.findByPk(eventId, { attributes: ['id'], lock: transaction.LOCK.UPDATE, ...options });
    if (!event) return 0;
    // Deleting would hide money the organization already paid; cancelling settles it first.
    if (await FundingService.heldFundsBlockDeletion(eventId, options)) {
      throw new AppError('This event holds advance funding. Cancel it first so the funding is refunded or paid out.', 409);
    }
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

  // Moves an event to a new status and applies the side effects of ending it. Returns the
  // event and the ushers to notify; callers send notifications after the transaction commits.
  static async changeStatus(eventId, status, { transaction, organizerId } = {}) {
    if (!transaction) {
      return sequelize.transaction((transaction) => this.changeStatus(eventId, status, { transaction, organizerId }));
    }
    const event = await Event.findOne({
      where: { id: eventId, ...(organizerId ? { organizerId } : {}) },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!event) throw new AppError('Event not found', 404);
    if (!canTransitionEvent(event.status, status)) {
      throw new AppError(`An event cannot move from ${event.status} to ${status}`, 409);
    }
    if (event.status === status) return { event, notifyUserIds: [], previousStatus: status };
    if (event.status === 'completed' && event.fundsReleasedAt) {
      throw new AppError('This event’s payments have been released, so it can no longer leave completed', 409);
    }
    if (event.status === 'completed') {
      const startedPayment = await EventSettlement.findOne({
        where: { eventId, collectionStatus: { [Op.ne]: 'failed' } },
        transaction,
      });
      if (startedPayment) {
        throw new AppError('Payment has already started for this event, so it can no longer leave completed', 409);
      }
    }

    const previousStatus = event.status;
    let notifyUserIds = [];
    if (status === 'cancelled' || status === 'completed') {
      // Pending applicants and anyone still on standby are released.
      const waiting = { eventId, status: { [Op.in]: ['pending', 'standby'] } };
      const pending = await Application.findAll({ where: waiting, transaction });
      if (pending.length) {
        await Application.update({ status: 'rejected' }, { where: waiting, transaction });
      }
      await Referral.update({ status: 'declined' }, { where: { eventId, status: 'pending' }, transaction });
      if (status === 'cancelled') {
        notifyUserIds = [...new Set([...(event.hiredTalents || []), ...pending.map((application) => application.talentId)])];
      }
    }
    event.status = status;
    // Splits advance funding between organization credit and usher compensation.
    const fundingResult = status === 'cancelled' ? await FundingService.settleCancellation(event, { transaction }) : null;
    await event.save({ transaction });
    return { event, notifyUserIds, previousStatus, fundingResult };
  }

  static async notifyCancellation(event, userIds, fundingResult = null) {
    await Promise.all(userIds.map((userId) => NotificationService.create({
      userId,
      title: 'Event cancelled',
      message: `“${event.title}” was cancelled. You no longer need to attend.`,
      type: 'danger',
      link: '/talent/events',
    }).catch(() => undefined)));
    await FundingService.afterCancellation(event, fundingResult);
  }
}
