import { Op } from 'sequelize';
import {
  Attendance,
  Event,
  EventSettlement,
  OrganizerCreditEntry,
  SettlementLine,
  User,
} from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { evaluateTier, PAYABLE_ATTENDANCE, payAfterOverdueAt } from './funding-policy.js';

export class OrganizerCreditService {
  static async balance(organizerId, { transaction } = {}) {
    const total = await OrganizerCreditEntry.sum('amountCents', { where: { organizerId }, transaction });
    return Number(total || 0);
  }

  // Serializes credit spending for one organization. Additions do not need the lock because they
  // can only raise the balance; every debit takes it before checking the balance.
  static async lockOrganizer(organizerId, transaction) {
    const organizer = await User.findByPk(organizerId, { transaction, lock: transaction.LOCK.UPDATE, paranoid: false });
    if (!organizer) throw new AppError('Organization not found', 404);
    return organizer;
  }

  // Idempotent by reference: a repeated callback or request cannot credit or debit twice.
  static async addEntry({ organizerId, amountCents, type, reference, eventId = null, fundingId = null, note = null, createdBy = null }, { transaction } = {}) {
    if (!Number.isSafeInteger(amountCents) || amountCents === 0) return { entry: null, created: false };
    const [entry, created] = await OrganizerCreditEntry.findOrCreate({
      where: { reference },
      defaults: { organizerId, amountCents, type, eventId, fundingId, note, createdBy },
      transaction,
    });
    return { entry, created };
  }

  static async listEntries(organizerId, { limit = 50 } = {}) {
    return OrganizerCreditEntry.findAll({
      where: { organizerId },
      order: [['createdAt', 'DESC']],
      limit,
    });
  }

  // Events whose payments were completed: released prefunded events and pay-after events with a
  // paid checkout.
  static async paidEventsCount(organizerId) {
    const [released, paidSettlements] = await Promise.all([
      Event.findAll({ where: { organizerId, status: 'completed', fundsReleasedAt: { [Op.ne]: null } }, attributes: ['id'] }),
      EventSettlement.findAll({
        where: { organizerId, fundingSource: 'checkout', collectionStatus: 'paid' },
        attributes: ['eventId'],
      }),
    ]);
    return new Set([...released.map((event) => event.id), ...paidSettlements.map((item) => item.eventId)]).size;
  }

  // Pay-after events that ended long enough ago and still have a present usher without a paid line.
  static async overduePayAfterEvents(organizerId, now = new Date()) {
    const candidates = (await Event.findAll({
      where: { organizerId, status: 'completed', fundingMode: 'pay_after' },
      attributes: ['id', 'title', 'eventDate', 'startTime', 'endTime', 'hiredTalents'],
    })).filter((event) => {
      const overdueAt = payAfterOverdueAt(event);
      return overdueAt && now >= overdueAt;
    });
    if (!candidates.length) return [];
    const eventIds = candidates.map((event) => event.id);
    const [attendance, paidSettlements] = await Promise.all([
      Attendance.findAll({ where: { eventId: { [Op.in]: eventIds }, status: { [Op.in]: PAYABLE_ATTENDANCE } }, attributes: ['eventId', 'talentId'] }),
      EventSettlement.findAll({ where: { eventId: { [Op.in]: eventIds }, collectionStatus: 'paid' }, attributes: ['id'] }),
    ]);
    const paidLines = paidSettlements.length
      ? await SettlementLine.findAll({ where: { settlementId: { [Op.in]: paidSettlements.map((item) => item.id) } }, attributes: ['eventId', 'talentId'] })
      : [];
    const paidKeys = new Set(paidLines.map((line) => `${line.eventId}:${line.talentId}`));
    const hiredByEvent = new Map(candidates.map((event) => [event.id, new Set(event.hiredTalents || [])]));
    const overdueIds = new Set(attendance
      .filter((record) => hiredByEvent.get(record.eventId)?.has(record.talentId))
      .filter((record) => !paidKeys.has(`${record.eventId}:${record.talentId}`))
      .map((record) => record.eventId));
    return candidates.filter((event) => overdueIds.has(event.id));
  }

  static async evaluateOrganizerTier(organizerId) {
    const organizer = await User.findByPk(organizerId, { attributes: ['id', 'paymentTierOverride'], paranoid: false });
    if (!organizer) throw new AppError('Organization not found', 404);
    const [paidEventsCount, overdueEvents, creditBalanceCents] = await Promise.all([
      this.paidEventsCount(organizerId),
      this.overduePayAfterEvents(organizerId),
      this.balance(organizerId),
    ]);
    return {
      ...evaluateTier({
        override: organizer.paymentTierOverride,
        paidEventsCount,
        overdueEventsCount: overdueEvents.length,
        creditBalanceCents,
      }),
      overdueEvents: overdueEvents.map((event) => ({ _id: event.id, id: event.id, title: event.title })),
    };
  }
}
